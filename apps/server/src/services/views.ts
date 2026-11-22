import type { Db } from "../db.ts";
import { listTree, pathOf, type TreeNode } from "./tree.ts";

/**
 * The two panes. Both are grouped by project in the person's tree order, and
 * both stay quiet: only what's in flight, waiting on the person, or blocked.
 */

export interface HappeningItem {
  kind: "question" | "roadblock" | "job" | "external";
  id: string;
  title: string;
  detail: string | null;
  status: string;
  at: Date;
  startedAt?: Date | null;
  jobId?: string | null;
  externalId?: string | null;
  options?: string[] | null;
  provider?: string;
  model?: string | null;
  machine?: string | null;
  url?: string | null;
  source?: string;
}

export interface HappeningGroup {
  projectId: string | null;
  path: string[];
  items: HappeningItem[];
}

const RANK: Record<HappeningItem["kind"], number> = { question: 0, roadblock: 1, job: 2, external: 3 };

export async function happening(db: Db, userId: string, scopeId?: string): Promise<HappeningGroup[]> {
  const tree = await listTree(db, userId);
  const byId = new Map(tree.map((n) => [n.id, n]));
  const inScope = scopeId ? subtreeIds(tree, scopeId) : null;

  const [questions, roadblocks, jobs, external] = await Promise.all([
    db`select q.*, j.title as job_title, w.title as work_title, w.url as work_url from questions q
       left join jobs j on j.id = q.job_id left join external_work w on w.id = q.external_work_id
       where q.user_id = ${userId} and q.status = 'open' and (w.id is null or w.gone_at is null)`,
    db`select r.*, j.title as job_title from roadblocks r left join jobs j on j.id = r.job_id
       where r.user_id = ${userId} and r.status = 'open'`,
    db`select j.*, n.name as machine from jobs j left join nodes n on n.id = j.node_id
       where j.user_id = ${userId} and j.status in ('queued', 'running')`,
    db`select w.*, n.name as machine from external_work w left join nodes n on n.id = w.node_id
       where w.user_id = ${userId} and w.gone_at is null and w.status in ('queued', 'running', 'waiting')`,
  ]);

  const groups = new Map<string | null, HappeningItem[]>();
  const add = (projectId: string | null, item: HappeningItem) => {
    if (inScope && (!projectId || !inScope.has(projectId))) return;
    const g = groups.get(projectId) ?? [];
    g.push(item);
    groups.set(projectId, g);
  };
  for (const q of questions)
    add(q.project_id, {
      kind: "question", id: q.id, title: q.body, detail: q.context ?? q.job_title ?? q.work_title ?? null,
      status: "open", at: q.created_at, jobId: q.job_id, externalId: q.external_work_id, options: q.options, url: q.work_url,
    });
  for (const r of roadblocks)
    add(r.project_id, { kind: "roadblock", id: r.id, title: r.body, detail: r.job_title, status: "open", at: r.created_at, jobId: r.job_id });
  for (const j of jobs)
    add(j.project_id, {
      kind: "job", id: j.id, title: j.title, detail: j.last_progress, status: j.status, at: j.updated_at, jobId: j.id,
      provider: j.provider, model: j.model, machine: j.machine,
    });
  for (const w of external)
    add(w.project_id, {
      kind: "external", id: w.id, title: w.title, detail: lastActivity(w.detail) ?? w.summary, status: w.status, at: w.updated_at, startedAt: w.started_at, externalId: w.id,
      machine: w.machine, url: w.url, source: w.source,
    });

  const order = new Map(tree.map((n, i) => [n.id, i]));
  return [...groups.entries()]
    .sort(([a], [b]) => (a ? (order.get(a) ?? 1e9) : 1e9 + 1) - (b ? (order.get(b) ?? 1e9) : 1e9 + 1))
    .map(([projectId, items]) => ({
      projectId,
      path: projectId ? pathOf(byId, projectId) : ["Not in a project yet"],
      items: items.sort((a, b) => RANK[a.kind] - RANK[b.kind] || +new Date(b.at) - +new Date(a.at)),
    }));
}

