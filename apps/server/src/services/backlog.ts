import { z } from "zod";
import { Location, MachineTool, ProviderId, Runner, runsInCloud } from "@opnav/shared";
import type { Db, Sql } from "../db.ts";
import { HttpError } from "../errors.ts";
import { runningCounts } from "./machines.ts";
import { listTree, normaliseRemote, pathOf } from "./tree.ts";
import { checkJobShape, jobLocation, jobRow, runsOnRow } from "./jobs.ts";

/**
 * The backlog: one ranked list of jobs that machines pull from by themselves.
 *
 * A backlog item is an ordinary queued job with backlog = true. When a machine
 * with room claims work, it gets the first job in this order that it can run
 * and that nothing holds back:
 *
 *   1. continue turns (a question was answered: resume it first),
 *   2. jobs started right away (start_job, start_review), oldest first,
 *   3. backlog items: by their app's place in the app ranking (apps not ranked
 *      come after, in tree order), then by their place inside the app.
 *
 * Held back, whatever its place:
 *   - held (a person put it on hold);
 *   - waiting on another item (after: a job's key or id, or a handoff brief's
 *     name) that hasn't succeeded yet;
 *   - local_model, while another local-model job runs on that machine (one job
 *     at a time uses a machine's own Ollama models), or on a machine without them;
 *   - push, while another pushing job runs for the same repo and branch.
 * Plus everything a claim already checked: the agent, the repo's checkout (on
 * the item's branch, if it names one), what it needs, a pinned machine, and the
 * machine's free slots (its helper's capacity, or its owner's lower limit).
 * A cloud job (runsInCloud) uses the machine's cloud slots instead, when its
 * helper has them (cloud_capacity): it only waits on a cloud, so it never takes
 * a local slot and never stops a local job from starting.
 */

export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);

const key = (s: string) => s.trim().toLowerCase();

/** The facts about a queued turn the ordering and the rules look at. Field names follow the jobs columns. */
export interface QueuedRow {
  id: string;
  turn_id?: string;
  kind: "start" | "continue";
  project_id: string;
  repo_remote: string | null;
  provider: string;
  runner: string;
  needs: string[];
  node_id: string | null;
  backlog: boolean;
  app: string | null;
  position: number;
  held: boolean;
  after: string[];
  local_model: boolean;
  push: boolean;
  branch: string | null;
  checkout_path: string | null;
  checkout_branch: string | null;
  created_at: Date | string;
  turn_created_at?: Date | string;
}

export interface Ranking {
  /** lower(app) → its place in the person's ranking. */
  apps: Map<string, number>;
  /** project id → its place in the tree (priority, then the person's order). */
  tree: Map<string, number>;
  /** project id → its title, the default app. */
  titles: Map<string, string>;
}

export async function loadRanking(db: Db, userId: string): Promise<Ranking> {
  const [apps, tree] = await Promise.all([
    db<{ name: string; position: number }[]>`select name, position from backlog_apps where user_id = ${userId} order by position`,
    listTree(db, userId),
  ]);
  return {
    apps: new Map(apps.map((a, i) => [key(a.name), i])),
    tree: new Map(tree.map((n, i) => [n.id, i])),
    titles: new Map(tree.map((n) => [n.id, n.title])),
  };
}

export const appOf = (r: Pick<QueuedRow, "app" | "project_id">, rk: Ranking) => r.app ?? rk.titles.get(r.project_id) ?? "Other";

const time = (d: Date | string | undefined) => (d ? new Date(d).getTime() : 0);

/** Sort key: lower goes first. fallback = each unranked app's place after the ranked ones. */
function sortKey(r: QueuedRow, rk: Ranking, fallback: Map<string, number>): number[] {
  if (r.kind === "continue") return [0, 0, 0, time(r.turn_created_at ?? r.created_at)];
  if (!r.backlog) return [1, 0, 0, time(r.turn_created_at ?? r.created_at)];
  const app = key(appOf(r, rk));
  return [2, rk.apps.get(app) ?? 1_000_000 + fallback.get(app)!, Number(r.position), time(r.created_at)];
}

