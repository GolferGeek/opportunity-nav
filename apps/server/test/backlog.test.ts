import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { orderQueue, type QueuedRow, type Ranking } from "../src/services/backlog.ts";

const row = (id: string, o: Partial<QueuedRow>): QueuedRow => ({
  id, kind: "start", project_id: "p1", repo_remote: "r", provider: "claude", runner: "direct", needs: [], node_id: null,
  backlog: true, app: null, position: 1, held: false, after: [], local_model: false, push: false, branch: null,
  checkout_path: null, checkout_branch: null, created_at: "2026-11-23T00:00:00Z", ...o,
});

describe("backlog order", () => {
  const rk: Ranking = { apps: new Map([["legal", 0]]), tree: new Map([["p1", 0], ["p2", 1], ["p3", 2]]), titles: new Map([["p1", "One"], ["p2", "Two"], ["p3", "Three"]]) };

  test("resumed, then started right away, then ranked apps, then unranked apps as whole groups", () => {
    const rows = [
      row("x2", { app: "X", project_id: "p3", position: 2 }),
      row("y1", { app: "Y", project_id: "p2", position: 1 }),
      row("x1", { app: "X", project_id: "p1", position: 1 }),
      row("l2", { app: "Legal", project_id: "p3", position: 2 }),
      row("l1", { app: "legal", project_id: "p3", position: 1 }),
      row("now", { backlog: false }),
      row("resume", { kind: "continue", backlog: true, app: "Y" }),
    ];
    assert.deepEqual(orderQueue(rows, rk).map((r) => r.id), ["resume", "now", "l1", "l2", "x1", "x2", "y1"]);
  });
});
