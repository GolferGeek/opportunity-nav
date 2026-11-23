import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaimRequest, JobEvent, NodeHeartbeat, readingIsCurrent, Runner, UsageReport } from "../src/index.ts";

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