export function orderQueue<T extends QueuedRow>(rows: T[], rk: Ranking): T[] {
  // An app that isn't ranked goes where its first project sits in the tree, as one group.
  const firstAt = new Map<string, number>();
  for (const r of rows) {
    if (!r.backlog || r.kind === "continue") continue;
    const app = key(appOf(r, rk));
    if (rk.apps.has(app)) continue;
    firstAt.set(app, Math.min(firstAt.get(app) ?? Infinity, rk.tree.get(r.project_id) ?? 999_999));
  }
  const fallback = new Map([...firstAt].sort(([a, x], [b, y]) => x - y || a.localeCompare(b)).map(([app], i) => [app, i]));
  const keys = new Map(rows.map((r) => [r, sortKey(r, rk, fallback)]));
  return [...rows].sort((a, b) => {
    const x = keys.get(a)!, y = keys.get(b)!;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
    return 0;
  });
}

/** What a machine offers when it claims (or, for the lined-up view, could offer). */
export interface Offer {
  id: string;
  providers: string[];
  cloudroomProviders: string[];
  claudeCloud: boolean;
  /** The repos its Claude routine covers (normaliseRemote form). A Claude cloud job goes only to a machine covering its repo. */
  claudeCloudRepos: string[];
  tools: string[];
  checkouts: OfferedCheckout[];
  /** It has its own local models (Ollama). */
  localModels: boolean;
}

export interface OfferedCheckout { path: string; remote?: string; branch?: string; linked?: boolean; defaultBranch?: string }

/** The project's default branch as this checkout knows it; older helpers don't say, so main or master on their word. */
function onDefault(c: OfferedCheckout): boolean {
  return c.defaultBranch ? c.branch === c.defaultBranch : c.branch === "main" || c.branch === "master";
}

/**
 * The checkouts of one repo on a machine, best first: one on the project's default branch, then
 * the repo's own checkout before linked worktrees (someone's side work), then by path. A machine
 * can have many hand-made worktrees of a repo; which one sorts first by path means nothing.
 */
export function rankCheckouts(same: OfferedCheckout[]): OfferedCheckout[] {
  const score = (c: OfferedCheckout) => (onDefault(c) ? 0 : 2) + (c.linked ? 1 : 0);
  return [...same].sort((a, b) => score(a) - score(b) || a.path.localeCompare(b.path));
}

/**
 * The checkout this machine would run the turn in, or why it can't, and the branch the job works
 * toward: the one it names, or the project's default branch. A pushing job lands there, so that's
 * the branch two pushing jobs mustn't share.
 */
export function checkoutFor(r: QueuedRow, m: Offer): { path: string; branch: string | null } | { why: string } {
  if (r.node_id && r.node_id !== m.id) return { why: "pinned to another machine" };
  const agentOk = r.runner === "direct" ? m.providers.includes(r.provider)
    : r.runner === "cloudroom" ? m.cloudroomProviders.includes(r.provider)
    : r.runner === "claude-cloud" ? r.provider === "claude" && m.claudeCloud
    : false;
  if (!agentOk) return { why: `no ${r.runner === "direct" ? "" : `${r.runner} `}${r.provider}` };
  if (r.runner === "claude-cloud" && !(r.repo_remote && m.claudeCloudRepos.includes(normaliseRemote(r.repo_remote)))) {
    return { why: "its Claude routine doesn't cover the repo" };
  }
  if (r.runner === "direct" && !r.needs.every((n) => m.tools.includes(n))) return { why: `needs ${r.needs.join(", ")}` };
  if (r.local_model && !m.localModels) return { why: "no local models" };
  if (r.kind === "continue" && r.checkout_path) return { path: r.checkout_path, branch: r.checkout_branch };
  if (!r.repo_remote) return { why: "no repo" };
  const same = m.checkouts.filter((c) => c.remote && normaliseRemote(c.remote) === r.repo_remote);
  if (!same.length) return { why: "no checkout of the repo" };
  const ranked = rankCheckouts(same);
  // A job that names a branch runs in a checkout on it (an older helper lands on the checkout's branch).
  const c = r.branch ? ranked.find((c) => c.branch === r.branch) : ranked[0];
  if (!c) return { why: `no checkout on ${r.branch}` };
  return { path: c.path, branch: r.branch ?? c.defaultBranch ?? c.branch ?? null };
}

