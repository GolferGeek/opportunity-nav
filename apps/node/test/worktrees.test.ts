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

test("an Antigravity failure says why it failed instead of a generic error", async t => {
  const { sys, home, job } = await fixture(t);
  const worker = join(home, "fake-agy");
  const run = async (result: object) => {
    await writeFile(worker, `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '${JSON.stringify({ event: "result", result })}'\n`);
    await chmod(worker, 0o755);
    const events: unknown[] = [];
    const turn = { turnId: randomUUID(), leaseId: randomUUID(), leaseExpiresAt: "", kind: "start" as const,
      job: { ...job, id: randomUUID(), provider: "agy" as const } };
    return { outcome: await runWorker(sys, worker, turn, new AbortController().signal, event => events.push(event)), events };
  };

  const refused = await run({ status: "SUCCESS", response: "", denied_actions: [{ action: "command", display_name: "Bash" }] });
  assert.ok(refused.events.some(event => JSON.stringify(event).includes("Antigravity could not get permission to run Bash.")));
  assert.deepEqual(refused.outcome, { type: "error", code: "provider_error",
    message: "Antigravity could not get permission to run Bash.", retryable: false });
  assert.deepEqual((await run({ status: "SUCCESS", response: "" })).outcome, { type: "error", code: "provider_error",
    message: "Antigravity stopped without an answer.", retryable: false });
  assert.deepEqual((await run({ status: "ERROR", error: "Model overloaded,\n try later" })).outcome, { type: "error",
    code: "provider_error", message: "Model overloaded, try later", retryable: false });
  // Known causes keep their own plain message.
  assert.deepEqual((await run({ status: "ERROR", error: "Rate limit exceeded" })).outcome, { type: "error",
    code: "rate_limited", message: "The worker reached its usage limit.", retryable: true });
});

/** Run a fake worker that prints `lines` on stdout, `stderr` on stderr, then exits with `code`. */
async function fakeRun(t: TestContext, provider: "claude" | "codex", lines: object[], stderr = "", code = 0) {
  const { sys, home, job } = await fixture(t);
  const worker = join(home, `fake-${provider}`);
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  await writeFile(worker, ["#!/bin/sh", "cat > /dev/null",
    ...lines.map(line => `printf '%s\\n' ${quote(JSON.stringify(line))}`),
    ...(stderr ? [`printf '%s\\n' ${quote(stderr)} >&2`] : []), `exit ${code}`].join("\n") + "\n");
  await chmod(worker, 0o755);
  const events: unknown[] = [];
  const turn = { turnId: randomUUID(), leaseId: randomUUID(), leaseExpiresAt: "", kind: "start" as const,
    job: { ...job, id: randomUUID(), provider } };
  return { outcome: await runWorker(sys, worker, turn, new AbortController().signal, event => events.push(event)), events };
}

const providerError = (message: string) => ({ type: "error", code: "provider_error", message, retryable: false });
const crashed = (message: string) => ({ type: "error", code: "worker_crashed", message, retryable: false });

