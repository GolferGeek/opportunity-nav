import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { JobSpec } from "@opnav/shared";
import { system } from "../src/system.ts";
import { agyOutcome, runWorker, workerArgs } from "../src/worker.ts";
import { openWorktree, pruneWorktrees } from "../src/worktrees.ts";
import { git, initRepo } from "./fixtures/git.ts";

async function fixture(t: TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "opnav-worktree-test-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const checkout = join(home, "project");
  const data = join(home, "data");
  await mkdir(checkout);
  initRepo(checkout);
  const sys = system({ home, env: { PATH: process.env.PATH, XDG_DATA_HOME: data } });
  const job: JobSpec = { id: randomUUID(), projectId: randomUUID(), checkoutPath: checkout,
    title: "Test", prompt: "Test the worktree", provider: "claude", runner: "direct", location: "cloud" };
  return { sys, home, data, checkout, job };
}

test("creates a worktree from checkout HEAD and keeps it available across turns", async t => {
  const { sys, data, checkout, job } = await fixture(t);
  await writeFile(join(checkout, "personal.txt"), "personal edits");
  const head = git(checkout, "rev-parse", "HEAD");
  const worktree = await openWorktree(sys, job);
  assert.equal(worktree.path, join(data, "opportunity-nav", "worktrees", job.id.slice(0, 8)));
  assert.equal(git(worktree.path, "rev-parse", "HEAD"), head);
  assert.equal(git(worktree.path, "branch", "--show-current"), worktree.branch);
  await assert.rejects(readFile(join(worktree.path, "personal.txt")), { code: "ENOENT" });
  await assert.rejects(openWorktree(sys, job));
  assert.equal(await pruneWorktrees(sys), 0);
  await writeFile(join(worktree.path, "job.txt"), "work in progress");
  await worktree.release();
  const resumed = await openWorktree(sys, job);
  assert.equal(resumed.path, worktree.path);
  assert.equal(await readFile(join(resumed.path, "job.txt"), "utf8"), "work in progress");
  await resumed.release();
  assert.equal(git(checkout, "branch", "--show-current"), "main");
  assert.equal(git(checkout, "status", "--porcelain"), "?? personal.txt");
});

test("prunes merged and old clean worktrees while preserving unmerged commits and dirty files", async t => {
  const { sys, checkout, job } = await fixture(t);
  const merged = await openWorktree(sys, job);
  git(merged.path, "commit", "--quiet", "--allow-empty", "-m", "Completed job");
  git(checkout, "merge", "--quiet", "--ff-only", merged.branch);
  await merged.release();

  const oldJob = { ...job, id: randomUUID() };
  const old = await openWorktree(sys, oldJob);
  git(old.path, "commit", "--quiet", "--allow-empty", "-m", "Unmerged job work");
  const unmerged = git(old.path, "rev-parse", "HEAD");
  await old.release();

  const dirty = await openWorktree(sys, { ...job, id: randomUUID() });
  await writeFile(join(dirty.path, "draft.txt"), "Keep this");
  await dirty.release();

  assert.equal(await pruneWorktrees(sys), 1);
  assert.equal(git(old.path, "rev-parse", "HEAD"), unmerged);
  assert.equal(await pruneWorktrees(sys, Date.now() + 15 * 86_400_000), 1);
  assert.equal(git(checkout, "rev-parse", old.branch), unmerged);
  assert.equal(await readFile(join(dirty.path, "draft.txt"), "utf8"), "Keep this");
  await assert.rejects(readFile(join(old.path, ".git")), { code: "ENOENT" });
  const restored = await openWorktree(sys, oldJob);
  assert.equal(git(restored.path, "rev-parse", "HEAD"), unmerged);
  await restored.release();
});