/** What's running right now, as the rules see it. */
export interface Busy {
  /** Machines running a local-model job. */
  localModel: Set<string>;
  /** "repo#branch" with a pushing job running. */
  pushing: Set<string>;
  /** Keys and ids that have succeeded (lower case). */
  done: Set<string>;
}

export const branchKey = (repo: string | null, branch: string | null) => `${repo ?? "?"}#${branch ?? "?"}`;

/**
 * Running jobs, for the rules. A running job's branch is the one it was handed
 * out with; for one claimed before the backlog existed, the branch its machine
 * reports for that checkout.
 */
export async function loadBusy(db: Db, userId: string, afterKeys: string[]): Promise<Busy> {
  const running = await db`
    select j.id, t.node_id, j.local_model, j.push, j.checkout_branch, j.checkout_path, p.repo_remote, n.checkouts
    from turns t join jobs j on j.id = t.job_id join tree_nodes p on p.id = j.project_id left join nodes n on n.id = t.node_id
    where j.user_id = ${userId} and t.status = 'running' and t.lease_expires_at > now()`;
  const busy: Busy = { localModel: new Set(), pushing: new Set(), done: new Set() };
  for (const r of running) {
    if (r.local_model && r.node_id) busy.localModel.add(r.node_id);
    if (r.push) {
      const branch = r.checkout_branch ?? ((r.checkouts ?? []) as { path: string; branch?: string }[]).find((c) => c.path === r.checkout_path)?.branch ?? null;
      busy.pushing.add(branchKey(r.repo_remote, branch));
    }
  }
  const wanted = [...new Set(afterKeys.map(key))];
  if (wanted.length) {
    const uuids = wanted.filter((k) => /^[0-9a-f-]{36}$/.test(k));
    const done = await db<{ k: string }[]>`
      select lower(key) as k from jobs where user_id = ${userId} and status = 'succeeded' and lower(key) in ${db(wanted)}
      union select id::text from jobs where user_id = ${userId} and status = 'succeeded' and id::text in ${db(uuids.length ? uuids : ["-"])}
      union select lower(external_id) from external_work where user_id = ${userId} and source = 'handoff' and status = 'succeeded'
        and lower(external_id) in ${db(wanted)}`;
    for (const d of done) busy.done.add(d.k);
  }
  return busy;
}

/** Why the rules hold this turn back right now (not counting which machine), or null. */
export function heldBack(r: QueuedRow, busy: Busy): string | null {
  if (r.held) return "On hold";
  if (r.kind === "start") {
    const waiting = r.after.filter((a) => !busy.done.has(key(a)));
    if (waiting.length) return `Waits for ${waiting.join(", ")}`;
  }
  return null;
}

/** Why this machine can't take it now because of what's running, or null. */
export function turnBlocked(r: QueuedRow, machineId: string, branch: string | null, busy: Busy): string | null {
  if (r.local_model && busy.localModel.has(machineId)) return "Waits for the local models";
  if (r.push && busy.pushing.has(branchKey(r.repo_remote, branch))) return `Waits for ${branch ?? "its branch"} to be free`;
  return null;
}

/** Record a turn just handed out, so the rest of the same claim sees it. */
export function markBusy(r: QueuedRow, machineId: string, branch: string | null, busy: Busy) {
  if (r.local_model) busy.localModel.add(machineId);
  if (r.push) busy.pushing.add(branchKey(r.repo_remote, branch));
}

// ── Adding, changing and ranking ─────────────────────────────────────