test("a Claude failure says why it failed instead of a generic error", async t => {
  const result = (fields: object) => ({ type: "result", session_id: "s1", ...fields });
  assert.deepEqual((await fakeRun(t, "claude", [result({ subtype: "success", is_error: true,
    result: "API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Overloaded\"}}" })], "", 1)).outcome,
    providerError("API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Overloaded\"}}"));
  assert.deepEqual((await fakeRun(t, "claude", [result({ subtype: "error_max_turns", is_error: true })], "", 1)).outcome,
    providerError("Claude reached its turn limit before finishing."));
  assert.deepEqual((await fakeRun(t, "claude", [result({ subtype: "error_during_execution", is_error: true,
    errors: ["Tool use was interrupted"] })], "", 1)).outcome, providerError("Tool use was interrupted"));
  const refused = await fakeRun(t, "claude", [result({ subtype: "error_during_execution", is_error: true,
    permission_denials: [{ tool_name: "Bash" }] })], "", 1);
  assert.ok(refused.events.some(event => JSON.stringify(event).includes("Claude could not get permission to run Bash.")));
  assert.deepEqual(refused.outcome, providerError("Claude could not get permission to run Bash."));
  // No result at all: how the process ended, with stderr's last useful line.
  assert.deepEqual((await fakeRun(t, "claude", [], "Starting\nError: Invalid model name: claude-nope\nbye", 1)).outcome,
    crashed("Claude exited with code 1: Error: Invalid model name: claude-nope"));
  assert.deepEqual((await fakeRun(t, "claude", [], "", 0)).outcome,
    { type: "error", code: "worker_crashed", message: "Claude stopped before finishing.", retryable: false });
  // Known causes keep their own plain message.
  assert.deepEqual((await fakeRun(t, "claude", [result({ is_error: true, result: "Invalid API key · Please run /login" })], "", 1)).outcome,
    { type: "error", code: "auth_required", message: "Sign in to the worker and try again.", retryable: false });
  assert.deepEqual((await fakeRun(t, "claude", [result({ is_error: true, result: "Claude AI usage limit reached|1700000000" })], "", 1)).outcome,
    { type: "error", code: "rate_limited", message: "The worker reached its usage limit.", retryable: true });
});

test("a Codex failure says why it failed instead of a generic error", async t => {
  const started = { type: "thread.started", thread_id: "t1" };
  const wrapped = JSON.stringify({ type: "error", status: 400,
    error: { type: "invalid_request_error", message: "The 'gpt-nope' model is not supported when using Codex with a ChatGPT account." } });
  assert.deepEqual((await fakeRun(t, "codex", [started, { type: "error", message: wrapped },
    { type: "turn.failed", error: { message: wrapped } }], "", 1)).outcome,
    providerError("The 'gpt-nope' model is not supported when using Codex with a ChatGPT account."));
  assert.deepEqual((await fakeRun(t, "codex", [started,
    { type: "turn.failed", error: { message: "stream disconnected before completion: error sending request" } }], "", 1)).outcome,
    providerError("stream disconnected before completion: error sending request"));
  // A lone error event and a nonzero exit.
  assert.deepEqual((await fakeRun(t, "codex", [started, { type: "error", message: "Sandbox denied: could not start seatbelt" }], "", 1)).outcome,
    crashed("Codex exited with code 1: Sandbox denied: could not start seatbelt"));
  assert.deepEqual((await fakeRun(t, "codex", [], "Error: unexpected argument '--nope' found", 2)).outcome,
    crashed("Codex exited with code 2: Error: unexpected argument '--nope' found"));
  // Known causes keep their own plain message.
  assert.deepEqual((await fakeRun(t, "codex", [started, { type: "turn.failed",
    error: { message: "You've hit your usage limit. Try again later." } }], "", 1)).outcome,
    { type: "error", code: "rate_limited", message: "The worker reached its usage limit.", retryable: true });
});

test("a worker that can't start says so", async t => {
  const { sys, home, job } = await fixture(t);
  const turn = { turnId: randomUUID(), leaseId: randomUUID(), leaseExpiresAt: "", kind: "start" as const, job };
  assert.deepEqual(await runWorker(sys, join(home, "missing-claude"), turn, new AbortController().signal, () => {}),
    { type: "error", code: "worker_crashed", message: "Claude could not start (ENOENT).", retryable: false });
});

