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
  runsInCloud,
  runsOn,
} from "@opnav/shared";
import type { Db, Sql } from "../db.ts";
import { HttpError } from "../errors.ts";
import { getNode, listTree, normaliseRemote, projectOf } from "./tree.ts";
import { checkoutFor, hasLocalModels, heldBack, loadBusy, loadRanking, markBusy, orderQueue, placeInApp, queuedRows, slotsView, turnBlocked, type Offer, type OfferedCheckout } from "./backlog.ts";

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
  /**
   * direct = on a machine; cloudroom = in Cloudroom's cloud, handed over by a machine that has Cloudroom;
   * claude-cloud = Claude in Claude's cloud, fired by a machine whose Claude Code routine is set up.
   */
  runner: Runner.optional(),
  /** Pin to a machine. */
  machineId: z.string().uuid().optional(),
  issueUrl: z.string().url().optional(),
  /** Land the work on the checkout's branch and push it (see JobSpec.push). */
  push: z.boolean().optional(),
  /** Wait in the backlog for its turn (see backlog.ts) instead of going to the front. */
  backlog: z.boolean().optional(),
  /** The app it counts under in the ranking; default the project's title. */
  app: z.string().trim().min(1).max(80).optional(),
  held: z.boolean().optional(),
  /** Start only after these succeed: a job's key or id, or a handoff brief's name. */
  after: z.array(z.string().trim().min(1)).optional(),
  /** It uses the machine's own local models (Ollama): one such job per machine at a time. */
  localModel: z.boolean().optional(),
  /** Run from a checkout on this branch. */
  branch: z.string().trim().min(1).optional(),
  /** A unique name (e.g. the handoff brief's), so adding it twice is refused. */
  key: z.string().trim().min(1).max(200).optional(),
  /** Backlog place: first in its app, or just before this item. Default last. */
  top: z.boolean().optional(),
  before: z.string().uuid().optional(),
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
  checkJobShape(provider, runner, location, j.localModel ?? false);
  const title = j.title ?? j.prompt.split("\n")[0]!.slice(0, 80);
  if (j.key) {
    const [dup] = await sql`select id, status from jobs where user_id = ${userId} and lower(key) = lower(${j.key})`;
    if (dup) throw new HttpError(409, `"${j.key}" is already in Opportunity Nav (job ${dup.id}, ${dup.status}).`);
  }
  return sql.begin(async (tx) => {
    const [job] = await tx`
      insert into jobs (user_id, project_id, title, prompt, provider, model, location, effort, runner, status, node_id, pinned, issue_url, created_by, needs, push,
                        backlog, app, held, after, local_model, branch, key, position, item_id)
      values (${userId}, ${project.id}, ${title}, ${j.prompt}, ${provider}, ${j.model ?? (provider === project.defaultProvider ? project.defaultModel : null) ?? null},
              ${location}, ${j.effort ?? null}, ${runner}, 'queued', ${j.machineId ?? null}, ${j.machineId != null}, ${j.issueUrl ?? null}, ${createdBy},
              ${tx.json(needs)}, ${j.push ?? false}, ${j.backlog ?? false}, ${j.app ?? null}, ${j.held ?? false}, ${tx.json(j.after ?? [])},
              ${j.localModel ?? false}, ${j.branch ?? null}, ${j.key ?? null}, 0, ${j.nodeId})
      returning *`;
    await tx`insert into turns (job_id, kind, status) values (${job!.id}, 'start', 'queued')`;
    if (j.backlog) await placeInApp(tx, userId, job!.id, { top: j.top, before: j.before ?? null });
    const [row] = await tx`select * from jobs where id = ${job!.id}`;
    return jobRow(row);
  }).catch((e) => {
    if (e?.code === "23505" && j.key) throw new HttpError(409, `"${j.key}" is already in Opportunity Nav.`);
    throw e;
  });
}

