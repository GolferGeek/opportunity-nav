import { z } from "zod";
import { Location, MachineTool, ProviderId, Runner } from "@opnav/shared";
import type { Sql } from "../db.ts";
import { HttpError } from "../errors.ts";
import { answerQuestion, cancelJob, createJob, getJob } from "./jobs.ts";
import { createNode, listTree, normaliseRemote, pathOf, projectOf, TreeNodePatch, updateNode, type TreeNode } from "./tree.ts";
import { DEFAULT_REVIEWERS, pickReviewer } from "./reviewer.ts";
import { listMachines, setJobLimit, setTakingJobs } from "./machines.ts";
import { BacklogFields, Effort, linedUp, setAppRanking, updateBacklogItem } from "./backlog.ts";
import { dashboard, happening } from "./views.ts";
import { messageGrokBot } from "./outbound.ts";

/**
 * Everything an agent can do, in one place. A2A skills and MCP tools are thin
 * wrappers over these, so both doors behave the same. Items can be named by id
 * or by a title path like "Golfer Geek / Opportunity Nav" (case-insensitive),
 * which is what a voice or chat request naturally gives.
 */

/** A machine by name, case-insensitive. A reinstalled machine can have older records with the same name; the one seen last wins. */
export async function machineByName(sql: Sql, userId: string, name: string): Promise<string> {
  const [m] = await sql<{ id: string }[]>`select n.id from nodes n join api_tokens t on t.id = n.token_id
    where n.user_id = ${userId} and t.revoked_at is null and (lower(n.name) = lower(${name.trim()}) or n.id::text = ${name.trim()})
    order by n.last_seen_at desc limit 1`;
  if (!m) throw new HttpError(404, `No machine is called "${name}".`);
  return m.id;
}

const Ref = z.string().min(1).describe('Item id, or a title path like "Golfer Geek / Opportunity Nav"');

export async function resolveRef(sql: Sql, userId: string, ref: string): Promise<TreeNode> {
  const tree = await listTree(sql, userId);
  const byId = new Map(tree.map((n) => [n.id, n]));
  if (byId.has(ref)) return byId.get(ref)!;
  const want = ref.split("/").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const matches = tree.filter((n) => {
    const p = pathOf(byId, n.id).map((s) => s.toLowerCase());
    return p.length >= want.length && want.every((w, i) => p[p.length - want.length + i] === w);
  });
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new HttpError(404, `Nothing in the tree is called "${ref}".`);
  throw new HttpError(409, `"${ref}" matches ${matches.length} items: ${matches.map((m) => pathOf(byId, m.id).join(" / ")).join("; ")}. Say which.`);
}

/** The project whose git remote is this one (any spelling: SSH, HTTPS, with or without .git). */
export async function projectByRemote(sql: Sql, userId: string, remote: string): Promise<TreeNode> {
  const want = normaliseRemote(remote);
  const matches = (await listTree(sql, userId)).filter((n) => n.kind === "project" && n.repoRemote === want);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new HttpError(404, `No project has the repo ${want}. Add it to a project first.`);
  throw new HttpError(409, `${matches.length} projects have the repo ${want}: ${matches.map((m) => m.title).join("; ")}. Name the item instead.`);
}

