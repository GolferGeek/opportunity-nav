import { z } from "zod";
import { Location, ProviderId } from "@opnav/shared";
import type { Sql } from "../db.ts";
import { HttpError } from "../errors.ts";
import { answerQuestion, cancelJob, createJob, getJob } from "./jobs.ts";
import { createNode, listTree, pathOf, TreeNodePatch, updateNode, type TreeNode } from "./tree.ts";
import { dashboard, happening } from "./views.ts";
import { messageGrokBot } from "./outbound.ts";

/**
 * Everything an agent can do, in one place. A2A skills and MCP tools are thin
 * wrappers over these, so both doors behave the same. Items can be named by id
 * or by a title path like "Golfer Geek / Opportunity Nav" (case-insensitive),
 * which is what a voice or chat request naturally gives.
 */

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
      return tree.map((n) => ({ id: n.id, kind: n.kind, path: pathOf(byId, n.id).join(" / "), favorite: n.favorite, repo: n.repoRemote, status: n.statusLine }));
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
    description: "Change an item: rename, move, favorite, set its repo, defaults, or one-line status.",
    input: z.object({ item: Ref, changes: TreeNodePatch.omit({ parentId: true }).extend({ moveUnder: Ref.nullable().optional() }) }),
    run: async (sql: Sql, userId: string, i: any) => {
      const node = await resolveRef(sql, userId, i.item);
      const { moveUnder, ...changes } = i.changes;
      if (moveUnder !== undefined) changes.parentId = moveUnder === null ? null : (await resolveRef(sql, userId, moveUnder)).id;
      return updateNode(sql, userId, node.id, changes);
    },
  },
  answer_question: {
    description: "Answer a question an agent asked the person. The job resumes where it stopped.",
    input: z.object({ questionId: z.string().uuid(), answer: z.string().min(1) }),
    run: (sql: Sql, userId: string, i: any, by: string) => answerQuestion(sql, userId, i.questionId, i.answer, by),
  },
  start_job: {
    description: "Start an agent on a task in a project. Provider, model and local-or-cloud default to the project's settings.",
    input: z.object({
      item: Ref.describe("The project (or an item inside it) to work on"),
      prompt: z.string().min(1),
      title: z.string().optional(),
      provider: ProviderId.optional(),
      model: z.string().optional(),
      location: Location.optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    }),
    run: async (sql: Sql, userId: string, i: any, by: string) => {
      const node = await resolveRef(sql, userId, i.item);
      return createJob(sql, userId, { ...i, nodeId: node.id }, by);
    },
  },
  get_job: {
    description: "A job's status, progress, questions and result.",
    input: z.object({ jobId: z.string().uuid() }),
    run: (sql: Sql, userId: string, i: any) => getJob(sql, userId, i.jobId),
  },
  cancel_job: {
    description: "Stop a job.",
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
