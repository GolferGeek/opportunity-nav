import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { accountLeft, ASSUMED_LEFT, bestMachine, freeMachines, pickReason, rankReviewers, staleText, usageLeft, type AccountReading, type MachineSource, type MachineView } from "../src/services/reviewer.ts";

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

describe("Antigravity's fair share", () => {
  test("with no Gemini reading, Antigravity counts as half left", () => {
    assert.equal(ASSUMED_LEFT.agy, 50);
    const agy = { provider: "agy", left: ASSUMED_LEFT.agy!, assumed: true };
    assert.equal(rankReviewers([agy, { provider: "codex", left: 30 }])!.provider, "agy", "beats Codex with less than half left");
    assert.equal(rankReviewers([agy, { provider: "codex", left: 80 }])!.provider, "codex", "loses to Codex with more than half left");
    assert.equal(rankReviewers([agy, { provider: "codex", left: 90, stale: "read 3 h ago" }])!.provider, "agy", "ranks like a current reading");
    const all = [agy, { provider: "codex", left: 30 }];
    assert.equal(pickReason(agy, all), "Antigravity has no usage reading for its default model (counted as half left). Codex has 30% left.");
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
  const readings = (accounts: AccountReading[], links: Record<string, string | MachineSource> = {}) =>
    ({ accounts, byMachine: new Map(Object.entries(links).map(([m, l]) => [m, typeof l === "string" ? { account: l, stale: accounts.find((a) => a.id === l)?.stale } : l])) });
  test("one account: every machine is on it, and the job isn't pinned", () => {
    const a = { id: "A", left: 40 };
    assert.deepEqual(bestMachine(readings([a], { m1: "A" }), ["m2"], ["m1", "m2"]), { account: a, machineId: undefined });
  });
  test("a free machine's own account counts, and the job goes there", () => {
    const a = { id: "A", left: 90 }, b = { id: "B", left: 30 };
    const r = readings([a, b], { busy: "A", free: "B" });
    assert.deepEqual(bestMachine(r, ["free"], ["busy", "free"]), { account: b, machineId: "free" });
    assert.deepEqual(bestMachine(r, ["free", "busy"], ["busy", "free"]), { account: a, machineId: "busy" });
  });
  test("a reading isn't shared with a machine on another account", () => {
    // m2 runs it but never reported an account; with two accounts known, it has no reading.
    const r = readings([{ id: "A", left: 90 }, { id: "B", left: 30 }], { m1: "A" });
    assert.deepEqual(bestMachine(r, ["m2"], ["m1", "m2"]), { account: null, machineId: "m2" });
    // The account m1 reads doesn't carry over to m2 just because both run the agent.
    assert.equal(bestMachine(readings([{ id: "A", left: 90 }, { id: "B", left: 10 }], { m1: "A", m2: "B" }), ["m2"], ["m1", "m2"]).account!.left, 10);
  });
  test("a machine with no reading beats one whose account is empty", () => {
    const r = readings([{ id: "A", left: 0 }, { id: "B", left: 50 }], { m1: "A" });
    assert.deepEqual(bestMachine(r, ["m1", "m2"], ["m1", "m2"]), { account: null, machineId: "m2" });
  });
  test("a current account beats a fuller one that isn't", () => {
    const a = { id: "A", left: 90, stale: "read 3 h ago" }, b = { id: "B", left: 30 };
    assert.deepEqual(bestMachine(readings([a, b], { m1: "A", m2: "B" }), ["m1", "m2"], ["m1", "m2"]).account, b);
  });
  test("one account, two machines: each machine's own poll decides if it's current or needs a sign-in", () => {
    const a = { id: "A", left: 60 };
    const healthy = { account: "A" }, signIn = { account: "A", stale: "needs a sign-in, read 2 h ago", signIn: true };
    // The review goes only to the healthy machine, whichever is listed first.
    assert.deepEqual(bestMachine(readings([a], { ok: healthy, out: signIn }), ["out", "ok"], ["out", "ok"]), { account: a, machineId: "ok" });
    assert.deepEqual(bestMachine(readings([a], { ok: healthy, out: signIn }), ["ok", "out"], ["ok", "out"]), { account: a, machineId: "ok" });
    // Only the one that needs a sign-in is free: nothing goes out, even though the account's reading is healthy.
    assert.deepEqual(bestMachine(readings([a], { ok: healthy, out: signIn }), ["out"], ["ok", "out"]),
      { account: null, why: "the machine that runs it needs a sign-in" });
    // Both need a sign-in: nothing goes out.
    assert.deepEqual(bestMachine(readings([a], { m1: signIn, m2: signIn }), ["m1", "m2"], ["m1", "m2"]),
      { account: null, why: "every free machine that runs it needs a sign-in" });
    // A machine whose own reading is old ranks as not current, and a current one on the same account wins.
    const old = { account: "A", stale: "read 3 h ago" };
    assert.deepEqual(bestMachine(readings([a], { old, ok: healthy }), ["old", "ok"], ["old", "ok"]), { account: a, machineId: "ok" });
    assert.deepEqual(bestMachine(readings([a], { old, ok: healthy }), ["old"], ["old", "ok"]), { account: { ...a, stale: "read 3 h ago" }, machineId: "old" });
    // Both read it the same way: not pinned.
    assert.deepEqual(bestMachine(readings([a], { m1: healthy, m2: healthy }), ["m2"], ["m1", "m2"]), { account: a, machineId: undefined });
  });
  test("no free machine: the best account overall, for the reply", () => {
    const a = { id: "A", left: 20 }, b = { id: "B", left: 60 };
    assert.deepEqual(bestMachine(readings([a, b], { m1: "A" }), [], ["m1"]), { account: b });
    assert.deepEqual(bestMachine(readings([{ id: "A", left: null }]), [], []), { account: null });
  });

  const m = (id: string, over: Partial<MachineView> = {}): MachineView => ({
    id, online: true, revoked: false, tools: [], capacity: 1, running: 0,
    providers: [{ provider: "codex", signedIn: true, canRunJobs: true }], checkouts: [{ remote: "r" }], ...over,
  });
  const want = { remote: "r", needs: [] as string[] };
  test("a machine with a free slot can run now; a busy one can't", () => {
    assert.deepEqual(freeMachines([m("a"), m("b", { running: 1 })], "codex", want), { ids: ["a"], capable: ["a", "b"] });
    assert.deepEqual(freeMachines([m("a", { running: 1 })], "codex", want), { ids: [], capable: ["a"], why: "the machine that runs it is busy" });
    assert.deepEqual(freeMachines([m("a", { running: 1 }), m("b", { running: 1 })], "codex", want), { ids: [], capable: ["a", "b"], why: "every machine that runs it is busy" });
    assert.deepEqual(freeMachines([m("a", { running: 1, capacity: 2 })], "codex", want), { ids: ["a"], capable: ["a"] });
    assert.deepEqual(freeMachines([m("a", { running: 1 })], "codex", { ...want, machineId: "a" }), { ids: [], capable: ["a"], why: "that machine is busy" });
  });
  test("the other reasons, in order", () => {
    assert.equal(freeMachines([m("a", { online: false })], "codex", want).why, "no machine is online");
    assert.equal(freeMachines([m("a")], "agy", want).why, "no online machine can run it");
    assert.equal(freeMachines([m("a", { checkouts: [] })], "codex", want).why, "no machine that runs it has this repo");
    assert.equal(freeMachines([m("a")], "codex", { ...want, needs: ["docker", "database"] }).why, "no machine that runs it has docker and database");
  });
});

describe("Antigravity's Gemini reading in the picker", () => {
  const claude = [
    { window_id: "Claude and GPT models:3p-weekly", unit: "percent", used: 0, resets_at: later },
    { window_id: "Claude and GPT models:3p-5h", unit: "percent", used: 0, resets_at: later },
  ];
  const gemini = [
    { window_id: "Gemini models:gemini-5h", unit: "percent", used: 25, resets_at: later },
    { window_id: "Gemini models:gemini-weekly", unit: "percent", used: 85, resets_at: later },
  ];
  const pick = (windows: typeof claude, stale?: string) => {
    const r = { accounts: [{ id: "s1", left: accountLeft(windows, now, "agy"), stale }], byMachine: new Map([["m1", { account: "s1", stale }]]) };
    return usageLeft("agy", bestMachine(r, ["m1"], ["m1"]).account);
  };
  test("a real Gemini reading counts, not the stand-in", () => {
    assert.deepEqual(pick([...claude, ...gemini]), { provider: "agy", left: 15, stale: undefined });
    assert.equal(rankReviewers([{ ...pick([...claude, ...gemini]) }, { provider: "codex", left: 30 }])!.provider, "codex",
      "15% Gemini left loses to Codex at 30%, where half left would have won");
  });
  test("a Gemini reading that isn't current still counts, marked so", () => {
    assert.deepEqual(pick(gemini, "read 3 h ago"), { provider: "agy", left: 15, stale: "read 3 h ago" });
  });
  test("only the Claude and GPT allowance: the stand-in", () => {
    assert.deepEqual(pick(claude), { provider: "agy", left: ASSUMED_LEFT.agy, assumed: true });
    assert.deepEqual(usageLeft("agy", null), { provider: "agy", left: ASSUMED_LEFT.agy, assumed: true });
  });
  test("other agents with no reading have none", () => {
    assert.deepEqual(usageLeft("codex", null), { provider: "codex", left: null, stale: undefined });
  });
});
