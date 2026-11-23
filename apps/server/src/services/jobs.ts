import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  type ClaimRequest,
  type JobEvent,
  type Turn,
  LEASE_SECONDS,
  LOCAL_MODEL_PROVIDERS,
  Location,
  MachineTool,
  ProviderId,
  Runner,
} from "@opnav/shared";
import type { Db, Sql } from "../db.ts";
import { HttpError } from "../errors.ts";
import { getNode, listTree, normaliseRemote, projectOf } from "./tree.ts";

export const MAX_ATTEMPTS = 3;

/** Our agents that Cloudroom's cloud can run. */
export const CLOUDROOM_PROVIDERS = new Set<string>(["claude", "codex", "agy"]);

export const NewJob = z.object({
  /** Any tree node; the job belongs to its nearest project. */
  nodeId: z.string().uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(1),
  provider: ProviderId.optional(),
  model: z.string().optional(),
  location: Location.optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  /** What it needs from the machine (Docker, a test database); default = the project's. */
  needs: z.array(MachineTool).optional(),
  /** direct = on a machine; cloudroom = in Cloudroom's cloud, handed over by a machine that has Cloudroom. */
  runner: Runner.optional(),
  /** Pin to a machine. */
  machineId: z.string().uuid().optional(),
  issueUrl: z.string().url().optional(),
});

export async function createJob(sql: Sql, userId: string, input: z.input<typeof NewJob>, createdBy: string) {
  const j = NewJob.parse(input);
  const tree = await listTree(sql, userId);
  const byId = new Map(tree.map((n) => [n.id, n]));
  await getNode(sql, userId, j.nodeId);
  const project = projectOf(byId, j.nodeId);
  if (!project) throw new HttpError(400, "Put this inside a project first, so the job knows which repo to work in.");
  if (!project.repoRemote) throw new HttpError(400, `"${project.title}" has no repo yet. Add its git remote first.`);
  const provider = j.provider ?? project.defaultProvider;
  if (!provider) throw new HttpError(400, "Pick an agent for this job, or set a default on the project.");
  const location = jobLocation(provider, j.location, project.defaultLocation);
  const needs = [...new Set(j.needs ?? project.defaultNeeds ?? [])];
  const runner = j.runner ?? "direct";
  if (runner === "cloudroom") {
    if (!CLOUDROOM_PROVIDERS.has(provider)) throw new HttpError(400, `Cloudroom can run Claude, Codex or Antigravity, not ${provider}.`);
    if (location === "local") throw new HttpError(400, "Cloudroom runs in the cloud, so it can't use a local model.");
  }
  const title = j.title ?? j.prompt.split("\n")[0]!.slice(0, 80);
  return sql.begin(async (tx) => {
    const [job] = await tx`
      insert into jobs (user_id, project_id, title, prompt, provider, model, location, effort, runner, status, node_id, pinned, issue_url, created_by, needs)
      values (${userId}, ${project.id}, ${title}, ${j.prompt}, ${provider}, ${j.model ?? (provider === project.defaultProvider ? project.defaultModel : null) ?? null},
              ${location}, ${j.effort ?? null}, ${runner}, 'queued', ${j.machineId ?? null}, ${j.machineId != null}, ${j.issueUrl ?? null}, ${createdBy},
              ${tx.json(needs)})
      returning *`;
    await tx`insert into turns (job_id, kind, status) values (${job!.id}, 'start', 'queued')`;
    return jobRow(job);
  });
}

/**
 * Where the model runs. Only local-model providers (Ollama, MLX) run "local";
 * the rest are cloud only. Agents sometimes send "local" meaning "on my
 * machine", which no worker can run, so say so instead of queueing a job that
 * fails. A project default that doesn't fit the agent is ignored.
 */
export function jobLocation(provider: string, asked: Location | undefined, projectDefault: Location | null | undefined): Location {
  const localModels = LOCAL_MODEL_PROVIDERS.includes(provider as ProviderId);
  const fits = (l: Location | null | undefined) => l === "local" ? localModels : l === "cloud";
  if (asked) {
    if (!fits(asked) && !localModels) {
      throw new HttpError(400, `${providerLabel(provider)} runs its models in the cloud, so its location is "cloud". To choose the machine, pin the job to it.`);
    }
    return asked;
  }
  if (fits(projectDefault)) return projectDefault!;
  return localModels ? "local" : "cloud";
}

const PROVIDER_LABELS: Record<string, string> = { claude: "Claude", codex: "Codex", agy: "Antigravity", gemini: "Gemini", cursor: "Cursor", grokbot: "Grok Bot", grok: "Grok" };
const providerLabel = (p: string) => PROVIDER_LABELS[p] ?? p;

