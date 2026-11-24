import { test } from "node:test";
import assert from "node:assert/strict";
import { ANY_MACHINE, keepWhere, whereOptions, whereToJob, type MachineLite } from "../src/where.ts";

const label = (p: string) => ({ claude: "Claude", codex: "Codex", ollama: "Ollama" })[p] ?? p;
const studio: MachineLite = {
  id: "m1", name: "Mac-Studio.local", online: true, takingJobs: true,
  providers: [{ provider: "claude", signedIn: true, canRunJobs: true }, { provider: "codex", signedIn: true, canRunJobs: true }],
  cloudroom: { providers: ["claude", "codex"] },
  claudeCloud: { ready: true, repos: ["github.com/me/app"] },
};
const omarchy: MachineLite = { id: "m2", name: "omarchy", online: true, providers: [{ provider: "claude", signedIn: true, canRunJobs: true }] };
const values = (o: { value: string }[]) => o.map((x) => x.value);

test("any machine comes first, so the default needs no clicks", () => {
  const opts = whereOptions([], "claude", null, label);
  assert.deepEqual(opts, [{ value: ANY_MACHINE, label: "Any machine" }]);
  assert.deepEqual(whereToJob(ANY_MACHINE), { runner: "direct" });
});

test("every option is in the one list: machines, then Claude's cloud, then Cloudroom", () => {
  const opts = whereOptions([studio, omarchy], "claude", "github.com/me/app", label);
  assert.deepEqual(values(opts), ["any", "machine:m1", "machine:m2", "claude-cloud", "cloudroom"]);
  assert.equal(opts[1].label, "On Mac-Studio");
  assert.ok(opts.every((o) => !o.disabled));
});

test("Claude's cloud shows only when a routine covers the project's repo", () => {
  assert.ok(!values(whereOptions([studio], "claude", "github.com/me/other", label)).includes("claude-cloud"));
  assert.ok(!values(whereOptions([studio], "claude", null, label)).includes("claude-cloud"));
  assert.ok(!values(whereOptions([{ ...studio, claudeCloud: { ready: false, repos: ["github.com/me/app"] } }], "claude", "github.com/me/app", label)).includes("claude-cloud"));
});

test("offline machines and machines not taking jobs aren't offered, and their clouds don't count", () => {
  const off = { ...studio, online: false };
  assert.deepEqual(values(whereOptions([off], "claude", "github.com/me/app", label)), ["any"]);
  assert.deepEqual(values(whereOptions([{ ...studio, takingJobs: false }], "claude", "github.com/me/app", label)), ["any", "claude-cloud", "cloudroom"]);
});

test("choices an agent can't use are greyed out and fall back to any machine", () => {
  const opts = whereOptions([studio, omarchy], "codex", "github.com/me/app", label);
  const by = Object.fromEntries(opts.map((o) => [o.value, o]));
  assert.equal(by["machine:m2"].disabled, true);
  assert.equal(by["machine:m2"].label, "On omarchy (no Codex)");
  assert.equal(by["claude-cloud"].disabled, true);
  assert.equal(by["cloudroom"].disabled, false);
  assert.equal(keepWhere("claude-cloud", opts), ANY_MACHINE);
  assert.equal(keepWhere("machine:m2", opts), ANY_MACHINE);
  assert.equal(keepWhere("cloudroom", opts), "cloudroom");
  assert.equal(keepWhere("machine:gone", opts), ANY_MACHINE);
});

test("the choice becomes a runner and a pinned machine", () => {
  assert.deepEqual(whereToJob("machine:m1"), { runner: "direct", machineId: "m1" });
  assert.deepEqual(whereToJob("claude-cloud"), { runner: "claude-cloud" });
  assert.deepEqual(whereToJob("cloudroom"), { runner: "cloudroom" });
});