/** The newest activity line, so a running item says what it's doing right now. */
function lastActivity(detail: any): string | null {
  const a = detail?.activity;
  return Array.isArray(a) && a.length ? String(a[a.length - 1].text ?? "").slice(0, 300) : null;
}

function subtreeIds(tree: TreeNode[], rootId: string): Set<string> {
  const ids = new Set([rootId]);
  for (const n of tree) if (n.parentId && ids.has(n.parentId)) ids.add(n.id); // tree is DFS-ordered, parents first
  return ids;
}

export async function dashboard(db: Db, userId: string) {
  const subs = await db`select * from subscriptions where user_id = ${userId} and not hidden order by provider, label`;
  const windows = subs.length
    ? await db`select * from usage_windows where subscription_id in ${db(subs.map((s) => s.id))} order by kind, window_id`
    : [];
  const now = Date.now();
  const subscriptions = subs.map((s) => ({
    id: s.id,
    provider: s.provider,
    label: s.label,
    plan: s.plan,
    status: s.status,
    message: s.message,
    fetchedAt: s.fetched_at,
    monthlyCostUsd: s.monthly_cost_usd == null ? null : Number(s.monthly_cost_usd),
    windows: windows
      .filter((w) => w.subscription_id === s.id)
      .map((w) => {
        // A window whose reset time has passed is back at zero, even if no fresh reading has arrived.
        const reset = w.resets_at && new Date(w.resets_at).getTime() <= now;
        const percent = w.unit === "percent" ? w.used : w.lim ? (w.used / w.lim) * 100 : null;
        return {
          id: w.window_id, label: w.label, kind: w.kind, unit: w.unit, used: reset ? 0 : w.used, limit: w.lim,
          percent: reset ? 0 : percent, resetsAt: reset ? null : w.resets_at, model: w.model, hasReset: !!reset,
        };
      }),
  }));
  const totalMonthlyUsd = subscriptions.reduce((t, s) => t + (s.monthlyCostUsd ?? 0), 0);

  const tree = await listTree(db, userId);
  const stats = await db`
    select project_id,
      count(*) filter (where status in ('queued', 'running')) as active,
      count(*) filter (where status = 'waiting') as waiting,
      (array_agg(summary order by finished_at desc nulls last) filter (where status = 'succeeded'))[1] as last_done
    from jobs where user_id = ${userId} group by project_id`;
  const openQ = await db`select project_id, count(*) as n from questions where user_id = ${userId} and status = 'open' group by project_id`;
  const openR = await db`select project_id, count(*) as n from roadblocks where user_id = ${userId} and status = 'open' group by project_id`;
  const s = new Map(stats.map((r) => [r.project_id, r]));
  const q = new Map(openQ.map((r) => [r.project_id, Number(r.n)]));
  const r = new Map(openR.map((x) => [x.project_id, Number(x.n)]));
  const byId = new Map(tree.map((n) => [n.id, n]));
  const projects = tree
    .filter((n) => n.kind === "project")
    .map((p) => {
      const st = s.get(p.id);
      const active = Number(st?.active ?? 0);
      const questions = q.get(p.id) ?? 0;
      const roadblocks = r.get(p.id) ?? 0;
      return {
        id: p.id,
        path: pathOf(byId, p.id),
        line: p.statusLine ?? autoLine(active, questions, roadblocks, st?.last_done ?? null),
        active, questions, roadblocks,
      };
    });
  return { subscriptions, totalMonthlyUsd, projects };
}

function autoLine(active: number, questions: number, roadblocks: number, lastDone: string | null): string {
  const parts: string[] = [];
  if (questions) parts.push(`${questions} question${questions > 1 ? "s" : ""} for you`);
  if (roadblocks) parts.push(`${roadblocks} roadblock${roadblocks > 1 ? "s" : ""}`);
  if (active) parts.push(`${active} job${active > 1 ? "s" : ""} in flight`);
  if (parts.length) return parts.join(" · ");
  return lastDone ? `Last done: ${lastDone.split("\n")[0]!.slice(0, 120)}` : "Quiet";
}