export function jobRow(r: any) {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    title: r.title as string,
    prompt: r.prompt as string,
    provider: r.provider as string,
    model: r.model as string | null,
    location: r.location as string,
    effort: r.effort as string | null,
    runner: (r.runner ?? "direct") as string,
    /** For a Cloudroom job: its Cloudroom thread, and the branch it pushes to. */
    cloudroom: r.runner === "cloudroom" ? { thread: (r.provider_session_id as string | null) ?? null, branch: `opnav/${String(r.id).slice(0, 8)}` } : null,
    status: r.status as string,
    machineId: r.node_id as string | null,
    /** The machine that has (or last had) it, by name. */
    machine: (r.machine as string | null | undefined) ?? null,
    needs: (r.needs ?? []) as string[],
    lastProgress: r.last_progress as string | null,
    summary: r.summary as string | null,
    createdBy: r.created_by as string,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    finishedAt: r.finished_at as Date | null,
  };
}

/** Hand out queued turns this machine can run: right provider, and a checkout of the project's repo. */
export async function claim(sql: Sql, userId: string, machineId: string, req: ClaimRequest): Promise<Turn[]> {
  const [machine] = await sql<{ checkouts: { path: string; remote?: string }[]; tools: string[] }[]>`
    select checkouts, tools from nodes where id = ${machineId} and user_id = ${userId}`;
  if (!machine) throw new HttpError(401, "Unknown machine; send a heartbeat first.");
  const checkoutFor = new Map<string, string>();
  for (const c of machine.checkouts ?? []) if (c.remote && !checkoutFor.has(normaliseRemote(c.remote))) checkoutFor.set(normaliseRemote(c.remote), c.path);
  const remotes = [...checkoutFor.keys()];
  if (remotes.length === 0) return [];

  return sql.begin(async (tx) => {
    const rows = await tx`
      select t.id as turn_id, t.kind, t.answer_id, j.*, p.repo_remote
      from turns t join jobs j on j.id = t.job_id join tree_nodes p on p.id = j.project_id
      where t.status = 'queued' and j.user_id = ${userId} and j.status = 'queued' and not j.cancel_requested
        and ((j.runner = 'direct' and j.provider in ${tx(req.providers.length ? req.providers : ["-"])})
          or (j.runner = 'cloudroom' and j.provider in ${tx(req.cloudroomProviders.length ? req.cloudroomProviders : ["-"])}))
        and p.repo_remote in ${tx(remotes)}
        and (j.node_id is null or j.node_id = ${machineId})
        and (j.runner = 'cloudroom' or j.needs <@ ${tx.json(machine.tools ?? [])}::jsonb)
      order by t.created_at
      limit ${req.max}
      for update of t, j skip locked`;
    const turns: Turn[] = [];
    for (const r of rows) {
      const leaseId = randomUUID();
      const checkoutPath = r.kind === "continue" && r.checkout_path ? r.checkout_path : checkoutFor.get(r.repo_remote)!;
      const [t] = await tx`
        update turns set status = 'running', node_id = ${machineId}, lease_id = ${leaseId},
          lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS}), started_at = now()
        where id = ${r.turn_id} returning lease_expires_at`;
      await tx`update jobs set status = 'running', node_id = ${machineId}, checkout_path = ${checkoutPath},
        attempts = attempts + 1, updated_at = now() where id = ${r.id}`;
      let answer: Turn["answer"];
      if (r.answer_id) {
        const [a] = await tx`select id, question_id, text from answers where id = ${r.answer_id}`;
        if (a) answer = { answerId: a.id, questionId: a.question_id, text: a.text };
      }
      turns.push({
        turnId: r.turn_id,
        leaseId,
        leaseExpiresAt: new Date(t!.lease_expires_at).toISOString(),
        kind: r.kind,
        job: {
          id: r.id,
          projectId: r.project_id,
          title: r.title,
          prompt: r.prompt,
          provider: r.provider,
          model: r.model ?? undefined,
          location: r.location,
          runner: r.runner,
          effort: r.effort ?? undefined,
          checkoutPath,
          nodeId: machineId,
          issueUrl: r.issue_url ?? undefined,
        },
        providerSessionId: r.kind === "continue" ? (r.provider_session_id ?? undefined) : undefined,
        answer,
      });
    }
    return turns;
  });
}

async function runningTurn(db: Db, userId: string, machineId: string, jobId: string, leaseId: string) {
  const [t] = await db`
    select t.id, t.last_seq, j.cancel_requested, j.project_id from turns t join jobs j on j.id = t.job_id
    where t.job_id = ${jobId} and j.user_id = ${userId} and t.status = 'running' and t.lease_id = ${leaseId} and t.node_id = ${machineId}
    for update of t`;
  if (!t) throw new HttpError(409, "This machine no longer holds that job. Stop the worker.");
  return t as { id: string; last_seq: number; cancel_requested: boolean; project_id: string };
}