export const BacklogFields = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(1).optional(),
  app: z.string().trim().min(1).max(80).nullable().optional(),
  provider: ProviderId.optional(),
  model: z.string().nullable().optional(),
  location: Location.optional(),
  effort: Effort.nullable().optional(),
  runner: Runner.optional(),
  needs: z.array(MachineTool).optional(),
  push: z.boolean().optional(),
  branch: z.string().trim().min(1).nullable().optional(),
  after: z.array(z.string().trim().min(1)).optional(),
  localModel: z.boolean().optional(),
  held: z.boolean().optional(),
});

/** Put a backlog job at its place: first in its app, last, or just before another item. Renumbers the app. */
export async function placeInApp(tx: Db, userId: string, jobId: string, where: { top?: boolean; before?: string | null }) {
  const [me] = await tx`select id, app, project_id from jobs where id = ${jobId} and user_id = ${userId}`;
  if (!me) throw new HttpError(404, "No such job.");
  const rk = await loadRanking(tx, userId);
  const myApp = key(appOf(me as any, rk));
  const rows = await tx`select id, app, project_id, position, created_at from jobs
    where user_id = ${userId} and backlog and status = 'queued' and attempts = 0 order by position, created_at`;
  const list = rows.filter((r) => key(appOf(r as any, rk)) === myApp && r.id !== jobId).map((r) => r.id as string);
  if (where.top) list.unshift(jobId);
  else if (where.before) {
    const at = list.indexOf(where.before);
    if (at < 0) throw new HttpError(400, "That item isn't waiting in the same app, so this one can't go before it.");
    list.splice(at, 0, jobId);
  } else list.push(jobId);
  for (const [i, id] of list.entries()) await tx`update jobs set position = ${i + 1} where id = ${id}`;
}

/** Replace the app ranking with this order. */
export async function setAppRanking(sql: Sql, userId: string, apps: string[]) {
  const seen = new Set<string>();
  const list = apps.map((a) => a.trim()).filter((a) => a && !seen.has(key(a)) && seen.add(key(a)));
  await sql.begin(async (tx) => {
    await tx`delete from backlog_apps where user_id = ${userId}`;
    for (const [i, name] of list.entries()) await tx`insert into backlog_apps (user_id, name, position) values (${userId}, ${name}, ${i})`;
  });
  return { apps: list };
}

export async function getAppRanking(db: Db, userId: string) {
  return (await db<{ name: string }[]>`select name from backlog_apps where user_id = ${userId} order by position`).map((a) => a.name);
}

