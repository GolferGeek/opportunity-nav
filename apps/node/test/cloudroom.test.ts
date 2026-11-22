import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { Turn } from "@opnav/shared";
import { cloudroomActivity, cloudroomDetector, runCloudroom } from "../src/cloudroom.ts";
import { system } from "../src/system.ts";
import type { EventContent } from "../src/worker.ts";
import { git, initRepo } from "./fixtures/git.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }, config = {}) {
  const home = await mkdtemp(join(tmpdir(), "opnav-cloudroom-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, ".local/bin");
  const checkout = join(home, "checkout");
  await mkdir(bin, { recursive: true });
  await mkdir(checkout);
  initRepo(checkout);
  git(checkout, "remote", "add", "origin", "https://github.com/example/demo.git");
  await symlink(process.execPath, join(bin, "node"));
  const binary = join(bin, "room-cli");
  await copyFile(new URL("./fixtures/room-cli.mjs", import.meta.url), binary);
  await chmod(binary, 0o700);
  const state = join(home, "state.json");
  await writeFile(state, JSON.stringify(config));
  const sys = system({ home, env: { PATH: [bin, process.env.PATH].join(delimiter),
    ROOM_FIXTURE: state, OPNAV_NODE_TOKEN: "fake-node-credential" } });
  const turn = Turn.parse({ turnId: "f3d94ac3-c9ae-42a2-9473-d524af783106",
    leaseId: "048a600d-938b-4f20-a315-97579c55d864", leaseExpiresAt: new Date().toISOString(), kind: "start",
    job: { id: "4762c297-95c8-4bd7-9249-b11e10826e22", projectId: "fc923fc6-7d68-4d6c-b13f-892212179bf0",
      title: "Build demo", prompt: "Start the demo.", provider: "claude", model: "test-model", effort: "high",
      location: "cloud", runner: "cloudroom", checkoutPath: checkout } });
  async function calls(): Promise<{ args: string[]; prompt?: string; mode?: number }[]> {
    return (await readFile(state + ".calls", "utf8")).trim().split("\n").map(line => JSON.parse(line));
  }
  return { sys, turn, binary, calls };
}

test("Cloudroom progress maps tools and completed agent messages", () => {
  const row = (type: string, item: object) => ({ type, data: { item } });
  assert.equal(cloudroomActivity(row("item/started", { type: "toolCall", tool: "Bash",
    arguments: { command: "npm test\nls" } })), "Ran: npm test");
  assert.equal(cloudroomActivity(row("item/completed", { type: "agentMessage", text: "  All\n good.  " })), "All good.");
  assert.equal(cloudroomActivity(row("item/completed", { type: "fileChange" })), undefined);
  assert.equal(cloudroomActivity(row("item/agentMessage/delta", { type: "agentMessage", text: "Partial" })), undefined);
});

test("Cloudroom detects mapped harnesses once and runs a start turn without a worktree", async t => {
  const { sys, turn, calls } = await fixture(t, {
    output: 'Ready.\n```opnav-needs-input\n{"question":"Confirm account@example.test?"}\n```',
  });
  const detect = cloudroomDetector(sys);
  const [status, cached] = await Promise.all([detect(), detect()]);
  assert.ok(status);
  assert.equal(status, cached);
  assert.deepEqual(status.providers, ["claude", "codex", "agy"]);
  const events: EventContent[] = [];
  const result = await runCloudroom(sys, status.binary, turn, new AbortController().signal, event => events.push(event),
    { email: status.email, pollMs: 1 });
  assert.deepEqual(result, { type: "needs_input", needsInput: { question: "Confirm [redacted]?" } });
  assert.deepEqual(events, [{ type: "session", providerSessionId: "thr_demo" },
    { type: "progress", text: "Ran: echo [redacted]" }, { type: "usage", inputTokens: 10, outputTokens: 5 }]);
  const recorded = await calls();
  assert.equal(recorded.filter(({ args }) => args[0] === "cloud").length, 1);
  assert.ok(!recorded.some(({ args }) => args[1] === "create"));
  const spawn = recorded.find(({ args }) => args[1] === "spawn")!;
  assert.deepEqual(spawn.args, ["thread", "spawn", "--project", "proj_demo", "--machine", "cloud", "--provider", "claude-code",
    "--model", "test-model", "--reasoning-level", "high", "--title", "Build demo", "--request-id", `opnav-${turn.turnId}`,
    "--prompt-file", spawn.args.at(-2), "--json"]);
  assert.equal(spawn.mode, 0o600);
  assert.match(spawn.prompt!, /^Start the demo\./);
  assert.match(spawn.prompt!, /opnav-needs-input/);
  assert.match(spawn.prompt!, /default branch on GitHub/);
  assert.match(spawn.prompt!, /opnav\/4762c297.*\n?/);
  assert.match(spawn.prompt!, /git push -u origin HEAD/);
  await assert.rejects(readFile(spawn.args.at(-2)!), { code: "ENOENT" });
  assert.equal(git(turn.job.checkoutPath, "worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree ")).length, 1);
});

