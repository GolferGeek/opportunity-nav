import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODEL, OTHER_MODEL, modelChoice, modelOptions } from "../src/models.ts";
import type { MachineLite } from "../src/where.ts";

const values = (o: { value: string }[]) => o.map((x) => x.value);
const studio: MachineLite = {
  id: "m1", name: "Mac-Studio", online: true, takingJobs: true,
  providers: [{ provider: "ollama", signedIn: true, canRunJobs: true, models: ["qwen3:32b", "gemma3"] }],
};

test("the agent's default comes first and Other… last, even when nothing is known", () => {
  const opts = modelOptions("grok", [], []);
  assert.deepEqual(opts, [{ value: DEFAULT_MODEL, label: "Default model" }, { value: OTHER_MODEL, label: "Other…" }]);
});

test("Claude offers its aliases, which always mean its newest models", () => {
  assert.deepEqual(values(modelOptions("claude", [], [])), ["", "opus", "sonnet", "haiku", OTHER_MODEL]);
});

test("models recent jobs ran are offered for that agent only, once each", () => {
  const recent = [
    { provider: "codex", model: null, reportedModel: "gpt-5.1-codex" },
    { provider: "codex", model: "gpt-5.1-codex", reportedModel: "gpt-5.1-codex" },
    { provider: "claude", model: "opus", reportedModel: "claude-opus-4-5-20251101" },
    { provider: "codex", model: " o4-mini ", reportedModel: null },
  ];
  assert.deepEqual(values(modelOptions("codex", [], recent)), ["", "gpt-5.1-codex", "o4-mini", OTHER_MODEL]);
  assert.deepEqual(values(modelOptions("claude", [], recent)), ["", "opus", "sonnet", "haiku", "claude-opus-4-5-20251101", OTHER_MODEL]);
});

test("the project's default model stays offered", () => {
  assert.deepEqual(values(modelOptions("codex", [], [], "gpt-5-codex")), ["", "gpt-5-codex", OTHER_MODEL]);
});

test("what a machine reports is the whole list: a job can run only a model it has", () => {
  const recent = [{ provider: "ollama", model: "llama3", reportedModel: null }];
  assert.deepEqual(values(modelOptions("ollama", [studio], recent)), ["", "gemma3", "qwen3:32b", OTHER_MODEL]);
});

test("a machine offline or not taking jobs reports nothing", () => {
  assert.deepEqual(values(modelOptions("ollama", [{ ...studio, online: false }], [])), ["", OTHER_MODEL]);
  assert.deepEqual(values(modelOptions("ollama", [{ ...studio, takingJobs: false }], [])), ["", OTHER_MODEL]);
});

test("the list shows a model if offered, the default if empty, else Other… with the typed id", () => {
  const opts = modelOptions("claude", [], []);
  assert.equal(modelChoice("", opts), DEFAULT_MODEL);
  assert.equal(modelChoice("sonnet", opts), "sonnet");
  assert.equal(modelChoice("claude-sonnet-4-5", opts), OTHER_MODEL);
});