/** Change a backlog item that hasn't started. Hold, let go, re-rank, edit. */
export async function updateBacklogItem(sql: Sql, userId: string, jobId: string,
  changes: z.infer<typeof BacklogFields> & { machineId?: string | null; top?: boolean; before?: string | null }) {
  return sql.begin(async (tx) => {
    const [j] = await tx`select * from jobs where id = ${jobId} and user_id = ${userId} for update`;
    if (!j) throw new HttpError(404, "No such job.");
    if (!j.backlog) throw new HttpError(409, "That job was started right away, not added to the backlog. Use cancel_job to stop it.");
    if (j.status !== "queued") throw new HttpError(409, `It has ${j.status === "running" ? "started" : `already ${j.status}`}, so it can't be changed now. Cancel it instead.`);
    const notStarted = Number(j.attempts) === 0;
    const started = (what: string) => { if (!notStarted) throw new HttpError(409, `It has already run once, so its ${what} can't change.`); };
    const set: Record<string, unknown> = {};
    if (changes.title !== undefined) set.title = changes.title;
    if (changes.prompt !== undefined) { started("task"); set.prompt = changes.prompt; }
    if (changes.app !== undefined) set.app = changes.app;
    if (changes.provider !== undefined) { started("agent"); set.provider = changes.provider; }
    if (changes.model !== undefined) { started("model"); set.model = changes.model; }
    if (changes.location !== undefined) { started("location"); set.location = changes.location; }
    if (changes.effort !== undefined) set.effort = changes.effort;
    if (changes.runner !== undefined) { started("runner"); set.runner = changes.runner; }
    if (changes.needs !== undefined) set.needs = tx.json([...new Set(changes.needs)]);
    if (changes.push !== undefined) { started("push setting"); set.push = changes.push; }
    if (changes.branch !== undefined) { started("branch"); set.branch = changes.branch; }
    if (changes.after !== undefined) set.after = tx.json(changes.after);
    if (changes.localModel !== undefined) set.local_model = changes.localModel;
    if (changes.held !== undefined) set.held = changes.held;
    if (changes.machineId !== undefined) {
      started("machine");
      set.node_id = changes.machineId;
      set.pinned = changes.machineId != null;
    }
    // The result has to be a job some machine can run, as when it was added.
    const provider = (changes.provider ?? j.provider) as string;
    const location = changes.location !== undefined || changes.provider !== undefined
      ? jobLocation(provider, changes.location ?? (changes.provider !== undefined ? undefined : j.location), null) : j.location;
    if (location !== j.location) set.location = location;
    checkJobShape(provider, (changes.runner ?? j.runner ?? "direct") as string, location, changes.localModel ?? Boolean(j.local_model));
    if (Object.keys(set).length) {
      set.updated_at = new Date();
      await tx`update jobs set ${tx(set)} where id = ${jobId}`;
    }
    const moved = changes.top || changes.before !== undefined || changes.app !== undefined;
    if (moved && notStarted) await placeInApp(tx, userId, jobId, { top: changes.top, before: changes.before ?? null });
    const [row] = await tx`select j.*, n.name as machine from jobs j left join nodes n on n.id = j.node_id where j.id = ${jobId}`;
    return backlogRow(row);
  });
}

export const backlogRow = jobRow;

// ── What's lined up (read-only) ──────────────────────────────────────

interface MachineView {
  id: string;
  name: string;
  online: boolean;
  takingJobs: boolean;
  /** Local slots, and the jobs running in them. */
  slots: number;
  running: number;
  /** Cloud slots, and the cloud jobs running in them. Null = an older helper: cloud jobs take local slots. */
  cloudSlots: number | null;
  cloudRunning: number;
  offer: Offer;
}

/** The slots a job with this runner uses on a machine, and how many of them are taken. */
export function poolFor(m: Pick<MachineView, "slots" | "running" | "cloudSlots" | "cloudRunning">, runner: string) {
  return m.cloudSlots != null && runsInCloud(runner) ? { slots: m.cloudSlots, running: m.cloudRunning } : { slots: m.slots, running: m.running };
}

/** Local and cloud slots from a nodes row with runningCounts. */
export function slotsView(r: Record<string, any>) {
  const split = r.cloud_capacity != null;
  const total = Number(r.running ?? 0), cloud = Number(r.running_cloud ?? 0);
  return { slots: slotsOf(r), running: split ? total - cloud : total, cloudSlots: split ? Number(r.cloud_capacity) : null, cloudRunning: cloud };
}

/** Online machines, one per name (a reinstalled machine keeps older records), with what they can run and their slots. */
export async function onlineMachines(db: Db, userId: string): Promise<MachineView[]> {
  const rows = await db`select n.*, ${runningCounts(db)}
    from nodes n join api_tokens t on t.id = n.token_id
    where n.user_id = ${userId} and t.revoked_at is null order by n.last_seen_at desc`;
  const seen = new Set<string>();
  const out: MachineView[] = [];
  for (const r of rows) {
    if (seen.has(key(r.name))) continue;
    seen.add(key(r.name));
    const providers = (r.providers ?? []) as { provider: string; signedIn: boolean; canRunJobs: boolean; models?: string[] }[];
    out.push({
      id: r.id, name: r.name,
      online: Date.now() - new Date(r.last_seen_at).getTime() < 120_000,
      takingJobs: r.taking_jobs !== false,
      ...slotsView(r),
      offer: {
        id: r.id,
        providers: providers.filter((p) => p.canRunJobs && p.signedIn).map((p) => p.provider),
        cloudroomProviders: (r.cloudroom?.providers ?? []) as string[],
        claudeCloud: Boolean(r.claude_cloud?.ready),
        claudeCloudRepos: ((r.claude_cloud?.repos ?? []) as string[]).map(normaliseRemote),
        tools: (r.tools ?? []) as string[],
        checkouts: (r.checkouts ?? []) as Offer["checkouts"],
        localModels: hasLocalModels(providers),
      },
    });
  }
  return out;
}

