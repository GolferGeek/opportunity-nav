import { test } from "node:test";
import assert from "node:assert/strict";
import { cardEmptyNote, cardWindows, projectLabel, queueCounts, queueLow, readingClass, readingNote } from "../src/labels.ts";

test("a handoff's project label is its path below the top area", () => {
  assert.equal(projectLabel("p1", ["Coding", "Orchestrator AI", "Agents Only"]), "Orchestrator AI / Agents Only");
  assert.equal(projectLabel("p1", ["Coding", "Opportunity Nav"]), "Opportunity Nav");
});

test("a project right at the top shows its own name", () => {
  assert.equal(projectLabel("p1", ["Coding"]), "Coding");
});

test("no project, no label", () => {
  assert.equal(projectLabel(null, ["Not in a project yet"]), null);
  assert.equal(projectLabel(undefined, undefined), null);
  assert.equal(projectLabel("p1", []), null);
  assert.equal(projectLabel("p1", null), null);
  assert.equal(projectLabel("p1", ["", "  "]), null);
});

test("a card whose reading isn't current says so, with its age", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  const card = (over: object) => ({ status: "ok", message: null, fetchedAt: "2026-11-23T11:58:00Z", current: true, ...over });
  assert.equal(readingNote(card({}), now), null);
  assert.equal(readingNote(card({ current: false, fetchedAt: "2026-11-23T09:00:00Z" }), now), "Not current · last read 3h ago");
  assert.equal(readingNote(card({ status: "auth_required", current: false, message: "Codex isn't signed in", fetchedAt: "2026-11-21T12:00:00Z" }), now),
    "Sign in again: Codex isn't signed in · last read 2d ago");
  assert.equal(readingNote(card({ status: "error", current: false, fetchedAt: null }), now), "Couldn't check");
  assert.equal(readingNote(card({ status: "unavailable", current: false }), now), "No limits to show");
  assert.equal(readingClass(card({ current: false })), "status-stale");
  assert.equal(readingClass(card({ status: "auth_required", current: false })), "status-auth_required");
});

test("Antigravity's card leads with Gemini and hides unused Claude and GPT rows", () => {
  const w = (id: string, percent: number | null) => ({ id, unit: "percent", percent });
  const claude = [w("Claude and GPT models:3p-weekly", 0), w("Claude and GPT models:3p-5h", 0)];
  const gemini = [w("Gemini models:gemini-5h", 25), w("Gemini models:gemini-weekly", 60)];
  const ids = (ws: { id: string }[]) => ws.map((x) => x.id);
  assert.deepEqual(ids(cardWindows("agy", [...claude, ...gemini])), ids(gemini));
  assert.deepEqual(ids(cardWindows("agy", [w("Claude and GPT models:3p-5h", 12), ...gemini])), [...ids(gemini), "Claude and GPT models:3p-5h"]);
  assert.deepEqual(ids(cardWindows("codex", [w("5h", 0), { id: "day", unit: "tokens", percent: null }])), ["5h"], "other agents show every limit");
  assert.equal(cardEmptyNote({ provider: "agy", status: "ok", windows: [...claude, ...gemini] }), null);
  assert.equal(cardEmptyNote({ provider: "agy", status: "ok", windows: claude }), "Google reports no Gemini limit.\nClaude and GPT allowance unused.");
  assert.equal(cardEmptyNote({ provider: "agy", status: "ok", windows: [w("Claude and GPT models:3p-5h", 5)] }), "Google reports no Gemini limit.");
  assert.equal(cardEmptyNote({ provider: "agy", status: "stale", windows: claude }), null, "a stale card has its own note");
  assert.equal(cardEmptyNote({ provider: "codex", status: "ok", windows: [] }), null);
});

test("the queue block counts what's waiting, in plain words", () => {
  assert.equal(queueCounts({ waiting: 4, held: 1, running: 3 }), "4 waiting · 1 on hold · 3 running now");
  assert.equal(queueCounts({ waiting: 2, held: 0, running: 0 }), "2 waiting");
  assert.equal(queueCounts({ waiting: 0, held: 0, running: 2 }), "Nothing waiting · 2 running now");
});

test("the queue block says when it's running low, and only then", () => {
  assert.equal(queueLow({ low: false, ready: 5, slots: 4 }), null);
  assert.equal(queueLow({ low: true, ready: 1, slots: 4 }), "Running low: 1 ready to start, room for 4.");
  assert.equal(queueLow({ low: true, ready: 0, slots: 2 }), "Running low: none ready to start, room for 2.");
});
