/**
 * The new-job form's state, apart from React, so it's tested. The form starts
 * from the nearest project's defaults (as the server applies them, see
 * apps/server/src/services/jobs.ts createJob) and holds only what the person
 * changes; the job sends only those, so the server fills in the rest from the
 * project. An item has no defaults of its own: its project's are the ones that count.
 */
import type { Need, TreeNode } from "./api.ts";
import { ANY_MACHINE, keepWhere, whereToJob, type Where, type WhereOption } from "./where.ts";
import { OTHER_MODEL } from "./models.ts";

/** The agent shown, and sent, when the project names none (the server needs one). */
export const FALLBACK_PROVIDER = "claude";

export type ProjectDefaults = Pick<TreeNode, "defaultProvider" | "defaultModel" | "defaultLocation" | "defaultNeeds" | "repoRemote">;

/** The node's nearest project: itself if it is one, else the first project above it. Null when there's none. */
export function nearestProject<N extends Pick<TreeNode, "id" | "kind" | "parentId">>(byId: ReadonlyMap<string, N>, node: N): N | null {
  let cur: N | undefined = byId.get(node.id) ?? node;
  while (cur && cur.kind !== "project") cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  return cur ?? null;
}

/** What the person changed. Unset means "the project's default". */
export type FormState = {
  prompt: string;
  provider?: string;
  model?: string;
  /** "Other…" is picked: a box to type any model id. */
  typing: boolean;
  location?: "" | "local" | "cloud";
  needs?: Need[];
  where: Where;
};

export const initialForm = (prompt = ""): FormState => ({ prompt, typing: false, where: ANY_MACHINE });

export type FormAction =
  | { type: "prompt"; value: string }
  | { type: "provider"; value: string }
  | { type: "model"; value: string }
  | { type: "typeModel"; value: string }
  | { type: "location"; value: "" | "local" | "cloud" }
  | { type: "needs"; value: Need[] }
  | { type: "where"; value: Where };

export function formReducer(s: FormState, a: FormAction): FormState {
  switch (a.type) {
    case "prompt": return { ...s, prompt: a.value };
    // A model id belongs to one agent: a new agent starts at its default (the project's model, when it's the project's agent).
    case "provider": return { ...s, provider: a.value, model: undefined, typing: false };
    case "model": return { ...s, typing: a.value === OTHER_MODEL, model: a.value === OTHER_MODEL ? "" : a.value };
    case "typeModel": return { ...s, model: a.value };
    case "location": return { ...s, location: a.value };
    case "needs": return { ...s, needs: a.value };
    case "where": return { ...s, where: a.value };
  }
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** What the form shows: the person's change, else the project's default. */
export function shown(s: FormState, project: ProjectDefaults | null) {
  const provider = s.provider ?? project?.defaultProvider ?? FALLBACK_PROVIDER;
  // Empty means the server picks: the project's model when it's the project's agent, else the agent's own.
  const projectModel = provider === project?.defaultProvider ? project?.defaultModel ?? null : null;
  return {
    provider,
    model: s.model ?? "",
    projectModel,
    location: s.location ?? "",
    needs: s.needs ?? project?.defaultNeeds ?? [],
  };
}

/** The label of the empty model choice: the project's model when leaving it empty uses that. */
export const defaultModelLabel = (projectModel: string | null) => (projectModel ? `Project default (${projectModel})` : "Default model");

/** The label of the empty model-location choice, for Ollama and MLX. */
export const defaultLocationLabel = (project: ProjectDefaults | null) =>
  project?.defaultLocation ? `Model: project default (${project.defaultLocation})` : "Model: default";

/**
 * The POST /api/jobs body. Only what the person changed is sent, so the server
 * applies the project's agent, model, location and needs itself. whereOpts: the
 * "Where it runs" choices now offered (a choice that stopped fitting is any machine).
 */
export function jobBody(nodeId: string, s: FormState, project: ProjectDefaults | null, whereOpts: WhereOption[], localModels: (p: string) => boolean) {
  const v = shown(s, project);
  const { runner, machineId } = whereToJob(keepWhere(s.where, whereOpts));
  const inCloud = runner !== "direct";
  const provider = v.provider !== project?.defaultProvider ? v.provider : undefined;
  const model = v.model.trim() || undefined;
  // In a cloud the model runs in the cloud. Only Ollama and MLX can pick, and only on a machine.
  const location = inCloud ? "cloud" as const : localModels(v.provider) && v.location ? v.location : undefined;
  const needs = s.needs && !sameSet(s.needs, project?.defaultNeeds ?? []) ? s.needs : undefined;
  return { nodeId, prompt: s.prompt, provider, model, location, runner, machineId, needs };
}