test("commits what a sandboxed agent leaves in its worktree when the turn ends", async t => {
  const { sys, home, checkout, job } = await fixture(t);
  // Like Codex in workspace-write: it edits files but can't write .git/worktrees/<id>, so it can't commit.
  const worker = join(home, "fake-codex");
  await writeFile(worker, [
    "#!/bin/sh",
    "cat > /dev/null",
    "echo fixed > fix.txt",
    `ln -s ${JSON.stringify(join(checkout, "node_modules"))} node_modules`,
    "echo '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Done.\"}}'",
    "echo '{\"type\":\"turn.completed\",\"usage\":{}}'",
  ].join("\n") + "\n");
  await chmod(worker, 0o755);
  const events: unknown[] = [];
  const spec = { ...job, provider: "codex" as const, title: "Fix the thing\nmore detail" };
  const turn = { turnId: randomUUID(), leaseId: randomUUID(), leaseExpiresAt: "", kind: "start" as const, job: spec };
  const outcome = await runWorker(sys, worker, turn, new AbortController().signal, event => events.push(event));
  assert.deepEqual(outcome, { type: "result", summary: "Done." });

  const path = join(home, "data", "opportunity-nav", "worktrees", job.id.slice(0, 8));
  const sha = git(path, "rev-parse", "--short", "HEAD");
  assert.ok(events.some(event => JSON.stringify(event).includes(`Committed the changes Codex left, as ${sha}.`)));
  assert.equal(git(path, "log", "-1", "--format=%s"), "Fix the thing");
  assert.match(git(path, "log", "-1", "--format=%b"), /Codex left these changes uncommitted \(job [a-f0-9]{8}\)/);
  assert.equal(git(path, "show", "--name-only", "--format=", "HEAD"), "fix.txt");
  assert.equal(git(path, "status", "--porcelain"), "?? node_modules");
  assert.equal(git(checkout, "status", "--porcelain"), "");

  // A later turn that changes nothing leaves the branch alone.
  await rm(worker);
  await writeFile(worker, "#!/bin/sh\ncat > /dev/null\necho '{\"type\":\"turn.completed\",\"usage\":{}}'\n");
  await chmod(worker, 0o755);
  await runWorker(sys, worker, turn, new AbortController().signal, () => {});
  assert.equal(git(path, "rev-parse", "--short", "HEAD"), sha);
});

test("ends the turn with an error when it cannot create an isolated worktree", async t => {
  const { sys, home, checkout, job } = await fixture(t);
  const run = (spec: JobSpec, env = sys.env) =>
    runWorker({ ...sys, env }, "missing-worker", {
      turnId: randomUUID(), leaseId: randomUUID(), leaseExpiresAt: "", kind: "start", job: spec,
    }, new AbortController().signal, () => assert.fail("Worker should not emit events"));
  assert.deepEqual(await run({ ...job, checkoutPath: home }), {
    type: "error", code: "other", message: "The project checkout is not a Git repository.", retryable: false,
  });
  assert.deepEqual(await run(job, { ...sys.env, XDG_DATA_HOME: checkout }), {
    type: "error", code: "other", message: "Could not prepare a separate Git worktree for this job.", retryable: false,
  });
  assert.equal(git(checkout, "status", "--porcelain"), "");
});

test("Antigravity in edit mode may run commands inside its sandbox, and an empty SUCCESS after a refusal is a failure", () => {
  const turn = { turnId: randomUUID(), leaseId: randomUUID(), leaseExpiresAt: new Date().toISOString(), kind: "start" as const,
    job: { id: randomUUID(), projectId: randomUUID(), checkoutPath: "/tmp/x", title: "Review", prompt: "Review it",
      provider: "agy" as const, runner: "direct" as const, location: "cloud" as const } };
  const args = workerArgs(turn, "edit");
  assert.ok(args.includes("--sandbox"));
  assert.deepEqual(JSON.parse(args[args.indexOf("--settings") + 1]!), { permissions: { allow: ["command(*)", "read_file(*)"] } });
  assert.ok(!workerArgs(turn, "full").includes("--settings"));

  const refused = agyOutcome({ status: "SUCCESS", response: "", denied_actions: [{ action: "command", display_name: "Bash" }] });
  assert.equal(refused.failed, true);
  assert.equal(refused.blocked, "Antigravity could not get permission to run Bash.");
  assert.equal(agyOutcome({ status: "SUCCESS", response: "" }).failed, true);
  assert.deepEqual(agyOutcome({ status: "SUCCESS", response: "Looks good." }), { failed: false, result: "Looks good.", blocked: undefined });
  assert.equal(agyOutcome({ status: "ERROR", error: "boom" }).failure, "boom");
});
