import { test } from "node:test";
import assert from "node:assert/strict";
import { projectLabel } from "../src/labels.ts";

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
