import type { TreeNode } from "./api.ts";

/**
 * An item is unattended when no queued, running or waiting job was started
 * from it. `attended` is the ids the server says something is working on;
 * null while it loads, and then nothing is called unattended yet.
 * Areas and projects are containers, so only items count.
 */
export function isUnattended(node: Pick<TreeNode, "id" | "kind">, attended: ReadonlySet<string> | null): boolean {
  return node.kind === "item" && attended != null && !attended.has(node.id);
}

/** What an unattended item's job is asked to do, to start from: its name, then its notes. */
export function itemPrompt(node: Pick<TreeNode, "title" | "notes">): string {
  const notes = node.notes?.trim();
  return notes ? `${node.title}\n\n${notes}` : node.title;
}

/**
 * Whether an item's page opens its new-job form by itself: once per visit to the
 * item, once it's known whether something is working on it. `seen` is the item
 * the form last decided for, so closing the form keeps it closed. Returns the
 * new `seen`, and whether to open the form now.
 */
export function autoOpen(seen: string | null, nodeId: string, unattended: boolean, known: boolean): { seen: string | null; open: boolean } {
  if (!known || seen === nodeId) return { seen, open: false };
  return { seen: nodeId, open: unattended };
}
