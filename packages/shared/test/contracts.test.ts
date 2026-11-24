import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaimRequest, JobEvent, modelLabel, NODE, NodeHeartbeat, PublishResponse, readingIsCurrent, Runner, runsInCloud, runsOn, UsageReport } from "../src/index.ts";

test("usage report rejects a token-shaped account key", () => {
  const r = UsageReport.safeParse({
    observedAt: new Date().toISOString(),
    accounts: [{ provider: "claude", accountKey: "sk-ant-oat01-abc", status: "ok", windows: [] }],
  });
  assert.equal(r.success, false);
});

test("needs_input event parses", () => {
  const e = JobEvent.parse({ type: "needs_input", seq: 3, at: new Date().toISOString(), needsInput: { question: "Which database?" } });
  assert.equal(e.type, "needs_input");
});

test("a helper that doesn't say runs one job at a time", () => {
  const hb = NodeHeartbeat.parse({ hostname: "h", platform: "linux", arch: "arm64", helperVersion: "0.1.0", providers: [] });
  assert.equal(hb.capacity, 1);
});

test("a reading is current only when its last poll was good and recent", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  assert.equal(readingIsCurrent("ok", "2026-11-23T11:50:00Z", now), true);
  assert.equal(readingIsCurrent("ok", "2026-11-23T11:00:00Z", now), false, "an hour old");
  assert.equal(readingIsCurrent("stale", "2026-11-23T11:59:00Z", now), false);
  assert.equal(readingIsCurrent("auth_required", "2026-11-23T11:59:00Z", now), false);
  assert.equal(readingIsCurrent("ok", null, now), false);
});

test("a node can offer only Claude cloud jobs", () => {
  assert.equal(Runner.parse("claude-cloud"), "claude-cloud");
  assert.equal(ClaimRequest.parse({ providers: [], claudeCloud: true }).claudeCloud, true);
  assert.equal(ClaimRequest.safeParse({ providers: [] }).success, false);
  const hb = NodeHeartbeat.parse({ hostname: "h", platform: "darwin", arch: "arm64", helperVersion: "0.1.0", providers: [],
    claudeCloud: { ready: false, reason: "not set up" } });
  assert.deepEqual(hb.claudeCloud, { ready: false, reason: "not set up" });
});

test("cloud jobs have their own slots: a claim can have no local room and still offer cloud room", () => {
  assert.equal(runsInCloud("direct"), false);
  assert.equal(runsInCloud("claude-cloud"), true);
  assert.equal(runsInCloud("cloudroom"), true);
  const c = ClaimRequest.parse({ providers: ["claude"], claudeCloud: true, max: 0, cloudMax: 2 });
  assert.equal(c.max, 0);
  assert.equal(c.cloudMax, 2);
  assert.equal(ClaimRequest.safeParse({ providers: ["claude"], max: 0 }).success, false, "no room at all");
  assert.equal(ClaimRequest.parse({ providers: ["claude"] }).cloudMax, undefined, "older helpers don't send it");
  const hb = NodeHeartbeat.parse({ hostname: "h", platform: "darwin", arch: "arm64", helperVersion: "0.1.0", providers: [], capacity: 3, cloudCapacity: 2 });
  assert.equal(hb.cloudCapacity, 2);
});

test("a helper asks before publishing, and the answer says whether a cancel won", () => {
  assert.equal(NODE.publish("j1"), "/api/node/jobs/j1/publish");
  assert.deepEqual(PublishResponse.parse({ publish: false, cancel: true }), { publish: false, cancel: true });
  assert.equal(PublishResponse.safeParse({ publish: true }).success, false);
});

test("a checkout says whether it's a linked worktree and what origin's default branch is; older helpers omit both", () => {
  const base = { hostname: "h", platform: "darwin", arch: "arm64", helperVersion: "0.1.0", providers: [] };
  const hb = NodeHeartbeat.parse({ ...base, checkouts: [
    { path: "/p/wt", remote: "github.com/o/r", branch: "fix/x", linked: true, defaultBranch: "main" },
    { path: "/p/old", remote: "github.com/o/r", branch: "main" },
  ] });
  assert.equal(hb.checkouts[0]!.linked, true);
  assert.equal(hb.checkouts[0]!.defaultBranch, "main");
  assert.equal(hb.checkouts[1]!.linked, undefined);
});

test("a session event may say which model the agent runs; older events without it still parse", () => {
  const at = new Date().toISOString();
  const e = JobEvent.parse({ type: "session", seq: 0, at, providerSessionId: "s", model: "claude-opus-4-5-20251101" });
  assert.equal(e.type === "session" && e.model, "claude-opus-4-5-20251101");
  assert.equal(JobEvent.safeParse({ type: "session", seq: 0, at, providerSessionId: "s" }).success, true);
  assert.equal(JobEvent.safeParse({ type: "session", seq: 0, at, providerSessionId: "s", model: "" }).success, false);
});

test("a job's model reads in plain words, and unknown says default model", () => {
  assert.equal(modelLabel("claude", "claude-opus-4-5-20251101"), "claude-opus-4-5");
  assert.equal(modelLabel("claude", "opus"), "claude-opus");
  assert.equal(modelLabel("codex", "gpt-5"), "gpt-5 codex");
  assert.equal(modelLabel("codex", "gpt-5.1-codex-max"), "gpt-5.1-codex-max");
  assert.equal(modelLabel("agy", "gemini-3-pro"), "gemini-3-pro via agy");
  assert.equal(modelLabel("ollama", "qwen3:8b"), "qwen3:8b via Ollama");
  assert.equal(modelLabel("codex", null), "default model");
  assert.equal(modelLabel("claude", " "), "default model");
});

test("runsOn prefers the reported model and says local on the machine, or which cloud", () => {
  assert.deepEqual(runsOn({ provider: "claude", model: "opus", reportedModel: "claude-opus-4-5-20251101", runner: "direct", machine: "Studio" }),
    { model: "claude-opus-4-5", where: "local on Studio" });
  assert.equal(runsOn({ provider: "claude", runner: "direct", machine: "GG-MacStudio.local" }).where, "local on GG-MacStudio", "short enough for a card");
  assert.deepEqual(runsOn({ provider: "codex", runner: "direct", machine: null }), { model: "default model", where: "local" });
  assert.deepEqual(runsOn({ provider: "claude", runner: "claude-cloud", machine: "Studio" }), { model: "default model", where: "cloud (Claude)" });
  assert.deepEqual(runsOn({ provider: "codex", model: "gpt-5", runner: "cloudroom", machine: "Omarchy" }), { model: "gpt-5 codex", where: "cloud (Cloudroom)" });
});
