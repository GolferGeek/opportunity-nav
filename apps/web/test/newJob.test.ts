import { test } from "node:test";
import assert from "node:assert/strict";
import { FALLBACK_PROVIDER, defaultLocationLabel, defaultModelLabel, formReducer, initialForm, jobBody, nearestProject, shown,
  type FormAction, type FormState, type ProjectDefaults } from "../src/newJob.ts";
import { modelChoice, modelOptions, OTHER_MODEL } from "../src/models.ts";
import { whereOptions, type MachineLite } from "../src/where.ts";

const names = { agent: (p: string) => p, needs: (n: string[]) => n.join(", ") };
const localModels = (p: string) => p === "ollama" || p === "mlx";

// A Codex project whose jobs need Docker, as in the review that found the bug.
const codexDocker: ProjectDefaults = { defaultProvider: "codex", defaultModel: "gpt-5-codex", defaultLocation: null, defaultNeeds: ["docker"], repoRemote: "github.com/o/r" };
const studio: MachineLite = {
  id: "m1", name: "Mac-Studio.local", online: true, takingJobs: true, tools: ["docker"],
  providers: [
    { provider: "codex", signedIn: true, canRunJobs: true },
    { provider: "ollama", signedIn: true, canRunJobs: true, models: ["qwen3:32b"] },
  ],
  cloudroom: { providers: ["codex", "claude"] },
};
const laptop: MachineLite = { id: "m2", name: "Omarchy", online: true, takingJobs: true, tools: [], providers: [{ provider: "codex", signedIn: true, canRunJobs: true }] };
const machines = [studio, laptop];

const run = (...actions: FormAction[]) => actions.reduce(formReducer, initialForm("Fix login"));
/** What the form sends, as Start does: the "Where it runs" choices for what's shown now. */
const submit = (s: FormState, project: ProjectDefaults | null) => {
  const v = shown(s, project);
  return jobBody("item-1", s, project, whereOptions(machines, v.provider, project?.repoRemote ?? null, v.needs, names), localModels);
};

test("an item finds its nearest project's defaults; a project is its own", () => {
  const byId = new Map([
    { id: "a", kind: "area" as const, parentId: null },
    { id: "p", kind: "project" as const, parentId: "a" },
    { id: "i", kind: "item" as const, parentId: "p" },
    { id: "j", kind: "item" as const, parentId: "i" },
  ].map((n) => [n.id, n]));
  assert.equal(nearestProject(byId, byId.get("j")!)?.id, "p");
  assert.equal(nearestProject(byId, byId.get("p")!)?.id, "p");
  assert.equal(nearestProject(byId, byId.get("a")!), null);
});

test("the form opens on the project's agent, model and needs, not Claude and nothing", () => {
  const v = shown(initialForm(), codexDocker);
  assert.equal(v.provider, "codex");
  assert.deepEqual(v.needs, ["docker"]);
  assert.equal(v.model, "");
  assert.equal(v.projectModel, "gpt-5-codex");
  assert.equal(defaultModelLabel(v.projectModel), "Project default (gpt-5-codex)");
  // The empty choice is the one shown, called Project default.
  const opts = modelOptions(v.provider, [], [], v.projectModel, defaultModelLabel(v.projectModel));
  assert.deepEqual(opts[0], { value: "", label: "Project default (gpt-5-codex)" });
  assert.equal(modelChoice(v.model, opts), "");
});

test("left alone, it sends none of the defaults, so the server applies the project's", () => {
  const body = submit(run(), codexDocker);
  assert.deepEqual(body, { nodeId: "item-1", prompt: "Fix login", provider: undefined, model: undefined, location: undefined,
    runner: "direct", machineId: undefined, needs: undefined });
});

test("with no project default it shows, and sends, Claude, since a job needs an agent", () => {
  const none: ProjectDefaults = { defaultProvider: null, defaultModel: null, defaultLocation: null, defaultNeeds: [], repoRemote: null };
  assert.equal(shown(initialForm(), none).provider, FALLBACK_PROVIDER);
  assert.equal(submit(run(), none).provider, FALLBACK_PROVIDER);
  assert.equal(defaultModelLabel(shown(initialForm(), none).projectModel), "Default model");
});

