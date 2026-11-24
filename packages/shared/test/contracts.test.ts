import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaimRequest, JobEvent, NODE, NodeHeartbeat, PublishResponse, readingIsCurrent, Runner, runsInCloud, UsageReport } from "../src/index.ts";

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
