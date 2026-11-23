import { z } from "zod";
import { CollectionStatus, IsoTime, ProviderId } from "./common.ts";

/**
 * Usage is reported per subscription *account*, not per machine. Two nodes
 * signed in to the same Claude account report the same `accountKey`; the
 * server keeps the newest good reading for each (account, window).
 */

export const UsageWindowKind = z.enum([
  "session", // e.g. Claude/Codex 5-hour
  "weekly",
  "monthly",
  "period", // billing period of unstated length
  "spend", // spend cap
  "credits", // prepaid balance
]);

export const UsageUnit = z.enum(["percent", "usd", "credits", "requests", "tokens"]);

export const UsageWindow = z.object({
  /** Stable id within the account, e.g. "five_hour", "seven_day", "seven_day:fable". */
  id: z.string(),
  label: z.string(),
  kind: UsageWindowKind,
  unit: UsageUnit,
  /** Amount used, in `unit`. For percent, 0–100. */
  used: z.number().nonnegative(),
  /** Cap in `unit`, when there is one (omit for percent). */
  limit: z.number().nonnegative().optional(),
  resetsAt: IsoTime.optional(),
  /** Model this allowance is scoped to, if any. */
  model: z.string().optional(),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

export const UsageAccount = z.object({
  provider: ProviderId,
  /**
   * Stable, non-secret identity of the subscription account: a SHA-256 hex of
   * the provider's account/org/user id (or email when that's all there is).
   * NEVER derived from a token.
   */
  accountKey: z.string().regex(/^[a-f0-9]{64}$/),
  /**
   * Older keys this same account was reported under (e.g. by a helper that
   * keyed on machine-local data). The server folds those cards into this one.
   */
  aliases: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(4).optional(),
  /** Shown in the UI, e.g. the email or "Personal". Optional. */
  label: z.string().optional(),
  plan: z.string().optional(),
  status: CollectionStatus,
  /** Plain-words reason for any status other than ok. */
  message: z.string().optional(),
  /** When these windows were fetched from the provider (older than observedAt when stale). */
  fetchedAt: IsoTime.optional(),
  windows: z.array(UsageWindow),
});
export type UsageAccount = z.infer<typeof UsageAccount>;

export const UsageReport = z.object({
  observedAt: IsoTime,
  accounts: z.array(UsageAccount),
});
export type UsageReport = z.infer<typeof UsageReport>;

/**
 * A reading counts as current when its last poll was good and recent. Usage is
 * read every 5 minutes; after 30 minutes without a good read, it's not current.
 */
export const READING_CURRENT_MS = 30 * 60_000;

export function readingIsCurrent(status: string, fetchedAt: Date | string | null | undefined, now = Date.now()): boolean {
  if (status !== "ok" || !fetchedAt) return false;
  return now - new Date(fetchedAt).getTime() < READING_CURRENT_MS;
}
