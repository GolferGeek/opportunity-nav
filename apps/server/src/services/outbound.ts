import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { HttpError } from "../errors.ts";

/**
 * Sending to agents that can't be called over A2A, like Grok Bot (a Cursor
 * automation webhook). The URL and key live in a 0600 file on the server
 * (line 1: URL, line 2: key), never in the database or the code.
 */
const file = () => process.env.OPNAV_GROKBOT_WEBHOOK_FILE ?? path.join(homedir(), ".config/opportunity-nav/grokbot-webhook");

export async function messageGrokBot(message: string, from: string) {
  const raw = await readFile(file(), "utf8").catch(() => null);
  const [url, key] = (raw ?? "").split(/\r?\n/).map((s) => s.trim());
  if (!url || !key) throw new HttpError(503, "Grok Bot's webhook isn't set up on this server.");
  const body = { message: `From ${from}, via Opportunity Nav: ${message}`, source: "opportunity-nav" };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!r) throw new HttpError(502, "Couldn't reach Grok Bot's webhook.");
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok || data.success === false) throw new HttpError(502, `Grok Bot's webhook said ${r.status}.`);
  return { sent: true, runId: data.runUuid ?? null };
}
