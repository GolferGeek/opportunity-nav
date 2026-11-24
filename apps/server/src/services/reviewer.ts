import { readingIsCurrent, type ProviderId } from "@opnav/shared";
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
 * default model. So are Antigravity's Claude and GPT groups: they're extra
 * allowances for those models, and running out of them doesn't stop its
 * default Gemini model.
 *
 * An agent with 0% left never gets a review, even when it's the only one that
 * could run: the job would just fail on its limit.
 *
 * A reading that isn't current (its last poll failed, it needs a sign-in, or
 * it's over 30 minutes old) ranks below every current one, and the reply says
 * so. It still ranks above no reading at all.
 *
 * "Can run now" means a machine has a free slot: the jobs it's running are
 * fewer than its helper's capacity.
 *
 * A reading belongs to the account it was read from, and a machine's usage is
 * the account that machine reports (it's signed in to it). So the usage quoted
 * is that of a free machine's own account; when the machines that run the
 * agent aren't all on that account, the job goes to that machine. A machine
 * that hasn't reported an account for the agent counts as on the agent's only
 * account, if it has just one; otherwise it has no reading.
 *
 * Antigravity takes a fair share: with no reading for its default (Gemini)
 * model, it counts as half left, like a current reading (ASSUMED_LEFT).
 */

export const DEFAULT_REVIEWERS: readonly ProviderId[] = ["agy", "codex"];

/**
 * Usage left assumed when an agent has no reading. Antigravity's quota summary
 * often has no group for its default model, and it should still get its share
 * of reviews rather than always ranking below an agent with a reading.
 */
export const ASSUMED_LEFT: Readonly<Record<string, number>> = { agy: 50 };

export type WindowRow = { window_id?: string; unit: string; used: number | string; lim?: number | string | null; resets_at?: Date | string | null; model?: string | null };

/** Antigravity reports quota groups as `<group>:<bucket>`; the Claude and GPT groups only limit those models. */
export const otherModelsGroup = (provider: string, w: WindowRow) =>
  provider === "agy" && /claude|gpt/i.test((w.window_id ?? "").split(":")[0] ?? "");

/** Percent left (0–100) of an account's tightest window, or null when none of its windows says. */
export function accountLeft(windows: WindowRow[], now = Date.now(), provider = ""): number | null {
  let left: number | null = null;
  for (const w of windows) {
    if (w.model || otherModelsGroup(provider, w)) continue;
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
  /** Set when the reading isn't current: why, in plain words ("read 3 h ago"). */
  stale?: string;
  /** Why no machine can run it right now, if so. One with 0% left can't run either. */
  cantRun?: string;
  /** The machine whose account the usage is from, when the job should go there. */
  machineId?: string;
  /** Set when `left` is assumed (ASSUMED_LEFT), not read. */
  assumed?: boolean;
};

export const empty = (c: Candidate) => c.left != null && c.left <= 0;
const runnable = (c: Candidate) => !c.cantRun && !empty(c);
/** Current readings first, then readings that aren't current, then no reading; most left first within each. */
const score = (c: Candidate) => c.left == null ? 0 : (c.stale ? 1000 : 2000) + c.left;

/**
 * Who reviews: the runnable candidate with the most left. A current reading
 * beats one that isn't, and any reading beats none. One with 0% left is never
 * picked. Ties go to the order given.
 */
export function rankReviewers(candidates: Candidate[]): Candidate | null {
  return candidates.filter(runnable).reduce<Candidate | null>((best, c) => (!best || score(c) > score(best) ? c : best), null);
}

const LABELS: Record<string, string> = { agy: "Antigravity", codex: "Codex", claude: "Claude" };
const label = (p: string) => LABELS[p] ?? p;
const leftText = (c: Candidate) =>
  c.assumed ? "no usage reading for its default model (counted as half left)" :
  (c.left == null ? "no usage reading" : c.left > 0 && c.left < 1 ? "under 1% left" : `${Math.round(c.left)}% left`) +
  (c.stale && c.left != null ? ` (not current: ${c.stale})` : "");
const whyNot = (c: Candidate) => c.cantRun ?? (empty(c) ? "no usage left" : undefined);

/** One plain line on why this one was picked. */
export function pickReason(picked: Candidate, all: Candidate[]): string {
  const others = all.filter((c) => c !== picked);
  const parts = others.map((o) => whyNot(o) ? `${label(o.provider)} can't run: ${whyNot(o)}` : `${label(o.provider)} has ${leftText(o)}`);
  const tied = others.some((o) => runnable(o) && score(o) === score(picked));
  return [`${label(picked.provider)} has ${leftText(picked)}.`, ...parts.map((p) => `${p}.`), ...(tied ? ["A tie goes to the first listed."] : [])].join(" ");
}

/** "12 min ago", "3 h ago", "4 days ago". */
export function agoText(at: Date | string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - new Date(at).getTime()) / 60_000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** One subscription account's reading. */
export type AccountReading = {
  /** The subscription card (one per account). */
  id: string;
  left: number | null;
  /** Unset when the reading is current. */
  stale?: string;
};

/** Each provider's accounts, and which account each machine reports for it. */
export type ProviderReadings = { accounts: AccountReading[]; byMachine: Map<string, string> };

/** Why an account's reading isn't current, or undefined when it is. */
export function staleText(status: string, fetchedAt: Date | string | null, now = Date.now()): string | undefined {
  if (readingIsCurrent(status, fetchedAt, now)) return undefined;
  if (status === "auth_required") return fetchedAt ? `needs a sign-in, read ${agoText(fetchedAt, now)}` : "needs a sign-in";
  return fetchedAt ? `read ${agoText(fetchedAt, now)}` : "never read";
}

/** The account a machine runs this agent on: the one it reports, else the agent's only account. */
export function machineAccount(r: ProviderReadings, machineId: string): AccountReading | null {
  const id = r.byMachine.get(machineId);
  if (id) return r.accounts.find((a) => a.id === id) ?? null;
  return r.accounts.length === 1 ? r.accounts[0]! : null;
}

/** Like `score`, but an empty account ranks below a machine with no reading: that machine might still run. */
const accountScore = (a: AccountReading | null) => (!a ? 0 : a.left != null && a.left <= 0 ? -1 : score({ provider: "", left: a.left, stale: a.stale }));

/**
 * The usage that counts for an agent: the best account among the free
 * machines' own accounts (current beats not current, then most left; ties go
 * to the first machine). The job goes to that machine unless every machine
 * that runs the agent is on that account. With no free machine, the best
 * account overall, for the reply.
 */
export function bestMachine(r: ProviderReadings, free: readonly string[], capable: readonly string[]): { account: AccountReading | null; machineId?: string } {
  if (!free.length) {
    const read = r.accounts.filter((a) => a.left != null);
    return { account: read.length ? read.reduce((b, a) => (accountScore(a) > accountScore(b) ? a : b)) : null };
  }
  let machine = free[0]!, account = machineAccount(r, machine);
  for (const m of free.slice(1)) {
    const a = machineAccount(r, m);
    if (accountScore(a) > accountScore(account)) { machine = m; account = a; }
  }
  if (account?.left == null) return { account: null };
  const shared = capable.every((m) => machineAccount(r, m)?.id === account!.id);
  return { account, machineId: shared ? undefined : machine };
}

/** Each provider's visible accounts, read, and the account each machine last reported. */
export async function accountReadings(db: Db, userId: string, providers: readonly string[]): Promise<Map<string, ProviderReadings>> {
  const rows = await db`select s.id, s.provider, s.status, s.fetched_at, w.window_id, w.unit, w.used, w.lim, w.resets_at, w.model
    from subscriptions s left join usage_windows w on w.subscription_id = s.id
    where s.user_id = ${userId} and not s.hidden and s.provider in ${db(providers as string[])}`;
  const sources = await db`select distinct on (u.node_id, s.provider) u.node_id, s.provider, s.id
    from usage_sources u join subscriptions s on s.id = u.subscription_id
    where s.user_id = ${userId} and not s.hidden and s.provider in ${db(providers as string[])}
    order by u.node_id, s.provider, u.observed_at desc`;
  const byAccount = new Map<string, { provider: string; status: string; fetchedAt: Date | null; windows: WindowRow[] }>();
  for (const r of rows) {
    const a = byAccount.get(r.id) ?? { provider: r.provider, status: r.status, fetchedAt: r.fetched_at, windows: [] as WindowRow[] };
    if (r.unit) a.windows.push(r as unknown as WindowRow);
    byAccount.set(r.id, a);
  }
  const now = Date.now();
  const out = new Map<string, ProviderReadings>(providers.map((p) => [p, { accounts: [], byMachine: new Map() }]));
  for (const [id, a] of byAccount) {
    out.get(a.provider)?.accounts.push({ id, left: accountLeft(a.windows, now, a.provider), stale: staleText(a.status, a.fetchedAt, now) });
  }
  for (const s of sources) out.get(s.provider)?.byMachine.set(s.node_id, s.id);
  return out;
}

export type MachineView = {
  id: string; online: boolean; revoked: boolean; providers: unknown; checkouts: unknown; tools: string[]; capacity: number; running: number; takingJobs?: boolean;
};

/** The machines that can run this provider's job right now, or why none can. */
export function freeMachines(machines: MachineView[], provider: string, want: { remote: string; needs: string[]; machineId?: string }): { ids: string[]; capable: string[]; why?: string } {
  const r = freeOrWhy(machines, provider, want);
  return { ...r, capable: r.capable ?? [] };
}

function freeOrWhy(machines: MachineView[], provider: string, want: { remote: string; needs: string[]; machineId?: string }): { ids: string[]; capable?: string[]; why?: string } {
  const mine = machines.filter((m) => !m.revoked && (!want.machineId || m.id === want.machineId));
  const online = mine.filter((m) => m.online);
  if (!online.length) return { ids: [], why: want.machineId ? "that machine is offline" : "no machine is online" };
  const withAgent = online.filter((m) => (m.providers as any[]).some((p) => p.provider === provider && p.signedIn && p.canRunJobs));
  if (!withAgent.length) return { ids: [], why: "no online machine can run it" };
  const withRepo = withAgent.filter((m) => (m.checkouts as { remote?: string }[]).some((c) => c.remote === want.remote));
  if (!withRepo.length) return { ids: [], why: "no machine that runs it has this repo" };
  const withTools = withRepo.filter((m) => want.needs.every((n) => m.tools.includes(n)));
  if (!withTools.length) return { ids: [], why: `no machine that runs it has ${want.needs.join(" and ")}` };
  const capable = withTools.map((m) => m.id);
  const free = withTools.filter((m) => m.takingJobs !== false && m.running < m.capacity);
  if (!free.length) return { ids: [], capable, why: want.machineId ? "that machine is busy" : withTools.length > 1 ? "every machine that runs it is busy" : "the machine that runs it is busy" };
  return { ids: free.map((m) => m.id), capable };
}

export async function pickReviewer(db: Db, userId: string, among: readonly string[], want: { remote: string; needs: string[]; machineId?: string }) {
  const [accounts, all0] = await Promise.all([accountReadings(db, userId, among), listMachines(db, userId)]);
  // A review runs on the machine itself, so only its local slots count.
  const machines = all0.map((m) => ({ ...m, running: m.runningLocal }));
  const all: Candidate[] = among.map((provider) => {
    const free = freeMachines(machines, provider, want);
    const best = bestMachine(accounts.get(provider) ?? { accounts: [], byMachine: new Map() }, free.ids, free.capable);
    const assumed = best.account?.left == null && ASSUMED_LEFT[provider] != null;
    return {
      provider, left: assumed ? ASSUMED_LEFT[provider]! : best.account?.left ?? null, stale: assumed ? undefined : best.account?.stale,
      cantRun: free.why, machineId: best.machineId, ...(assumed ? { assumed } : {}),
    };
  });
  const picked = rankReviewers(all);
  if (!picked) {
    throw new HttpError(409, `No reviewer can run right now. ${all.map((c) => `${label(c.provider)}: ${whyNot(c)}.`).join(" ")}`);
  }
  return { provider: picked.provider, machineId: want.machineId ?? picked.machineId, why: pickReason(picked, all), candidates: all };
}
