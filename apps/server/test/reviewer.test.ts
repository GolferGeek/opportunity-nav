import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { accountLeft, bestAccount, freeMachines, pickReason, rankReviewers, staleText, type MachineView } from "../src/services/reviewer.ts";

const now = Date.parse("2026-11-23T12:00:00Z");
const later = "2026-11-24T12:00:00Z", earlier = "2026-11-22T12:00:00Z";

describe("usage left", () => {
  test("the tightest window binds", () => {
    assert.equal(accountLeft([
      { unit: "percent", used: 10, resets_at: later },
      { unit: "percent", used: 60, resets_at: later },
    ], now), 40);
  });
  test("a window past its reset time counts as unused", () => {
    assert.equal(accountLeft([{ unit: "percent", used: 100, resets_at: earlier }, { unit: "percent", used: 25 }], now), 75);
  });
  test("capped amounts count by their share of the cap; uncapped and model-only windows are skipped", () => {
    assert.equal(accountLeft([
      { unit: "usd", used: 30, lim: 120 },
      { unit: "usd", used: 500 },
      { unit: "percent", used: 99, model: "fable" },
    ], now), 75);
  });
  test("no usable window means no reading, not 100% left", () => {
    assert.equal(accountLeft([], now), null);
    assert.equal(accountLeft([{ unit: "credits", used: 5 }], now), null);
  });
  test("database strings work too", () => {
    assert.equal(accountLeft([{ unit: "percent", used: "12.5", lim: null, resets_at: new Date(later) }], now), 87.5);
  });
});

describe("rank reviewers", () => {
  test("more usage left wins", () => {
    assert.equal(rankReviewers([{ provider: "agy", left: 30 }, { provider: "codex", left: 70 }])!.provider, "codex");
    assert.equal(rankReviewers([{ provider: "agy", left: 70 }, { provider: "codex", left: 30 }])!.provider, "agy");
  });
  test("a tie goes to the first", () => {
    assert.equal(rankReviewers([{ provider: "agy", left: 50 }, { provider: "codex", left: 50 }])!.provider, "agy");
  });
  test("one that can't run falls back to the other, even with less left", () => {
    assert.equal(rankReviewers([{ provider: "agy", left: 90, cantRun: "no online machine can run it" }, { provider: "codex", left: 5 }])!.provider, "codex");
  });
  test("no reading ranks below usage left, above empty", () => {
    assert.equal(rankReviewers([{ provider: "agy", left: null }, { provider: "codex", left: 1 }])!.provider, "codex");
    assert.equal(rankReviewers([{ provider: "agy", left: 0 }, { provider: "codex", left: null }])!.provider, "codex");
  });
  test("0% left is never picked, even when it's the only one that can run", () => {
    assert.equal(rankReviewers([{ provider: "agy", left: 0 }, { provider: "codex", left: 80, cantRun: "no online machine can run it" }]), null);
    assert.equal(rankReviewers([{ provider: "agy", left: 0 }, { provider: "codex", left: 0 }]), null);
    assert.equal(rankReviewers([{ provider: "agy", left: 0 }]), null);
    assert.equal(rankReviewers([{ provider: "agy", left: 0 }, { provider: "codex", left: 0.2 }])!.provider, "codex");
  });
  test("Antigravity's Claude and GPT groups don't limit Antigravity", () => {
    const agy = [
      { window_id: "Claude and GPT models:3p-weekly", unit: "percent", used: 100, resets_at: later },
      { window_id: "Gemini:weekly", unit: "percent", used: 40, resets_at: later },
    ];
    assert.equal(accountLeft(agy, now, "agy"), 60);
    assert.equal(accountLeft(agy.slice(0, 1), now, "agy"), null, "only the Claude group: no reading for Gemini");
    assert.equal(accountLeft(agy, now, "codex"), 0, "other agents count every window");
  });
  test("nobody can run: no pick", () => {
    assert.equal(rankReviewers([{ provider: "agy", left: 90, cantRun: "x" }, { provider: "codex", left: 5, cantRun: "y" }]), null);
  });
  test("the reason names both", () => {
    const all = [{ provider: "agy", left: 90, cantRun: "no online machine can run it" }, { provider: "codex", left: 40.4 }];
    assert.equal(pickReason(all[1]!, all), "Codex has 40% left. Antigravity can't run: no online machine can run it.");
  });
  test("the reason says when one is empty, and explains a tie", () => {
    const empty = [{ provider: "agy", left: 0 }, { provider: "codex", left: 0.4 }];
    assert.equal(pickReason(empty[1]!, empty), "Codex has under 1% left. Antigravity can't run: no usage left.");
    const tie = [{ provider: "agy", left: 50 }, { provider: "codex", left: 50 }];
    assert.equal(pickReason(tie[0]!, tie), "Antigravity has 50% left. Codex has 50% left. A tie goes to the first listed.");
  });
});