/** Refuse agent, runner, location and local-model combinations no machine can run. */
export function checkJobShape(provider: string, runner: string, location: string, localModel: boolean) {
  if (runner === "cloudroom") {
    if (!CLOUDROOM_PROVIDERS.has(provider)) throw new HttpError(400, `Cloudroom can run Claude, Codex or Antigravity, not ${provider}.`);
    if (location === "local") throw new HttpError(400, "Cloudroom runs in the cloud, so it can't use a local model.");
  }
  if (runner === "claude-cloud") {
    if (provider !== "claude") throw new HttpError(400, `Claude's cloud runs only Claude, not ${providerLabel(provider)}.`);
    if (location === "local") throw new HttpError(400, "Claude's cloud can't use a local model.");
  }
  if (localModel && runner !== "direct") throw new HttpError(400, "A job that uses the machine's local models has to run on the machine, not in a cloud.");
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

/** A jobs row (with its machine's name as `machine`), as the cards say it: model in plain words and where it runs. */
export const runsOnRow = (r: any, machine: string | null = r.machine ?? null) =>
  runsOn({ provider: r.provider, model: r.model, reportedModel: r.reported_model, runner: r.runner, machine });

export function jobRow(r: any) {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    title: r.title as string,
    prompt: r.prompt as string,
    provider: r.provider as string,
    model: r.model as string | null,
    /** The model the agent reported running, if it did. */
    reportedModel: (r.reported_model as string | null | undefined) ?? null,
    /** For the job's cards: its model in plain words and where it runs ("local on Studio", "cloud (Claude)"). */
    runsOn: runsOnRow(r),
    location: r.location as string,
    effort: r.effort as string | null,
    runner: (r.runner ?? "direct") as string,
    /** For a Cloudroom job: its Cloudroom thread, and the branch it pushes to. */
    cloudroom: r.runner === "cloudroom" ? { thread: (r.provider_session_id as string | null) ?? null, branch: `opnav/${String(r.id).slice(0, 8)}` } : null,
    /** For a Claude cloud job: its latest cloud session (claude.ai/code/<session>). Each turn pushes to claude/opnav-<job>-<turn>. */
    claudeCloud: r.runner === "claude-cloud" ? { session: (r.provider_session_id as string | null) ?? null } : null,
    status: r.status as string,
    machineId: r.node_id as string | null,
    /** The machine that has (or last had) it, by name. */
    machine: (r.machine as string | null | undefined) ?? null,
    needs: (r.needs ?? []) as string[],
    push: Boolean(r.push),
    /** Backlog: waits for its turn in the ranking (see backlog.ts). */
    backlog: Boolean(r.backlog),
    app: (r.app as string | null) ?? null,
    held: Boolean(r.held),
    after: (r.after ?? []) as string[],
    localModel: Boolean(r.local_model),
    branch: (r.branch as string | null) ?? null,
    key: (r.key as string | null) ?? null,
    lastProgress: r.last_progress as string | null,
    summary: r.summary as string | null,
    createdBy: r.created_by as string,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    finishedAt: r.finished_at as Date | null,
  };
}

/**
 * Hand out queued turns this machine can run, in the backlog's order (see
 * backlog.ts): right agent, a checkout of the project's repo (on the job's
 * branch, if it names one), what it needs, and nothing holding it back (held,
 * waiting on another item, the machine's local models busy, its branch being
 * pushed to by another job). Never more than the machine has free: its slots
 * minus the turns it holds live leases on, and what the helper asked for. Cloud
 * jobs have their own slots when the helper has them (cloud_capacity, asked for
 * with cloudMax): they don't take local slots, and a full cloud doesn't stop a
 * local job behind it. Claims for one person take turns
 * (an advisory lock), so two machines can't both start jobs the rules say
 * mustn't run together, and two claims can't fill the same slots.
 */