export const actions = {
  get_overview: {
    description: "What's happening now (jobs, questions for the person, roadblocks) and subscription usage, grouped by project in priority order.",
    input: z.object({ scope: Ref.optional() }),
    run: async (sql: Sql, userId: string, i: { scope?: string }) => {
      const scopeId = i.scope ? (await resolveRef(sql, userId, i.scope)).id : undefined;
      const [h, d] = await Promise.all([happening(sql, userId, scopeId), dashboard(sql, userId)]);
      return { happening: h, subscriptions: d.subscriptions, projects: d.projects };
    },
  },
  get_tree: {
    description: "The person's whole tree of areas, projects and items, in priority order.",
    input: z.object({}),
    run: async (sql: Sql, userId: string) => {
      const tree = await listTree(sql, userId);
      const byId = new Map(tree.map((n) => [n.id, n]));
      return tree.map((n) => ({ id: n.id, kind: n.kind, path: pathOf(byId, n.id).join(" / "), favorite: n.favorite, priority: n.priority, repo: n.repoRemote, status: n.statusLine }));
    },
  },
  add_item: {
    description: "Add an area, project or item to the tree.",
    input: z.object({
      parent: Ref.optional().describe("Where to add it. Omit for the top level."),
      kind: z.enum(["area", "project", "item"]),
      title: z.string().min(1),
      notes: z.string().optional(),
      repo: z.string().optional().describe("Git remote, for projects"),
      defaultProvider: ProviderId.optional(),
      defaultModel: z.string().optional(),
    }),
    run: async (sql: Sql, userId: string, i: any) => {
      const parentId = i.parent ? (await resolveRef(sql, userId, i.parent)).id : null;
      return createNode(sql, userId, {
        parentId, kind: i.kind, title: i.title, notes: i.notes, repoRemote: i.repo, defaultProvider: i.defaultProvider, defaultModel: i.defaultModel,
      });
    },
  },
  update_item: {
    description: "Change an item: rename, move, favorite, set its priority (high, medium, low), its repo, defaults, or one-line status.",
    input: z.object({ item: Ref, changes: TreeNodePatch.omit({ parentId: true }).extend({ moveUnder: Ref.nullable().optional() }) }),
    run: async (sql: Sql, userId: string, i: any) => {
      const node = await resolveRef(sql, userId, i.item);
      const { moveUnder, ...changes } = i.changes;
      if (moveUnder !== undefined) changes.parentId = moveUnder === null ? null : (await resolveRef(sql, userId, moveUnder)).id;
      return updateNode(sql, userId, node.id, changes);
    },
  },
  list_machines: {
    description: "The person's machines: which are online, which agents each can run jobs with, what else it has (docker, database), and whether it can hand jobs to Cloudroom's cloud or Claude's cloud.",
    input: z.object({}),
    run: async (sql: Sql, userId: string) => {
      const seen = new Set<string>();
      return (await listMachines(sql, userId))
        .filter((m) => !m.revoked)
        .sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime())
        .filter((m) => !seen.has(m.name.toLowerCase()) && seen.add(m.name.toLowerCase()))
        .map((m) => ({
          name: m.name, online: m.online, lastSeenAt: m.lastSeenAt, helperVersion: m.helperVersion,
          runsJobsWith: (m.providers as any[]).filter((p) => p.canRunJobs && p.signedIn).map((p) => p.provider),
          tools: m.tools, cloudroom: m.cloudroom?.providers ?? [],
          jobs: { atOnce: m.capacity, running: m.running, takingJobs: m.takingJobs },
          claudeCloud: m.claudeCloud?.ready ? "ready" : m.claudeCloud?.reason ?? "not set up",
        }));
    },
  },
  answer_question: {
    description: "Answer a question an agent asked the person. The job resumes where it stopped.",
    input: z.object({ questionId: z.string().uuid(), answer: z.string().min(1) }),
    run: (sql: Sql, userId: string, i: any, by: string) => answerQuestion(sql, userId, i.questionId, i.answer, by),
  },
  start_job: {
    description: "Start an agent on a task in a project. Provider, model and location default to the project's settings. Any online machine with the agent and the repo picks it up; set machine to choose one, and needs if it must have Docker or a test database. Name the project by item, or by repo (its git remote). Set push to land the work on the branch the machine's checkout is on and push it; otherwise it stays on the job's own branch, unpushed. Set runner \"cloudroom\" to run it in a Cloudroom cloud sandbox (Claude, Codex or Antigravity; it starts from the repo's default branch on GitHub and pushes its work to a branch). Set runner \"claude-cloud\" to run Claude in Claude's own cloud through the person's Claude Code routine (only on a machine where list_machines says claudeCloud is ready; it starts from the checkout's branch on origin, can take up to 45 minutes, and is tried once more if nothing comes back).",
    input: z.object({
      item: Ref.optional().describe("The project (or an item inside it) to work on. Or give repo instead."),
      repo: z.string().min(1).optional().describe("The project's git remote, e.g. github.com/owner/name, when item isn't given"),
      prompt: z.string().min(1),
      title: z.string().optional(),
      provider: ProviderId.optional(),
      model: z.string().optional(),
      location: Location.optional().describe("Where the model runs: cloud for Claude, Codex and Antigravity; local only for Ollama or MLX models. Not which machine; use machine for that."),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      runner: Runner.optional().describe("direct (default): on one of the person's machines. cloudroom: in Cloudroom's cloud. claude-cloud: Claude in Claude's cloud, through a routine."),
      machine: z.string().optional().describe("Run it on this machine (its name, e.g. the one list_machines shows). Default: any machine that can."),
      needs: z.array(MachineTool).optional().describe("What the machine must have: docker, database (a local Postgres for tests). Default: the project's."),
      push: z.boolean().optional().describe("Land the work on the checkout's branch (e.g. main) and push it. Default false: commit on the job's branch, never push."),
    }),
    run: async (sql: Sql, userId: string, i: any, by: string) => {
      if (!i.item && !i.repo) throw new HttpError(400, "Name the project: item or repo.");
      const node = i.item ? await resolveRef(sql, userId, i.item) : await projectByRemote(sql, userId, i.repo);
      const { machine, item: _item, repo: _repo, ...job } = i;
      const machineId = machine ? await machineByName(sql, userId, machine) : undefined;
      return createJob(sql, userId, { ...job, nodeId: node.id, machineId }, by);
    },
  },
  start_review: {
    description: "Start a review job in a project, and let the agent be picked: of Antigravity and Codex (or the agents in among), the one with more subscription usage left goes, as long as a machine with a free slot can run it now; otherwise the other one. Usage readings that aren't current rank below current ones; Antigravity with no reading for its default model counts as half left. The reply says which was picked and why. Otherwise like start_job.",
    input: z.object({
      item: Ref.describe("The project (or an item inside it) to review"),
      prompt: z.string().min(1).describe("What to review and what to do with what it finds"),
      title: z.string().optional(),
      among: z.array(ProviderId).min(1).optional().describe("Agents to pick from, in order of preference on a tie. Default: agy, codex."),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      machine: z.string().optional().describe("Run it on this machine. Default: any machine that can."),
      needs: z.array(MachineTool).optional().describe("What the machine must have: docker, database. Default: the project's."),
    }),
    run: async (sql: Sql, userId: string, i: any, by: string) => {
      const node = await resolveRef(sql, userId, i.item);
      const tree = await listTree(sql, userId);
      const project = projectOf(new Map(tree.map((n) => [n.id, n])), node.id);
      if (!project?.repoRemote) throw new HttpError(400, "Put this inside a project with a repo first, so the review knows which repo to read.");
      const machineId = i.machine ? await machineByName(sql, userId, i.machine) : undefined;
      const needs = [...new Set<string>(i.needs ?? project.defaultNeeds ?? [])];
      const among = [...new Set<string>(i.among ?? DEFAULT_REVIEWERS)];
      const picked = await pickReviewer(sql, userId, among, { remote: project.repoRemote, needs, machineId });
      const job = await createJob(sql, userId, {
        nodeId: node.id, prompt: i.prompt, title: i.title, provider: picked.provider as any, effort: i.effort, needs: needs as any, machineId: picked.machineId,
      }, by);
      return { ...job, picked };
    },
  },
  add_to_backlog: {
    description: "Add a job to the backlog. It waits its turn and starts by itself when a machine with room can run it: in the app ranking's order (set_app_ranking), then its place inside its app. It never starts while held, while an item in after hasn't succeeded, while another local-model job runs on that machine (localModel), or while another pushing job runs for the same repo and branch. Name the project by item or repo. app is what it counts under in the ranking (default: the project's title). Agent, model and machine as in start_job (machine omitted: any machine that can). key is a unique name, e.g. a handoff brief's, so it can't be added twice; after can name keys, job ids or handoff brief names. Default place: last in its app; top puts it first, before puts it just before another waiting item.",
    input: z.object({
      item: Ref.optional().describe("The project (or an item inside it). Or give repo instead."),
      repo: z.string().min(1).optional().describe("The project's git remote, when item isn't given"),
      prompt: z.string().min(1),
      title: z.string().optional(),
      app: z.string().min(1).max(80).optional().describe('What it counts under in the app ranking, e.g. "Legal". Default: the project\'s title.'),
      provider: ProviderId.optional().describe("The agent: claude, codex, agy… Default: the project's."),
      model: z.string().optional(),
      location: Location.optional(),
      effort: Effort.optional(),
      runner: Runner.optional(),
      machine: z.string().optional().describe("Only this machine runs it. Default: any machine that can."),
      needs: z.array(MachineTool).optional().describe("What the machine must have: docker, database. Default: the project's."),
      push: z.boolean().optional().describe("Land the work on the checkout's branch and push it. Default false."),
      branch: z.string().min(1).optional().describe("Run from a checkout on this branch (e.g. a worktree's). Default: the machine's checkout of the repo."),
      after: z.array(z.string().min(1)).optional().describe("Start only after these succeed: keys, job ids, or handoff brief names"),
      localModel: z.boolean().optional().describe("It runs the machine's own local models (Ollama). Only one such job per machine at a time."),
      held: z.boolean().optional().describe("Add it on hold: it never starts until let go."),
      key: z.string().min(1).max(200).optional().describe("A unique name for it, e.g. the handoff brief's name"),
      top: z.boolean().optional().describe("First in its app"),
      before: z.string().uuid().optional().describe("Just before this waiting item (same app)"),
    }),
    run: async (sql: Sql, userId: string, i: any, by: string) => {
      if (!i.item && !i.repo) throw new HttpError(400, "Name the project: item or repo.");
      const node = i.item ? await resolveRef(sql, userId, i.item) : await projectByRemote(sql, userId, i.repo);
      const { machine, item: _item, repo: _repo, ...job } = i;
      const machineId = machine ? await machineByName(sql, userId, machine) : undefined;
      return createJob(sql, userId, { ...job, nodeId: node.id, machineId, backlog: true }, by);
    },
  },
  update_backlog_item: {
    description: "Change a backlog item that hasn't started: hold it (held true) or let it go (held false), move it (top, or before another waiting item in its app, or to another app), or change its title, task, agent, model, machine (null = any), needs, push, branch, after or localModel. To drop it, use cancel_job.",
    input: z.object({
      jobId: z.string().uuid(),
      changes: BacklogFields.extend({
        machine: z.string().nullable().optional().describe("Only this machine; null = any machine"),
        top: z.boolean().optional(),
        before: z.string().uuid().nullable().optional().describe("Just before this waiting item; null = last in its app"),
      }),
    }),
    run: async (sql: Sql, userId: string, i: any) => {
      const { machine, ...changes } = i.changes;
      const machineId = machine === undefined ? undefined : machine === null ? null : await machineByName(sql, userId, machine);
      return updateBacklogItem(sql, userId, i.jobId, { ...changes, machineId });
    },
  },
  set_app_ranking: {
    description: "Set the app ranking: the order backlog items go in, by app, first to last (e.g. [\"Legal\", \"Agents Only\", \"Opportunity Nav\"]). It replaces the whole ranking. Apps left out go after the ranked ones, in tree order. Inside an app, items keep their own order.",
    input: z.object({ apps: z.array(z.string().min(1).max(80)) }),
    run: (sql: Sql, userId: string, i: any) => setAppRanking(sql, userId, i.apps),
  },
  get_lined_up: {
    description: "Read-only: what's lined up. running = jobs running now; next = the next waiting items in the order they'll start, each with ready (it starts when one of canRunOn has a free slot) or why it's waiting; total, perApp and perMachine = how much is left; runningLow = fewer items ready than the machines have slots; finished = backlog items that ended in the last sinceHours (default 24); ranking = the app ranking.",
    input: z.object({
      next: z.number().int().positive().max(200).optional().describe("How many waiting items to list. Default 5."),
      all: z.boolean().optional().describe("List every waiting item, held ones too."),
      sinceHours: z.number().positive().max(24 * 14).optional(),
    }),
    run: (sql: Sql, userId: string, i: any) => linedUp(sql, userId, i),
  },
  set_machine: {
    description: "Set how many jobs a machine runs at once (jobLimit, at most what its helper runs; null = the helper's own number), or whether it takes new jobs at all (takingJobs). A machine not taking jobs finishes the ones it has.",
    input: z.object({ machine: z.string().min(1), jobLimit: z.number().int().nonnegative().max(32).nullable().optional(), takingJobs: z.boolean().optional() }),
    run: async (sql: Sql, userId: string, i: any) => {
      const id = await machineByName(sql, userId, i.machine);
      if (i.jobLimit !== undefined) await setJobLimit(sql, userId, id, i.jobLimit);
      if (i.takingJobs !== undefined) await setTakingJobs(sql, userId, { id }, i.takingJobs);
      const m = (await listMachines(sql, userId)).find((m) => m.id === id)!;
      return { name: m.name, capacity: m.capacity, jobLimit: m.jobLimit, running: m.running, takingJobs: m.takingJobs };
    },
  },
  get_job: {
    description: "A job's status, progress, questions and result.",
    input: z.object({ jobId: z.string().uuid() }),
    run: (sql: Sql, userId: string, i: any) => getJob(sql, userId, i.jobId),
  },
  cancel_job: {
    description: "Stop a job, or drop it from the backlog.",
    input: z.object({ jobId: z.string().uuid() }),
    run: (sql: Sql, userId: string, i: any) => cancelJob(sql, userId, i.jobId),
  },
  message_grok_bot: {
    description: "Send Grok Bot (Matt's CEO agent) a request or question. It works on its own and writes results back into Opportunity Nav; nothing comes back in this reply.",
    input: z.object({ message: z.string().min(1).max(8000) }),
    run: (_sql: Sql, _userId: string, i: any, by: string) => messageGrokBot(i.message, by === "you" ? "Matt" : by.replace(/^agent:/, "")),
  },
  clear_roadblock: {
    description: "Mark a roadblock as cleared.",
    input: z.object({ roadblockId: z.string().uuid() }),
    run: async (sql: Sql, userId: string, i: any) => {
      const [r] = await sql`update roadblocks set status = 'cleared', cleared_at = now() where id = ${i.roadblockId} and user_id = ${userId} returning id`;
      if (!r) throw new HttpError(404, "No such roadblock.");
      return { cleared: true };
    },
  },
} as const;

export type ActionName = keyof typeof actions;

export async function runAction(sql: Sql, userId: string, name: string, input: unknown, by: string) {
  const a = (actions as Record<string, (typeof actions)[ActionName]>)[name];
  if (!a) throw new HttpError(400, `Unknown action "${name}". Known: ${Object.keys(actions).join(", ")}.`);
  const parsed = a.input.safeParse(input ?? {});
  if (!parsed.success) throw new HttpError(400, `Bad input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return (a.run as any)(sql, userId, parsed.data, by);
}
