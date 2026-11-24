import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkoutFor, orderQueue, type Offer, type QueuedRow, type Ranking } from "../src/services/backlog.ts";

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

describe("which checkout a job runs in", () => {
  const legal = "github.com/orchestratorai-io/orchestratorai-local";
  const agents = "github.com/orchestratorai-io/agents-only";
  const home = "/Users/golfergeek";
  // The Studio as it was on 2026-11-23: many hand-made worktrees of a repo, which sort before its own checkout by path.
  const studio: Offer = {
    id: "studio", providers: ["claude"], cloudroomProviders: [], claudeCloud: false, tools: [], localModels: false,
    checkouts: [
      { path: `${home}/projects/agents-only`, remote: agents, branch: "main", linked: false, defaultBranch: "main" },
      { path: `${home}/projects/agents-only-worktrees/bridge-reads`, remote: agents, branch: "feat/bridge-read-only-summaries", linked: true, defaultBranch: "main" },
      { path: `${home}/projects/agents-only-worktrees/c3-rebase`, remote: agents, linked: true, defaultBranch: "main" },
      { path: `${home}/projects/orchestratorai-worktrees/local-admin-models`, remote: legal, branch: "fix/legal-admin-only-model-settings", linked: true, defaultBranch: "main" },
      { path: `${home}/projects/orchestratorai-worktrees/local-admin-wildcard`, remote: legal, branch: "fix/legal-admin-wildcard-scope", linked: true, defaultBranch: "main" },
      { path: `${home}/projects/orchestratorai-worktrees/local-loop-adversarial`, remote: legal, linked: true, defaultBranch: "main" },
      { path: `${home}/projects/orchestratorai/orchestratorai-local`, remote: legal, branch: "main", linked: false, defaultBranch: "main" },
    ].sort((a, b) => a.path.localeCompare(b.path)),
  };

  test("a Legal or agents-only job on the Studio runs in the repo's own checkout on main, not a side worktree", () => {
    assert.deepEqual(checkoutFor(row("l", { repo_remote: legal, push: true }), studio),
      { path: `${home}/projects/orchestratorai/orchestratorai-local`, branch: "main" });
    assert.deepEqual(checkoutFor(row("a", { repo_remote: agents, push: true }), studio),
      { path: `${home}/projects/agents-only`, branch: "main" });
  });

  test("with no checkout on the default branch, the repo's own checkout comes before linked worktrees, and the job still works toward main", () => {
    const m: Offer = { ...studio, checkouts: studio.checkouts.map((c) => c.path.endsWith("/orchestratorai-local") ? { ...c, branch: "chore/x" } : c) };
    assert.deepEqual(checkoutFor(row("l", { repo_remote: legal, push: true }), m),
      { path: `${home}/projects/orchestratorai/orchestratorai-local`, branch: "main" });
    const onlyLinked: Offer = { ...studio, checkouts: studio.checkouts.filter((c) => c.linked) };
    assert.deepEqual(checkoutFor(row("l", { repo_remote: legal, push: true }), onlyLinked),
      { path: `${home}/projects/orchestratorai-worktrees/local-admin-models`, branch: "main" });
  });

  test("a job that names a branch runs in a checkout on it and works toward that branch", () => {
    assert.deepEqual(checkoutFor(row("l", { repo_remote: legal, push: true, branch: "fix/legal-admin-wildcard-scope" }), studio),
      { path: `${home}/projects/orchestratorai-worktrees/local-admin-wildcard`, branch: "fix/legal-admin-wildcard-scope" });
    assert.deepEqual(checkoutFor(row("l", { repo_remote: legal, branch: "nowhere" }), studio), { why: "no checkout on nowhere" });
  });

  test("an older helper that doesn't say which checkouts are linked still gets one on main or master", () => {
    const old: Offer = { ...studio, checkouts: studio.checkouts.map(({ linked: _l, defaultBranch: _d, ...c }) => c) };
    assert.deepEqual(checkoutFor(row("l", { repo_remote: legal, push: true }), old),
      { path: `${home}/projects/orchestratorai/orchestratorai-local`, branch: "main" });
  });
});
