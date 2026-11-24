import { z } from "zod";
import { Location, MachineTool, ProviderId, repoIdentity } from "@opnav/shared";
import type { Db } from "../db.ts";
import { HttpError } from "../errors.ts";

export interface TreeNode {
  id: string;
  parentId: string | null;
  kind: "area" | "project" | "item";
  title: string;
  notes: string | null;
  position: number;
  favorite: boolean;
  favoritePosition: number | null;
  priority: Priority;
  repoRemote: string | null;
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultLocation: "local" | "cloud" | null;
  /** What this project's jobs need from a machine by default (docker, database). */
  defaultNeeds: MachineTool[];
  statusLine: string | null;
}

/** High, medium or low. Everything starts at medium. */
export const Priority = z.enum(["high", "medium", "low"]);
export type Priority = z.infer<typeof Priority>;
const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
/** Higher priority first; ties keep their order (Array.sort is stable). */
export const byPriority = (a: { priority: Priority }, b: { priority: Priority }) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];

export const NewTreeNode = z.object({
  parentId: z.string().uuid().nullable().default(null),
  kind: z.enum(["area", "project", "item"]),
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(10_000).optional(),
  repoRemote: z.string().optional(),
  defaultProvider: ProviderId.optional(),
  defaultModel: z.string().optional(),
  defaultLocation: Location.optional(),
  defaultNeeds: z.array(MachineTool).optional(),
  priority: Priority.optional(),
  /** Insert before this sibling; default = last. */
  beforeId: z.string().uuid().optional(),
});

export const TreeNodePatch = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  notes: z.string().max(10_000).nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  beforeId: z.string().uuid().nullable().optional(),
  favorite: z.boolean().optional(),
  /** Reorder favorites: put this one just before that favorite; null = last. */
  favoriteBeforeId: z.string().uuid().nullable().optional(),
  priority: Priority.optional(),
  repoRemote: z.string().nullable().optional(),
  defaultProvider: ProviderId.nullable().optional(),
  defaultModel: z.string().nullable().optional(),
  defaultLocation: Location.nullable().optional(),
  defaultNeeds: z.array(MachineTool).optional(),
  statusLine: z.string().max(300).nullable().optional(),
  archived: z.boolean().optional(),
});

/**
 * A repo as the server stores and compares it (repoIdentity): "git@github.com:A/B.git" and
 * "https://github.com/A/B" → "github.com/a/b" (GitHub ignores case); any other host keeps the
 * path's case, so two repos there that differ only in case stay two repos.
 */
export function normaliseRemote(remote: string): string {
  const known = repoIdentity(remote, { serverForm: true });
  if (known) return known;
  // Not an address we know (e.g. "owner/repo"): kept as given, case and all, so it matches only itself.
  return remote.trim().replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
}

const row = (r: any): TreeNode => ({
  id: r.id,
  parentId: r.parent_id,
  kind: r.kind,
  title: r.title,
  notes: r.notes,
  position: r.position,
  favorite: r.favorite_position != null,
  favoritePosition: r.favorite_position,
  priority: r.priority ?? "medium",
  repoRemote: r.repo_remote,
  defaultProvider: r.default_provider,
  defaultModel: r.default_model,
  defaultLocation: r.default_location,
  defaultNeeds: r.default_needs ?? [],
  statusLine: r.status_line,
});

export async function listTree(db: Db, userId: string): Promise<TreeNode[]> {
  const rows = await db`select * from tree_nodes where user_id = ${userId} and archived_at is null order by position`;
  return orderTree(rows.map(row));
}

/**
 * Depth-first; siblings by priority (high first), then the person's own order.
 * Used everywhere things are grouped by project.
 */
export function orderTree(nodes: TreeNode[]): TreeNode[] {
  const kids = new Map<string | null, TreeNode[]>();
  for (const n of nodes) {
    const k = kids.get(n.parentId) ?? [];
    k.push(n);
    kids.set(n.parentId, k);
  }
  for (const list of kids.values()) list.sort((a, b) => byPriority(a, b) || a.position - b.position);
  const ids = new Set(nodes.map((n) => n.id));
  const out: TreeNode[] = [];
  const walk = (parent: string | null) => {
    for (const n of kids.get(parent) ?? []) {
      out.push(n);
      walk(n.id);
    }
  };
  walk(null);
  // Orphans (parent archived) go last so nothing silently disappears.
  for (const n of nodes) if (n.parentId && !ids.has(n.parentId) && !out.includes(n)) out.push(n);
  return out;
}

export async function getNode(db: Db, userId: string, id: string): Promise<TreeNode> {
  const [r] = await db`select * from tree_nodes where user_id = ${userId} and id = ${id}`;
  if (!r) throw new HttpError(404, "No such item in your tree.");
  return row(r);
}

async function positionFor(db: Db, userId: string, parentId: string | null, beforeId: string | null | undefined, excludeId?: string) {
  const sibs = await db<{ id: string; position: number }[]>`
    select id, position from tree_nodes
    where user_id = ${userId} and parent_id is not distinct from ${parentId} and archived_at is null
      and id is distinct from ${excludeId ?? null}
    order by position`;
  if (!beforeId) return (sibs.at(-1)?.position ?? 0) + 1;
  const i = sibs.findIndex((s) => s.id === beforeId);
  if (i < 0) throw new HttpError(400, "beforeId is not a sibling.");
  const after = sibs[i]!.position;
  const prev = i > 0 ? sibs[i - 1]!.position : after - 2;
  return (prev + after) / 2;
}