test("it sends only what the person changes", () => {
  assert.equal(submit(run({ type: "provider", value: "claude" }), codexDocker).provider, "claude");
  assert.deepEqual(submit(run({ type: "needs", value: [] }), codexDocker).needs, []);
  assert.equal(submit(run({ type: "model", value: "o4-mini" }), codexDocker).model, "o4-mini");
  // Unticking and ticking Docker again is no change.
  assert.equal(submit(run({ type: "needs", value: [] }, { type: "needs", value: ["docker"] }), codexDocker).needs, undefined);
  // Picking the project's own agent again is no change either.
  assert.equal(submit(run({ type: "provider", value: "claude" }, { type: "provider", value: "codex" }), codexDocker).provider, undefined);
});

test("another agent drops the model; back on the project's agent, empty is its model again", () => {
  const other = run({ type: "model", value: "o4-mini" }, { type: "provider", value: "claude" });
  assert.equal(shown(other, codexDocker).model, "");
  assert.equal(shown(other, codexDocker).projectModel, null);
  assert.equal(submit(other, codexDocker).model, undefined);
  assert.equal(shown(run({ type: "provider", value: "claude" }, { type: "provider", value: "codex" }), codexDocker).projectModel, "gpt-5-codex");
});

test("a typed model id is sent as typed, trimmed", () => {
  const s = run({ type: "model", value: OTHER_MODEL }, { type: "typeModel", value: " gpt-5.1-codex-max " });
  assert.equal(s.typing, true);
  assert.equal(submit(s, codexDocker).model, "gpt-5.1-codex-max");
});

test("a machine pick sends that machine, and the model picked with it", () => {
  const s = run({ type: "where", value: "machine:m1" }, { type: "model", value: "o4-mini" });
  const body = submit(s, codexDocker);
  assert.equal(body.runner, "direct");
  assert.equal(body.machineId, "m1");
  assert.equal(body.model, "o4-mini");
  assert.equal(body.needs, undefined);
});

test("a machine that lacks the project's needs can't be the one sent", () => {
  // The Omarchy has no Docker, so with the project's needs it's greyed out and the job goes to any machine.
  const body = submit(run({ type: "where", value: "machine:m2" }), codexDocker);
  assert.equal(body.machineId, undefined);
  assert.equal(body.runner, "direct");
  // Untick Docker and it's offered, and sent.
  const unticked = submit(run({ type: "needs", value: [] }, { type: "where", value: "machine:m2" }), codexDocker);
  assert.equal(unticked.machineId, "m2");
  assert.deepEqual(unticked.needs, []);
});

test("a cloud sends its runner, no machine, and a cloud model", () => {
  const body = submit(run({ type: "where", value: "machine:m1" }, { type: "where", value: "cloudroom" }), codexDocker);
  assert.equal(body.runner, "cloudroom");
  assert.equal(body.machineId, undefined);
  assert.equal(body.location, "cloud");
});

test("switching to an agent the chosen cloud can't run sends any machine instead", () => {
  const body = submit(run({ type: "where", value: "cloudroom" }, { type: "provider", value: "ollama" }), codexDocker);
  assert.equal(body.runner, "direct");
  assert.equal(body.location, undefined);
  assert.equal(body.provider, "ollama");
});

test("only Ollama and MLX send a model location, and only when picked", () => {
  const ollama: ProjectDefaults = { ...codexDocker, defaultProvider: "ollama", defaultModel: null, defaultLocation: "local" };
  assert.equal(defaultLocationLabel(ollama), "Model: project default (local)");
  assert.equal(defaultLocationLabel(codexDocker), "Model: default");
  assert.equal(submit(run(), ollama).location, undefined);
  assert.equal(submit(run({ type: "location", value: "cloud" }), ollama).location, "cloud");
  assert.equal(submit(run({ type: "location", value: "local" }, { type: "provider", value: "codex" }), ollama).location, undefined);
});