/** A machine's local job slots: its helper's capacity, or its owner's lower limit. Cloud slots aren't limited by it. */
export const slotsOf = (r: { capacity?: number | null; job_limit?: number | null }) =>
  Math.min(Number(r.capacity ?? 1), r.job_limit == null ? Infinity : Number(r.job_limit));

/** Ollama on the machine, with models: it can run local-model jobs. */
export const hasLocalModels = (providers: { provider: string; signedIn?: boolean; models?: string[] }[]) =>
  providers.some((p) => p.provider === "ollama" && p.signedIn !== false && (p.models?.length ?? 0) > 0);

/** Queued turns, with their job's columns (the QueuedRow fields and the rest). after and needs are never null. */
export async function queuedRows(db: Db, userId: string): Promise<(QueuedRow & Record<string, any>)[]> {
  const rows = await db`
    select t.id as turn_id, t.kind, t.answer_id, t.created_at as turn_created_at, j.*, p.repo_remote, n.name as machine
    from turns t join jobs j on j.id = t.job_id join tree_nodes p on p.id = j.project_id left join nodes n on n.id = j.node_id
    where t.status = 'queued' and j.user_id = ${userId} and j.status = 'queued' and not j.cancel_requested`;
  return rows.map((r) => ({ ...r, after: r.after ?? [], needs: r.needs ?? [] })) as any;
}

/**
 * What's lined up: running now, next in order, work left per app and per
 * machine, and whether the backlog is running low (fewer items ready than the
 * machines have slots). Read-only.
 */