describe("readings that aren't current", () => {
  test("rank below every current reading, above no reading", () => {
    assert.equal(rankReviewers([{ provider: "agy", left: 90, stale: "read 3 h ago" }, { provider: "codex", left: 5 }])!.provider, "codex");
    assert.equal(rankReviewers([{ provider: "agy", left: 90, stale: "read 3 h ago" }, { provider: "codex", left: null }])!.provider, "agy");
    assert.equal(rankReviewers([{ provider: "agy", left: 20, stale: "x" }, { provider: "codex", left: 60, stale: "y" }])!.provider, "codex");
  });
  test("a stale 0% is still never picked", () => {
    assert.equal(rankReviewers([{ provider: "agy", left: 0, stale: "read 3 h ago" }]), null);
  });
  test("the reply says how old it is", () => {
    const all = [{ provider: "agy", left: 90, stale: "read 3 h ago" }, { provider: "codex", left: 40 }];
    assert.equal(pickReason(all[1]!, all), "Codex has 40% left. Antigravity has 90% left (not current: read 3 h ago).");
  });
  test("why a reading isn't current", () => {
    assert.equal(staleText("ok", "2026-11-23T11:50:00Z", now), undefined);
    assert.equal(staleText("ok", "2026-11-23T09:00:00Z", now), "read 3 h ago");
    assert.equal(staleText("stale", "2026-11-23T11:48:00Z", now), "read 12 min ago");
    assert.equal(staleText("auth_required", "2026-11-19T12:00:00Z", now), "needs a sign-in, read 4 days ago");
    assert.equal(staleText("error", null, now), "never read");
  });
  test("a tie only counts between readings of the same kind", () => {
    const all = [{ provider: "agy", left: 50 }, { provider: "codex", left: 50, stale: "read 3 h ago" }];
    assert.doesNotMatch(pickReason(all[0]!, all), /tie/);
  });
});

describe("accounts and machines", () => {
  test("one account: it counts, whoever reported it, and the job isn't pinned", () => {
    assert.deepEqual(bestAccount([{ left: 40, reportedBy: "m1" }], ["m2"]), { account: { left: 40, reportedBy: "m1" }, machineId: undefined });
  });
  test("more than one: the account a free machine reported counts, and the job goes there", () => {
    const a = { left: 90, reportedBy: "busy" }, b = { left: 30, reportedBy: "free" };
    assert.deepEqual(bestAccount([a, b], ["free"]), { account: b, machineId: "free" });
    assert.deepEqual(bestAccount([a, b], ["free", "busy"]), { account: a, machineId: "busy" });
  });
  test("more than one, none reported by a free machine: the best counts, unpinned", () => {
    const a = { left: 90, reportedBy: "x" }, b = { left: 30, reportedBy: "y" };
    assert.deepEqual(bestAccount([a, b], ["z"]), { account: a, machineId: undefined });
  });
  test("a current account beats a fuller one that isn't", () => {
    const a = { left: 90, stale: "read 3 h ago", reportedBy: "m1" }, b = { left: 30, reportedBy: "m2" };
    assert.equal(bestAccount([a, b], ["m1", "m2"])!.account, b);
  });
  test("no readings: none", () => {
    assert.equal(bestAccount([{ left: null, reportedBy: "m1" }], ["m1"]), null);
  });

  const m = (id: string, over: Partial<MachineView> = {}): MachineView => ({
    id, online: true, revoked: false, tools: [], capacity: 1, running: 0,
    providers: [{ provider: "codex", signedIn: true, canRunJobs: true }], checkouts: [{ remote: "r" }], ...over,
  });
  const want = { remote: "r", needs: [] as string[] };
  test("a machine with a free slot can run now; a busy one can't", () => {
    assert.deepEqual(freeMachines([m("a"), m("b", { running: 1 })], "codex", want), { ids: ["a"] });
    assert.deepEqual(freeMachines([m("a", { running: 1 })], "codex", want), { ids: [], why: "the machine that runs it is busy" });
    assert.deepEqual(freeMachines([m("a", { running: 1 }), m("b", { running: 1 })], "codex", want), { ids: [], why: "every machine that runs it is busy" });
    assert.deepEqual(freeMachines([m("a", { running: 1, capacity: 2 })], "codex", want), { ids: ["a"] });
    assert.deepEqual(freeMachines([m("a", { running: 1 })], "codex", { ...want, machineId: "a" }), { ids: [], why: "that machine is busy" });
  });
  test("the other reasons, in order", () => {
    assert.equal(freeMachines([m("a", { online: false })], "codex", want).why, "no machine is online");
    assert.equal(freeMachines([m("a")], "agy", want).why, "no online machine can run it");
    assert.equal(freeMachines([m("a", { checkouts: [] })], "codex", want).why, "no machine that runs it has this repo");
    assert.equal(freeMachines([m("a")], "codex", { ...want, needs: ["docker", "database"] }).why, "no machine that runs it has docker and database");
  });
});