export async function renewLease(sql: Sql, userId: string, machineId: string, jobId: string, leaseId: string) {
  return sql.begin(async (tx) => {
    const t = await runningTurn(tx, userId, machineId, jobId, leaseId);
    const [r] = await tx`update turns set lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS})
      where id = ${t.id} returning lease_expires_at`;
    return { leaseExpiresAt: new Date(r!.lease_expires_at).toISOString(), cancel: t.cancel_requested };
  });
}

export async function recordEvents(sql: Sql, userId: string, machineId: string, jobId: string, leaseId: string, events: JobEvent[]) {
  return sql.begin(async (tx) => {
    const t = await runningTurn(tx, userId, machineId, jobId, leaseId);
    let lastSeq = t.last_seq;
    for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
      if (e.seq <= lastSeq) continue; // already have it (retry)
      const { seq, at, type, ...payload } = e;
      await tx`insert into job_events (turn_id, seq, job_id, type, payload, at)
        values (${t.id}, ${seq}, ${jobId}, ${type}, ${tx.json(payload as any)}, ${at}) on conflict do nothing`;
      lastSeq = seq;
      const ended = await applyEvent(tx, userId, jobId, t.id, t.project_id, e);
      if (ended) break; // nothing after a terminal event counts
    }
    await tx`update turns set last_seq = ${lastSeq} where id = ${t.id}`;
    return { lastSeq };
  });
}

/** Returns true when the event ended the turn. */
async function applyEvent(tx: Db, userId: string, jobId: string, turnId: string, projectId: string, e: JobEvent): Promise<boolean> {
  const endTurn = (status: string) => tx`update turns set status = ${status}, ended_at = now(), lease_id = null where id = ${turnId}`;
  switch (e.type) {
    case "session":
      await tx`update jobs set provider_session_id = ${e.providerSessionId}, updated_at = now() where id = ${jobId}`;
      return false;
    case "progress":
      await tx`update jobs set last_progress = ${e.text.slice(0, 500)}, updated_at = now() where id = ${jobId}`;
      return false;
    case "blocked":
      // Logged on the job (job_events) only. The agent often finishes another way;
      // it becomes a roadblock only if the job then fails.
      return false;
    case "usage":
      await tx`update jobs set input_tokens = input_tokens + ${e.inputTokens ?? 0}, output_tokens = output_tokens + ${e.outputTokens ?? 0},
        cost_usd = cost_usd + ${e.costUsd ?? 0} where id = ${jobId}`;
      return false;
    case "needs_input":
      await endTurn("done");
      await tx`update jobs set status = 'waiting', updated_at = now() where id = ${jobId}`;
      await tx`insert into questions (user_id, project_id, job_id, body, options, context)
        values (${userId}, ${projectId}, ${jobId}, ${e.needsInput.question}, ${e.needsInput.options ? tx.json(e.needsInput.options) : null}, ${e.needsInput.context ?? null})`;
      return true;
    case "result":
      await endTurn("done");
      await tx`update jobs set status = 'succeeded', summary = ${e.summary}, finished_at = now(), updated_at = now() where id = ${jobId}`;
      // A job that succeeded needs nothing from the person.
      await tx`update roadblocks set status = 'cleared', cleared_at = now() where job_id = ${jobId} and status = 'open'`;
      return true;
    case "error": {
      const [job] = await tx<{ attempts: number }[]>`select attempts from jobs where id = ${jobId}`;
      if (e.code === "cancelled") {
        await endTurn("cancelled");
        await tx`update jobs set status = 'cancelled', finished_at = now(), updated_at = now() where id = ${jobId}`;
      } else if (e.retryable && (job?.attempts ?? 0) < MAX_ATTEMPTS) {
        await endTurn("expired");
        await requeue(tx, jobId, turnId);
      } else {
        await endTurn("done");
        await tx`update jobs set status = 'failed', summary = ${e.message}, finished_at = now(), updated_at = now() where id = ${jobId}`;
        const denied = await tx<{ text: string }[]>`select distinct payload->>'text' as text from job_events
          where turn_id = ${turnId} and type = 'blocked' and payload->>'text' is not null`;
        await tx`insert into roadblocks (user_id, project_id, job_id, body)
          values (${userId}, ${projectId}, ${jobId}, ${roadblockText(e.code, e.message, denied.map((d) => d.text))})`;
      }
      return true;
    }
  }
}

function roadblockText(code: string, message: string, denied: string[] = []) {
  const why = code === "auth_required" ? `The agent needs you to sign in again.\n${message}`
    : code === "rate_limited" ? `The agent hit its usage limit.\n${message}`
    : message;
  return [why, ...denied].join("\n");
}