export async function claim(sql: Sql, userId: string, machineId: string, req: ClaimRequest): Promise<Turn[]> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`opnav-claim:${userId}`}))`;
    const [machine] = await tx<{ checkouts: OfferedCheckout[]; tools: string[]; capacity: number; job_limit: number | null; cloud_capacity: number | null; taking_jobs: boolean; providers: any[] }[]>`
      select checkouts, tools, capacity, job_limit, cloud_capacity, taking_jobs, providers from nodes where id = ${machineId} and user_id = ${userId} for update`;
    if (!machine) throw new HttpError(401, "Unknown machine; send a heartbeat first.");
    if (!machine.taking_jobs) return [];
    const [held] = await tx<{ running: number; running_cloud: number }[]>`select count(*)::int as running,
        (count(*) filter (where j.runner <> 'direct'))::int as running_cloud
      from turns t join jobs j on j.id = t.job_id
      where t.node_id = ${machineId} and t.status = 'running' and t.lease_expires_at > now()`;
    // Free slots in each pool: local, and cloud when the helper has cloud slots and asks for them (else cloud jobs share the local ones).
    const view = slotsView({ ...machine, ...held, cloud_capacity: req.cloudMax == null ? null : machine.cloud_capacity });
    const free = { local: Math.min(req.max, view.slots - view.running), cloud: view.cloudSlots == null ? 0 : Math.min(req.cloudMax!, view.cloudSlots - view.cloudRunning) };
    const poolOf = (runner: string): keyof typeof free => view.cloudSlots != null && runsInCloud(runner) ? "cloud" : "local";
    if (free.local <= 0 && free.cloud <= 0) return [];
    const offer: Offer = {
      id: machineId, providers: req.providers, cloudroomProviders: req.cloudroomProviders, claudeCloud: req.claudeCloud,
      claudeCloudRepos: req.claudeCloud ? (req.claudeCloudRepos ?? []).map(normaliseRemote) : [],
      tools: machine.tools ?? [], checkouts: machine.checkouts ?? [], localModels: hasLocalModels(machine.providers ?? []),
    };
    const rows = orderQueue(await queuedRows(tx, userId), await loadRanking(tx, userId));
    const busy = await loadBusy(tx, userId, rows.flatMap((r) => r.after));

    const turns: Turn[] = [];
    for (const r of rows) {
      if (free.local <= 0 && free.cloud <= 0) break;
      const pool = poolOf(r.runner);
      if (free[pool] <= 0) continue;
      if (heldBack(r, busy)) continue;
      const c = checkoutFor(r, offer);
      if ("why" in c) continue;
      if (turnBlocked(r, machineId, busy)) continue;
      // Take it only if it's still queued and not being cancelled. The job is locked first, as cancelJob locks it, so the two can't deadlock.
      const [still] = await tx`select id from jobs where id = ${r.id} and status = 'queued' and not cancel_requested for update`;
      if (!still) continue;
      const [t] = await tx`
        update turns set status = 'running', node_id = ${machineId}, lease_id = ${randomUUID()},
          lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS}), started_at = now()
        where id = ${r.turn_id!} and status = 'queued' returning lease_id, lease_expires_at`;
      if (!t) continue;
      free[pool]--;
      markBusy(r, machineId, busy);
      await tx`update jobs set status = 'running', node_id = ${machineId}, checkout_path = ${c.path}, checkout_branch = ${c.branch},
        attempts = attempts + 1, updated_at = now() where id = ${r.id}`;
      let answer: Turn["answer"];
      if (r.answer_id) {
        const [a] = await tx`select id, question_id, text from answers where id = ${r.answer_id}`;
        if (a) answer = { answerId: a.id, questionId: a.question_id, text: a.text };
      }
      turns.push({
        turnId: r.turn_id!,
        leaseId: t.lease_id,
        leaseExpiresAt: new Date(t.lease_expires_at).toISOString(),
        kind: r.kind,
        job: {
          id: r.id,
          projectId: r.project_id,
          title: r.title,
          prompt: r.prompt,
          provider: r.provider as ProviderId,
          model: r.model ?? undefined,
          location: r.location,
          runner: r.runner as Runner,
          effort: r.effort ?? undefined,
          checkoutPath: c.path,
          remote: r.repo_remote!,
          nodeId: machineId,
          issueUrl: r.issue_url ?? undefined,
          ...(r.push ? { push: true } : {}),
          ...(r.branch ? { branch: r.branch } : {}),
        },
        providerSessionId: r.kind === "continue" ? (r.provider_session_id ?? undefined) : undefined,
        answer,
      });
    }
    return turns;
  });
}

/**
 * The running turn this machine holds, locked, with the job's cancel flag read under the job's
 * lock (turn first, then job, the order event delivery uses). cancelJob locks the job too, so a
 * cancel and anything decided here (publishing, a final result) happen one after the other.
 */
async function runningTurn(db: Db, userId: string, machineId: string, jobId: string, leaseId: string) {
  const [t] = await db`
    select t.id, t.last_seq, t.publishing_at, j.project_id from turns t join jobs j on j.id = t.job_id
    where t.job_id = ${jobId} and j.user_id = ${userId} and t.status = 'running' and t.lease_id = ${leaseId} and t.node_id = ${machineId}
    for update of t`;
  if (!t) throw new HttpError(409, "This machine no longer holds that job. Stop the worker.");
  const [j] = await db`select cancel_requested from jobs where id = ${jobId} for update`;
  return { ...t, cancel_requested: !!j?.cancel_requested } as
    { id: string; last_seq: number; publishing_at: Date | null; cancel_requested: boolean; project_id: string };
}

export async function renewLease(sql: Sql, userId: string, machineId: string, jobId: string, leaseId: string) {
  return sql.begin(async (tx) => {
    const t = await runningTurn(tx, userId, machineId, jobId, leaseId);
    const [r] = await tx`update turns set lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS})
      where id = ${t.id} returning lease_expires_at`;
    return { leaseExpiresAt: new Date(r!.lease_expires_at).toISOString(), cancel: t.cancel_requested };
  });
}

/**
 * A turn asks before it pushes. A cancel accepted first wins: nothing is pushed and the turn ends
 * cancelled. Otherwise the turn is marked publishing, and from then on publishing wins: cancelJob
 * refuses to cancel it, so its push and its result stand. Asking again gives the same answer.
 */
export async function startPublishing(sql: Sql, userId: string, machineId: string, jobId: string, leaseId: string) {
  return sql.begin(async (tx) => {
    const t = await runningTurn(tx, userId, machineId, jobId, leaseId);
    if (t.cancel_requested) return { publish: false, cancel: true };
    await tx`update turns set publishing_at = coalesce(publishing_at, now()) where id = ${t.id}`;
    return { publish: true, cancel: false };
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
      const ended = await applyEvent(tx, userId, jobId, t.id, t.project_id, e, t.cancel_requested);
      if (ended) break; // nothing after a terminal event counts
    }
    await tx`update turns set last_seq = ${lastSeq} where id = ${t.id}`;
    return { lastSeq };
  });
}

/** Returns true when the event ended the turn. */
async function applyEvent(tx: Db, userId: string, jobId: string, turnId: string, projectId: string, e: JobEvent,
  cancelRequested: boolean): Promise<boolean> {
  const endTurn = (status: string) => tx`update turns set status = ${status}, ended_at = now(), lease_id = null where id = ${turnId}`;
  // A cancel the server accepted wins over however the turn ended: not a success, no question, no retry.
  // (A turn the server let publish can't have one: cancelJob refuses it from then on.)
  if (cancelRequested && (e.type === "result" || e.type === "needs_input" || e.type === "error")) {
    await endTurn("cancelled");
    await tx`update questions set status = 'dismissed' where job_id = ${jobId} and status = 'open'`;
    await tx`update jobs set status = 'cancelled', finished_at = now(), updated_at = now() where id = ${jobId}`;
    return true;
  }
  switch (e.type) {
    case "session":
      await tx`update jobs set provider_session_id = ${e.providerSessionId}, reported_model = coalesce(${e.model ?? null}, reported_model),
        updated_at = now() where id = ${jobId}`;
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
      // Once the server let its turn start publishing, publishing wins: the push and its result stand.
      const [publishing] = await tx`select 1 from turns where job_id = ${jobId} and status = 'running' and publishing_at is not null`;
      if (publishing) return { status: "publishing" };
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
