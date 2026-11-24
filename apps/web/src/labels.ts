/**
 * The short project name a handoff shows: its path below the top area,
 * e.g. ["Coding", "Orchestrator AI", "Agents Only"] → "Orchestrator AI / Agents Only".
 * Null when there's no project, so nothing is shown.
 */
export function projectLabel(projectId: string | null | undefined, path: readonly string[] | null | undefined): string | null {
  if (!projectId || !path) return null;
  const names = path.map((p) => p.trim()).filter(Boolean);
  if (names.length === 0) return null;
  return (names.length > 1 ? names.slice(1) : names).join(" / ");
}

const STATUS_TEXT: Record<string, string> = {
  stale: "Not current",
  auth_required: "Sign in again",
  unavailable: "No limits to show",
  error: "Couldn't check",
};

function agoShort(d: string, now: number): string {
  const s = Math.round((now - new Date(d).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * The line a subscription card shows when its reading isn't current, or null
 * when it is. A good reading that's over 30 minutes old is not current too:
 * the machine that reads it may be off.
 */
export function readingNote(s: { status: string; message: string | null; fetchedAt: string | null; current?: boolean }, now = Date.now()): string | null {
  if (s.status === "ok" && s.current !== false) return null;
  const head = s.status === "ok" ? "Not current" : STATUS_TEXT[s.status] ?? s.status;
  const read = s.status === "unavailable" ? null : s.fetchedAt ? `last read ${agoShort(s.fetchedAt, now)}` : null;
  return [head + (s.message ? `: ${s.message}` : ""), read].filter(Boolean).join(" · ");
}

/** The card's look: one whose good reading has gone old looks like a stale one. */
export const readingClass = (s: { status: string; current?: boolean }) => `status-${s.status === "ok" && s.current === false ? "stale" : s.status}`;

type CardWindow = { id: string; unit: string; percent: number | null };

/** Antigravity reports quota groups as `<group>:<bucket>`; the Claude and GPT groups are allowances for those models only. */
const otherModels = (w: { id: string }) => /claude|gpt/i.test(w.id.split(":")[0] ?? "");

/**
 * The limit rows a subscription card shows. Antigravity's Gemini windows lead;
 * its Claude and GPT allowance rows stay hidden until some of them is used,
 * as Omarchy's gauge does.
 */
export function cardWindows<W extends CardWindow>(provider: string, windows: readonly W[]): W[] {
  const limits = windows.filter((w) => w.unit !== "tokens");
  if (provider !== "agy") return limits;
  return [...limits.filter((w) => !otherModels(w)), ...limits.filter((w) => otherModels(w) && (w.percent ?? 0) > 0)];
}

/** The quiet line a good Antigravity card shows when Google names no Gemini limit, or null. */
export function cardEmptyNote(s: { provider: string; status: string; windows: readonly CardWindow[] }): string | null {
  if (s.provider !== "agy" || s.status !== "ok" || s.windows.some((w) => w.unit !== "tokens" && !otherModels(w))) return null;
  return cardWindows(s.provider, s.windows).length ? "Google reports no Gemini limit." : "Google reports no Gemini limit.\nClaude and GPT allowance unused.";
}

/** The Dashboard's queue block ("Waiting to start"): its one line of counts. */
export function queueCounts(t: { waiting: number; held: number; running: number }): string {
  const parts = [t.waiting ? `${t.waiting} waiting` : "Nothing waiting"];
  if (t.held) parts.push(`${t.held} on hold`);
  if (t.running) parts.push(`${t.running} running now`);
  return parts.join(" · ");
}

/** The queue block's running-low line, when fewer jobs are ready than the machines have room for; else null. */
export function queueLow(r: { low: boolean; ready: number; slots: number }): string | null {
  if (!r.low) return null;
  return `Running low: ${r.ready || "none"} ready to start, room for ${r.slots}.`;
}
