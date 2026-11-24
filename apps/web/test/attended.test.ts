import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnattended, itemPrompt } from "../src/attended.ts";

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
