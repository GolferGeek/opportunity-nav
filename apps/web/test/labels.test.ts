import { test } from "node:test";
import assert from "node:assert/strict";
import { projectLabel, readingClass, readingNote } from "../src/labels.ts";

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