export async function linedUp(db: Db, userId: string, opts: { next?: number; all?: boolean; sinceHours?: number } = {}) {
  const next = opts.next ?? 5;
  const [rk, machines, queuedRaw, runningRows, finishedRows, ranking] = await Promise.all([
    loadRanking(db, userId),
    onlineMachines(db, userId),
    queuedRows(db, userId),
    db`select j.*, n.name as machine, t.started_at from turns t join jobs j on j.id = t.job_id left join nodes n on n.id = t.node_id
       where j.user_id = ${userId} and t.status = 'running' and t.lease_expires_at > now() order by t.started_at`,
    db`select j.*, n.name as machine from jobs j left join nodes n on n.id = j.node_id
       where j.user_id = ${userId} and j.backlog and j.finished_at > now() - make_interval(hours => ${opts.sinceHours ?? 24})
       order by j.finished_at desc limit 20`,
    getAppRanking(db, userId),
  ]);
  const tree = await listTree(db, userId);
  const byId = new Map(tree.map((n) => [n.id, n]));
  const queued = orderQueue(queuedRaw, rk);
  const busy = await loadBusy(db, userId, queued.flatMap((r) => r.after));
  const workers = machines.filter((m) => m.online && m.takingJobs && (m.slots > 0 || (m.cloudSlots ?? 0) > 0));

  const items = queued.map((r) => {
    let why = heldBack(r, busy);
    const canRunOn: string[] = [];
    if (!why) {
      const reasons = new Set<string>();
      for (const m of workers) {
        if (poolFor(m, r.runner).slots <= 0) continue;
        const c = checkoutFor(r, m.offer);
        if ("why" in c) { reasons.add(`${m.name}: ${c.why}`); continue; }
        const blocked = turnBlocked(r, m.id, c.branch, busy);
        if (blocked) { reasons.add(blocked); continue; }
        canRunOn.push(m.name);
      }
      if (!canRunOn.length) why = reasons.size ? [...reasons].join("; ") : "No machine is online and taking jobs";
    }
    return {
      id: r.id, title: r.title, app: appOf(r, rk), project: pathOf(byId, r.project_id).join(" / "),
      backlog: Boolean(r.backlog), provider: r.provider, model: r.model ?? null, machine: r.node_id ? r.machine ?? null : null,
      runsOn: runsOnRow(r, r.node_id ? r.machine ?? null : null),
      push: Boolean(r.push), branch: r.branch ?? null, localModel: Boolean(r.local_model), after: r.after, held: Boolean(r.held),
      key: r.key ?? null, resuming: r.kind === "continue",
      /** Ready = it would start as soon as one of these machines has a free slot. */
      ready: !why, canRunOn, why,
    };
  });

  const running = runningRows.map((r) => ({
    id: r.id, title: r.title, app: appOf(r as any, rk), project: pathOf(byId, r.project_id).join(" / "),
    provider: r.provider, model: r.model ?? null, machine: r.machine ?? null, startedAt: r.started_at, lastProgress: r.last_progress ?? null,
    backlog: Boolean(r.backlog), runsOn: runsOnRow(r),
  }));

  const perApp = new Map<string, { app: string; running: number; ready: number; waiting: number; held: number }>();
  const rankedName = new Map(ranking.map((a) => [key(a), a]));
  const appEntry = (app: string) => {
    const e = perApp.get(key(app)) ?? { app: rankedName.get(key(app)) ?? app, running: 0, ready: 0, waiting: 0, held: 0 };
    perApp.set(key(app), e);
    return e;
  };
  for (const r of running) appEntry(r.app).running++;
  for (const i of items) {
    const e = appEntry(i.app);
    if (i.held) e.held++;
    else if (i.ready) e.ready++;
    else e.waiting++;
  }
  const appOrder = (a: string) => rk.apps.get(key(a)) ?? 1e6;
  const ready = items.filter((i) => i.ready);
  const slots = workers.reduce((n, m) => n + m.slots, 0);

  return {
    running,
    next: (opts.all ? items : items.filter((i) => !i.held)).slice(0, opts.all ? undefined : next),
    total: { waiting: items.filter((i) => !i.held).length, ready: ready.length, held: items.filter((i) => i.held).length, running: running.length },
    perApp: [...perApp.values()].sort((a, b) => appOrder(a.app) - appOrder(b.app) || a.app.localeCompare(b.app)),
    perMachine: machines.filter((m) => m.online).map((m) => ({
      name: m.name, takingJobs: m.takingJobs, slots: m.slots, running: m.running, free: Math.max(0, m.slots - m.running),
      /** Cloud slots, when it runs cloud jobs in their own (null = it can't run cloud jobs, or an older helper: they use the slots above). */
      ...(() => {
        const cloudSlots = m.offer.claudeCloud || m.offer.cloudroomProviders.length ? m.cloudSlots : null;
        return { cloudSlots, cloudRunning: m.cloudRunning, cloudFree: cloudSlots == null ? null : Math.max(0, cloudSlots - m.cloudRunning) };
      })(),
      /** Ready items this machine could run. */
      canTake: ready.filter((i) => i.canRunOn.includes(m.name)).length,
      /** Waiting items pinned to it. */
      pinned: items.filter((i) => !i.held && i.machine === m.name).length,
    })),
    runningLow: {
      low: ready.length < slots,
      ready: ready.length,
      slots,
      text: ready.length < slots
        ? `Running low: ${ready.length} ready for ${slots} slot${slots === 1 ? "" : "s"}.`
        : `${ready.length} ready for ${slots} slot${slots === 1 ? "" : "s"}.`,
    },
    finished: finishedRows.map((r) => ({ id: r.id, title: r.title, app: appOf(r as any, rk), status: r.status, machine: r.machine ?? null, finishedAt: r.finished_at, key: r.key ?? null })),
    ranking,
  };
}
