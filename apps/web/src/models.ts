/**
 * The new-job form's model list for the picked agent. Pure, so it's tested.
 *
 * Where the list comes from, so it stays current without anyone editing it:
 * - Models a machine reports for the agent (Ollama lists what's pulled). When any
 *   machine reports some, that's the whole list: a job can only run one it has.
 * - Claude Code's aliases (opus, sonnet, haiku): the CLI maps each to its newest model.
 * - Models the agent ran in recent jobs, as it reported them.
 * An agent with none of these offers just its default and "Other…", to type any id.
 */
import type { MachineLite } from "./where.ts";

export type ModelOption = { value: string; label: string };

/** The agent's own default: no model sent. Always first, so it needs no clicks. */
export const DEFAULT_MODEL = "";
/** Shows a box to type any model id. */
export const OTHER_MODEL = "__other__";

/** Names the agent's CLI keeps pointing at its newest model, so they never go stale. */
const ALIASES: Record<string, ModelOption[]> = {
  claude: [
    { value: "opus", label: "Opus (newest)" },
    { value: "sonnet", label: "Sonnet (newest)" },
    { value: "haiku", label: "Haiku (newest)" },
  ],
};

/** The parts of a GET /api/jobs row this reads. */
export type RecentJob = { provider: string; model?: string | null; reportedModel?: string | null };

const MAX_RECENT = 8;

/**
 * The choices for this agent: its default, then the known models, then "Other…".
 * machines: the machines the job could run on (only online ones taking jobs count).
 * recent: the user's recent jobs, newest first. also: a model to keep offered (the project's default).
 */
export function modelOptions(provider: string, machines: MachineLite[], recent: RecentJob[], also?: string | null): ModelOption[] {
  const seen = new Set<string>();
  const out: ModelOption[] = [{ value: DEFAULT_MODEL, label: "Default model" }];
  const add = (value: string, label = value) => {
    const v = value.trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push({ value: v, label });
  };
  const onMachines = machines
    .filter((m) => m.online && m.takingJobs !== false)
    .flatMap((m) => (m.providers ?? []).filter((p) => p.provider === provider && p.signedIn !== false).flatMap((p) => p.models ?? []));
  if (onMachines.length > 0) {
    [...onMachines].sort().forEach((m) => add(m));
  } else {
    (ALIASES[provider] ?? []).forEach((o) => add(o.value, o.label));
    if (also) add(also);
    const used = recent.filter((j) => j.provider === provider).flatMap((j) => [j.model, j.reportedModel])
      .filter((m): m is string => !!m?.trim() && !seen.has(m.trim()));
    [...new Set(used.map((m) => m.trim()))].slice(0, MAX_RECENT).forEach((m) => add(m));
  }
  out.push({ value: OTHER_MODEL, label: "Other…" });
  return out;
}

/** What the list shows for a model: itself if offered, the default if empty, else "Other…" (a typed id). */
export function modelChoice(model: string, opts: ModelOption[]): string {
  if (!model.trim()) return DEFAULT_MODEL;
  return opts.some((o) => o.value === model.trim() && o.value !== OTHER_MODEL) ? model.trim() : OTHER_MODEL;
}
