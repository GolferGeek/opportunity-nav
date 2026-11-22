import { test } from "node:test";
import assert from "node:assert/strict";
import { JobEvent, UsageReport } from "../src/index.ts";

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