/** A checkout cloned from a bare origin, and a second clone to move origin on with. */
async function pushFixture(t: TestContext) {
  const { sys, home, data, checkout: seed, job } = await fixture(t);
  const origin = join(home, "origin.git");
  git(home, "clone", "--quiet", "--bare", seed, origin);
  const checkout = join(home, "clone");
  git(home, "clone", "--quiet", origin, checkout);
  const other = join(home, "other");
  git(home, "clone", "--quiet", origin, other);
  for (const repo of [checkout, other]) {
    git(repo, "config", "user.name", "Test User");
    git(repo, "config", "user.email", "test@example.com");
  }
  const worker = join(home, "fake-codex");
  await writeFile(worker, [
    "#!/bin/sh",
    "cat > /dev/null",
    "echo fixed > fix.txt",
    "echo '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Done.\"}}'",
    "echo '{\"type\":\"turn.completed\",\"usage\":{}}'",
  ].join("\n") + "\n");
  await chmod(worker, 0o755);
  const spec: JobSpec = { ...job, checkoutPath: checkout, provider: "codex", title: "Fix it", push: true };
  const run = async () => {
    const events: { type: string; text?: string }[] = [];
    const turn = { turnId: randomUUID(), leaseId: randomUUID(), leaseExpiresAt: "", kind: "start" as const, job: spec };
    const outcome = await runWorker(sys, worker, turn, new AbortController().signal, event => events.push(event as any));
    return { outcome, progress: events.filter(e => e.type === "progress").map(e => e.text!) };
  };
  const moveOrigin = async (file: string, text: string) => {
    git(other, "pull", "--quiet");
    await writeFile(join(other, file), text);
    git(other, "add", file);
    git(other, "commit", "--quiet", "-m", `Elsewhere: ${file}`);
    git(other, "push", "--quiet", "origin", "main");
  };
  return { sys, data, origin, checkout, spec, run, moveOrigin };
}

test("a job that pushes starts from origin's branch and lands its work there", async t => {
  const { origin, checkout, run, moveOrigin } = await pushFixture(t);
  // The checkout is behind origin; the job still starts from origin's main.
  await moveOrigin("before.txt", "pushed before the job\n");
  const { outcome, progress } = await run();
  assert.deepEqual(outcome, { type: "result", summary: "Done." });
  const sha = git(origin, "rev-parse", "--short", "main");
  assert.equal(progress.at(-1), `Pushed to main as ${sha}.`);
  assert.equal(git(origin, "show", "--name-only", "--format=", "main"), "fix.txt");
  assert.equal(git(origin, "log", "-1", "--format=%s", "main~1"), "Elsewhere: before.txt");
  // The checkout itself is left alone.
  assert.equal(git(checkout, "status", "--porcelain"), "");
  assert.equal(git(checkout, "log", "-1", "--format=%s"), "Initial commit");
});

test("a job that pushes rebases onto origin when it moved on while it ran", async t => {
  const { origin, spec, run, moveOrigin, sys } = await pushFixture(t);
  // The worktree exists from an earlier turn, then origin moves on.
  await (await openWorktree(sys, spec)).release();
  await moveOrigin("during.txt", "pushed during the job\n");
  const { progress } = await run();
  assert.match(progress.at(-1)!, /^Pushed to main as [a-f0-9]+\.$/);
  assert.equal(git(origin, "log", "-2", "--format=%s", "main"), "Fix it\nElsewhere: during.txt");
});

test("a job that pushes falls back to its own branch when its work conflicts with origin", async t => {
  const { origin, spec, run, moveOrigin, sys } = await pushFixture(t);
  await (await openWorktree(sys, spec)).release();
  await moveOrigin("fix.txt", "someone else's fix\n");
  const branch = `opnav/${spec.id.slice(0, 8)}`;
  const { progress } = await run();
  assert.equal(progress.at(-1), `main moved on, and the work doesn't rebase cleanly onto it. Pushed the work to branch ${branch} instead.`);
  assert.equal(git(origin, "show", "main:fix.txt"), "someone else's fix");
  assert.equal(git(origin, "show", `${branch}:fix.txt`), "fixed");
});

test("a job without push never pushes", async t => {
  const { origin, spec, run } = await pushFixture(t);
  spec.push = false;
  const before = git(origin, "rev-parse", "main");
  const { progress } = await run();
  assert.ok(!progress.some(p => /push/i.test(p)));
  assert.equal(git(origin, "rev-parse", "main"), before);
  assert.equal(git(origin, "branch", "--list", "opnav/*"), "");
});