test("Cloudroom continues after the previous log, including after a lease retry", async t => {
  const { sys, binary, turn, calls } = await fixture(t, { resume: true });
  const continued = Turn.parse({ ...turn, kind: "continue", providerSessionId: "thr_demo",
    answer: { answerId: turn.leaseId, questionId: turn.leaseId, text: "Go ahead." } });
  for (let attempt = 0; attempt < 2; attempt++) {
    const events: EventContent[] = [];
    assert.deepEqual(await runCloudroom(sys, binary, continued, new AbortController().signal, event => events.push(event)),
      { type: "result", summary: "Done." });
    assert.deepEqual(events, [{ type: "usage", inputTokens: 3, outputTokens: 2 }]);
  }
  const recorded = await calls();
  const tells = recorded.filter(({ args }) => args[1] === "tell");
  assert.equal(tells.length, 2);
  for (const { args, prompt } of tells) {
    assert.deepEqual(args, ["thread", "tell", "thr_demo", "--message-file", args[4], "--request-id",
      `opnav-${turn.turnId}`, "--json"]);
    assert.match(prompt!, /^Go ahead\./);
    assert.doesNotMatch(prompt!, /default branch on GitHub/);
  }
  assert.equal(recorded.filter(({ args }) => args[1] === "log" && args[5] === "3").length, 2);
});

test("Cloudroom creates missing projects and stops a thread when cancelled during spawn", async t => {
  const { sys, binary, turn, calls } = await fixture(t, { create: true, wait: true });
  const controller = new AbortController();
  const result = await runCloudroom(sys, binary, { ...turn, job: { ...turn.job, model: undefined, effort: undefined } },
    controller.signal, event => { if (event.type === "session") controller.abort(); });
  assert.equal(result.type === "error" && result.code, "cancelled");
  const recorded = await calls();
  assert.deepEqual(recorded.find(({ args }) => args[1] === "create")?.args,
    ["project", "create", "--name", "demo", "--root", turn.job.checkoutPath, "--json"]);
  assert.ok(!recorded.find(({ args }) => args[1] === "spawn")!.args.includes("--model"));
  assert.deepEqual(recorded.at(-1)?.args, ["thread", "stop", "thr_demo"]);
});

test("Cloudroom surfaces pending questions, provisioning failures, and rate limits", async t => {
  const cases = [
    [{ wait: true, question: "Which branch?" }, { type: "needs_input", needsInput: { question: "Which branch?" } }],
    [{ wait: true }, { type: "error", code: "provider_error", retryable: false, message: "Cloudroom did not finish provisioning the sandbox." }],
    [{ wait: true, status: "failed" }, { type: "error", code: "provider_error", retryable: false, message: "The Cloudroom thread failed." }],
    [{ error: "HTTP 429" }, { type: "error", code: "rate_limited", retryable: true, message: "The worker reached its usage limit." }],
  ] as const;
  for (const [config, expected] of cases) {
    const { sys, binary, turn } = await fixture(t, config);
    assert.deepEqual(await runCloudroom(sys, binary, turn, new AbortController().signal, () => {}, { provisioningMs: 0 }), expected);
  }
});
