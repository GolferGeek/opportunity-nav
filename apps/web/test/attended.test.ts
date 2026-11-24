import { test } from "node:test";
import assert from "node:assert/strict";
import { autoOpen, isUnattended, itemPrompt } from "../src/attended.ts";

test("an item with no live job is unattended; one with a job is not", () => {
  const working = new Set(["a"]);
  assert.equal(isUnattended({ id: "a", kind: "item" }, working), false);
  assert.equal(isUnattended({ id: "b", kind: "item" }, working), true);
});

test("areas and projects are never unattended, and nothing is before the list loads", () => {
  assert.equal(isUnattended({ id: "p", kind: "project" }, new Set()), false);
  assert.equal(isUnattended({ id: "x", kind: "area" }, new Set()), false);
  assert.equal(isUnattended({ id: "b", kind: "item" }, null), false);
});

test("the job starts from the item's name, then its notes", () => {
  assert.equal(itemPrompt({ title: "Fix login", notes: null }), "Fix login");
  assert.equal(itemPrompt({ title: "Fix login", notes: "  " }), "Fix login");
  assert.equal(itemPrompt({ title: "Fix login", notes: "Safari only.\n" }), "Fix login\n\nSafari only.");
});

test("an unattended item opens its form by itself, once per visit, once it's known", () => {
  assert.deepEqual(autoOpen(null, "b", true, false), { seen: null, open: false }, "not before the list loads");
  assert.deepEqual(autoOpen(null, "b", true, true), { seen: "b", open: true });
  assert.deepEqual(autoOpen("b", "b", true, true), { seen: "b", open: false }, "closed stays closed on the same item");
  assert.deepEqual(autoOpen("b", "a", false, true), { seen: "a", open: false }, "an attended item doesn't open it");
  assert.deepEqual(autoOpen("a", "b", true, true), { seen: "b", open: true }, "a new item opens it again");
});