async function favoritePositionFor(db: Db, userId: string, beforeId: string | null, excludeId: string) {
  const favs = await db<{ id: string; favorite_position: number }[]>`
    select id, favorite_position from tree_nodes
    where user_id = ${userId} and favorite_position is not null and archived_at is null and id <> ${excludeId}
    order by favorite_position`;
  if (!beforeId) return (favs.at(-1)?.favorite_position ?? 0) + 1;
  const i = favs.findIndex((f) => f.id === beforeId);
  if (i < 0) throw new HttpError(400, "favoriteBeforeId is not a favorite.");
  const after = favs[i]!.favorite_position;
  const prev = i > 0 ? favs[i - 1]!.favorite_position : after - 2;
  return (prev + after) / 2;
}

export async function createNode(db: Db, userId: string, input: z.input<typeof NewTreeNode>): Promise<TreeNode> {
  const n = NewTreeNode.parse(input);
  if (n.parentId) await getNode(db, userId, n.parentId);
  const position = await positionFor(db, userId, n.parentId, n.beforeId);
  const [r] = await db`
    insert into tree_nodes (user_id, parent_id, kind, title, notes, position, repo_remote, default_provider, default_model, default_location, priority, default_needs)
    values (${userId}, ${n.parentId}, ${n.kind}, ${n.title}, ${n.notes ?? null}, ${position},
            ${n.repoRemote ? normaliseRemote(n.repoRemote) : null}, ${n.defaultProvider ?? null}, ${n.defaultModel ?? null}, ${n.defaultLocation ?? null},
            ${n.priority ?? "medium"}, ${db.json([...new Set(n.defaultNeeds ?? [])])})
    returning *`;
  return row(r);
}

export async function updateNode(db: Db, userId: string, id: string, input: z.input<typeof TreeNodePatch>): Promise<TreeNode> {
  const p = TreeNodePatch.parse(input);
  const cur = await getNode(db, userId, id);
  const set: Record<string, unknown> = { updated_at: new Date() };
  if (p.title !== undefined) set.title = p.title;
  if (p.notes !== undefined) set.notes = p.notes;
  if (p.repoRemote !== undefined) set.repo_remote = p.repoRemote ? normaliseRemote(p.repoRemote) : null;
  if (p.defaultProvider !== undefined) set.default_provider = p.defaultProvider;
  if (p.defaultModel !== undefined) set.default_model = p.defaultModel;
  if (p.defaultLocation !== undefined) set.default_location = p.defaultLocation;
  if (p.defaultNeeds !== undefined) set.default_needs = db.json([...new Set(p.defaultNeeds)]);
  if (p.statusLine !== undefined) set.status_line = p.statusLine;
  if (p.priority !== undefined) set.priority = p.priority;
  if (p.archived !== undefined) set.archived_at = p.archived ? new Date() : null;
  if (p.favorite !== undefined) {
    if (!p.favorite) set.favorite_position = null;
    else if (!cur.favorite) {
      const [m] = await db<{ max: number | null }[]>`select max(favorite_position) as max from tree_nodes where user_id = ${userId}`;
      set.favorite_position = (m?.max ?? 0) + 1;
    }
  }
  if (p.favoriteBeforeId !== undefined && p.favorite !== false) {
    if (!cur.favorite && p.favorite !== true) throw new HttpError(400, "Only a favorite can be reordered.");
    set.favorite_position = await favoritePositionFor(db, userId, p.favoriteBeforeId, id);
  }
  if (p.parentId !== undefined || p.beforeId !== undefined) {
    const parentId = p.parentId !== undefined ? p.parentId : cur.parentId;
    if (parentId) {
      // No cycles: the new parent can't be this node or inside it.
      const [cyc] = await db`
        with recursive up as (select id, parent_id from tree_nodes where id = ${parentId}
          union all select t.id, t.parent_id from tree_nodes t join up on t.id = up.parent_id)
        select 1 from up where id = ${id}`;
      if (cyc) throw new HttpError(400, "Can't move an item inside itself.");
      await getNode(db, userId, parentId);
    }
    set.parent_id = parentId;
    set.position = await positionFor(db, userId, parentId, p.beforeId, id);
  }
  const [r] = await db`update tree_nodes set ${db(set)} where id = ${id} and user_id = ${userId} returning *`;
  return row(r);
}

/** Path of titles from the root, e.g. ["Golfer Geek", "Opportunity Nav"]. */
export function pathOf(nodes: Map<string, TreeNode>, id: string | null): string[] {
  const out: string[] = [];
  let cur = id ? nodes.get(id) : undefined;
  while (cur) {
    out.unshift(cur.title);
    cur = cur.parentId ? nodes.get(cur.parentId) : undefined;
  }
  return out;
}

/** Nearest ancestor-or-self that is a project. */
export function projectOf(nodes: Map<string, TreeNode>, id: string): TreeNode | undefined {
  let cur = nodes.get(id);
  while (cur && cur.kind !== "project") cur = cur.parentId ? nodes.get(cur.parentId) : undefined;
  return cur;
}
