import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { accountLeft, pickReason, rankReviewers } from "../src/services/reviewer.ts";

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
  test("nobody can run: no pick", () => {
    assert.equal(rankReviewers([{ provider: "agy", left: 90, cantRun: "x" }, { provider: "codex", left: 5, cantRun: "y" }]), null);
  });
  test("the reason names both", () => {
    const all = [{ provider: "agy", left: 90, cantRun: "no online machine can run it" }, { provider: "codex", left: 40.4 }];
    assert.equal(pickReason(all[1]!, all), "Codex has 40% left. Antigravity can't run: no online machine can run it.");
  });
});
