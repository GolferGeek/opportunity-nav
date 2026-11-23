import type { ProviderId } from "@opnav/shared";
import type { Db } from "../db.ts";
import { HttpError } from "../errors.ts";
import { listMachines } from "./machines.ts";

/**
 * Picking who reviews: of the candidate agents (Antigravity and Codex by
 * default), the one with more usage left, among those a machine can run right
 * now. If the one with more left can't run, the other gets it.
 *
 * Usage left for an agent = the best of its accounts, where an account's usage
 * left is its tightest window (100 - used %). That's what stops the agent
 * first. A window whose reset time has passed counts as unused, like on the
 * dashboard. Model-only windows are skipped, since a review runs the agent's
 * default model.
 */

export const DEFAULT_REVIEWERS: readonly ProviderId[] = ["agy", "codex"];

export type WindowRow = { unit: string; used: number | string; lim?: number | string | null; resets_at?: Date | string | null; model?: string | null };

/** Percent left (0–100) of an account's tightest window, or null when none of its windows says. */
export function accountLeft(windows: WindowRow[], now = Date.now()): number | null {
  let left: number | null = null;
  for (const w of windows) {
    if (w.model) continue;
    const used = Number(w.used), lim = w.lim == null ? null : Number(w.lim);
    const percent = w.unit === "percent" ? used : lim ? (used / lim) * 100 : null;
    if (percent == null || !Number.isFinite(percent)) continue;
    const reset = w.resets_at && new Date(w.resets_at).getTime() <= now;
    const l = reset ? 100 : Math.max(0, Math.min(100, 100 - percent));
    left = left == null ? l : Math.min(left, l);
  }
  return left;
}

export type Candidate = {
  provider: string;
  /** Percent left, or null when there's no reading. */
  left: number | null;
  /** Why no machine can run it right now, if so. */
  cantRun?: string;
};

/**
 * Who reviews: the runnable candidate with the most left. No reading ranks
 * below any agent with usage left but above one that's known to be empty.
 * Ties go to the order given.
 */
export function rankReviewers(candidates: Candidate[]): Candidate | null {
  const score = (c: Candidate) => (c.left == null ? 0 : c.left <= 0 ? -1 : c.left);
  return candidates.filter((c) => !c.cantRun).reduce<Candidate | null>((best, c) => (!best || score(c) > score(best) ? c : best), null);
}

const LABELS: Record<string, string> = { agy: "Antigravity", codex: "Codex", claude: "Claude" };
const label = (p: string) => LABELS[p] ?? p;
const leftText = (c: Candidate) => (c.left == null ? "no usage reading" : `${Math.round(c.left)}% left`);

/** One plain line on why this one was picked. */
export function pickReason(picked: Candidate, all: Candidate[]): string {
  const others = all.filter((c) => c !== picked);
  const parts = others.map((o) => o.cantRun ? `${label(o.provider)} can't run: ${o.cantRun}` : `${label(o.provider)} has ${leftText(o)}`);
  return [`${label(picked.provider)} has ${leftText(picked)}.`, ...parts.map((p) => `${p}.`)].join(" ");
}

/** Usage left for each provider: the best of its visible accounts. */
export async function usageLeft(db: Db, userId: string, providers: readonly string[]): Promise<Map<string, number | null>> {
  const rows = await db`select s.id, s.provider, w.unit, w.used, w.lim, w.resets_at, w.model
    from subscriptions s left join usage_windows w on w.subscription_id = s.id
    where s.user_id = ${userId} and not s.hidden and s.provider in ${db(providers as string[])}`;
  const byAccount = new Map<string, { provider: string; windows: WindowRow[] }>();
  for (const r of rows) {
    const a = byAccount.get(r.id) ?? { provider: r.provider as string, windows: [] as WindowRow[] };
    if (r.unit) a.windows.push(r as unknown as WindowRow);
    byAccount.set(r.id, a);
  }
  const out = new Map<string, number | null>(providers.map((p) => [p, null]));
  for (const a of byAccount.values()) {
    const l = accountLeft(a.windows);
    const cur = out.get(a.provider) ?? null;
    if (l != null && (cur == null || l > cur)) out.set(a.provider, l);
  }
  return out;
}

/** Why no machine can run this provider's job right now, or undefined when one can. */
export async function cantRun(db: Db, userId: string, provider: string, want: { remote: string; needs: string[]; machineId?: string }) {
  const machines = (await listMachines(db, userId)).filter((m) => !m.revoked && (!want.machineId || m.id === want.machineId));
  const online = machines.filter((m) => m.online);
  if (!online.length) return want.machineId ? "that machine is offline" : "no machine is online";
  const withAgent = online.filter((m) => (m.providers as any[]).some((p) => p.provider === provider && p.signedIn && p.canRunJobs));
  if (!withAgent.length) return "no online machine can run it";
  const withRepo = withAgent.filter((m) => (m.checkouts as { remote?: string }[]).some((c) => c.remote === want.remote));
  if (!withRepo.length) return "no machine that runs it has this repo";
  if (!withRepo.some((m) => want.needs.every((n) => m.tools.includes(n)))) return `no machine that runs it has ${want.needs.join(" and ")}`;
  return undefined;
}

export async function pickReviewer(db: Db, userId: string, among: readonly string[], want: { remote: string; needs: string[]; machineId?: string }) {
  const left = await usageLeft(db, userId, among);
  const all: Candidate[] = [];
  for (const provider of among) all.push({ provider, left: left.get(provider) ?? null, cantRun: await cantRun(db, userId, provider, want) });
  const picked = rankReviewers(all);
  if (!picked) {
    throw new HttpError(409, `No reviewer can run right now. ${all.map((c) => `${label(c.provider)}: ${c.cantRun}.`).join(" ")}`);
  }
  return { provider: picked.provider, why: pickReason(picked, all), candidates: all };
}