/** Queue the same turn again (after a lost lease or a retryable error), keeping its kind and answer. */
async function requeue(tx: Db, jobId: string, fromTurnId: string) {
  const [old] = await tx`select kind, answer_id from turns where id = ${fromTurnId}`;
  await tx`insert into turns (job_id, kind, status, answer_id) values (${jobId}, ${old!.kind}, 'queued', ${old!.answer_id})`;
  // A fresh start can go to any machine unless the person pinned one; a continue must resume where its session lives.
  await tx`update jobs set status = 'queued', updated_at = now(),
    node_id = case when ${old!.kind} = 'start' and not pinned then null else node_id end where id = ${jobId}`;
}

/** Leases that ran out: requeue, or fail after MAX_ATTEMPTS. Run on a timer. */
export async function expireLeases(sql: Sql): Promise<number> {
  return sql.begin(async (tx) => {
    const stale = await tx`
      select t.id, t.job_id, j.attempts, j.user_id, j.project_id, j.cancel_requested from turns t join jobs j on j.id = t.job_id
      where t.status = 'running' and t.lease_expires_at < now() for update of t skip locked`;
    for (const t of stale) {
      await tx`update turns set status = 'expired', ended_at = now(), lease_id = null where id = ${t.id}`;
      if (t.cancel_requested) {
        await tx`update jobs set status = 'cancelled', finished_at = now(), updated_at = now() where id = ${t.job_id}`;
      } else if (t.attempts < MAX_ATTEMPTS) {
        await requeue(tx, t.job_id, t.id);
      } else {
        await tx`update jobs set status = 'failed', summary = 'The machine running it stopped answering.', finished_at = now(), updated_at = now() where id = ${t.job_id}`;
        await tx`insert into roadblocks (user_id, project_id, job_id, body)
          values (${t.user_id}, ${t.project_id}, ${t.job_id}, 'The machine running this job stopped answering, three times.')`;
      }
    }
    return stale.length;
  });
}

export async function cancelJob(sql: Sql, userId: string, jobId: string) {
  return sql.begin(async (tx) => {
    const [job] = await tx`select status from jobs where id = ${jobId} and user_id = ${userId} for update`;
    if (!job) throw new HttpError(404, "No such job.");
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return { status: job.status as string };
    if (job.status === "running") {
      await tx`update jobs set cancel_requested = true, updated_at = now() where id = ${jobId}`;
      return { status: "cancelling" };
    }
    await tx`update turns set status = 'cancelled', ended_at = now() where job_id = ${jobId} and status = 'queued'`;
    await tx`update questions set status = 'dismissed' where job_id = ${jobId} and status = 'open'`;
    await tx`update jobs set status = 'cancelled', finished_at = now(), updated_at = now() where id = ${jobId}`;
    return { status: "cancelled" };
  });
}

/**
 * Answer a question. Idempotent: answering twice returns the first answer and
 * never queues a second continuation. A job question queues a continue turn
 * pinned to the machine and checkout that asked.
 */
export async function answerQuestion(sql: Sql, userId: string, questionId: string, text: string, by: string) {
  return sql.begin(async (tx) => {
    const [q] = await tx`select * from questions where id = ${questionId} and user_id = ${userId} for update`;
    if (!q) throw new HttpError(404, "No such question.");
    const [existing] = await tx`select id, text from answers where question_id = ${questionId}`;
    if (existing) return { answerId: existing.id as string, alreadyAnswered: true };
    const [a] = await tx`insert into answers (question_id, text, created_by) values (${questionId}, ${text}, ${by}) returning id`;
    await tx`update questions set status = 'answered', answered_at = now() where id = ${questionId}`;
    if (q.job_id) {
      const [job] = await tx`select status from jobs where id = ${q.job_id} for update`;
      if (job?.status === "waiting") {
        await tx`insert into turns (job_id, kind, status, answer_id) values (${q.job_id}, 'continue', 'queued', ${a!.id})`;
        await tx`update jobs set status = 'queued', updated_at = now() where id = ${q.job_id}`;
      }
    }
    return { answerId: a!.id as string, alreadyAnswered: false };
  });
}

export async function getJob(db: Db, userId: string, jobId: string) {
  const [job] = await db`select j.*, n.name as machine from jobs j left join nodes n on n.id = j.node_id
    where j.id = ${jobId} and j.user_id = ${userId}`;
  if (!job) throw new HttpError(404, "No such job.");
  const events = await db`select type, payload, at from job_events where job_id = ${jobId} order by at, seq`;
  const questions = await db`select q.*, a.text as answer from questions q left join answers a on a.question_id = q.id
    where q.job_id = ${jobId} order by q.created_at`;
  return {
    ...jobRow(job),
    tokens: { input: Number(job.input_tokens), output: Number(job.output_tokens) },
    costUsd: Number(job.cost_usd),
    events: events.map((e) => ({ type: e.type, at: e.at, ...e.payload })),
    questions: questions.map((q) => ({ id: q.id, body: q.body, status: q.status, answer: q.answer })),
  };
}
