/* Usage collection adapted from omarchy-agent-usage-grokbot (MIT). */
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { join } from "node:path";
import { command, json, object, parse, string, timestamp } from "../system.ts";
import type { System } from "../system.ts";
import { cursorLogin, dashboard } from "./cursor.ts";
import { AuthRequired, jwt, percent } from "./common.ts";
import type { Adapter, Login } from "./common.ts";

const KEYCHAIN_RETRY_MS = 6 * 3_600_000;
const keys = new Map<string, { key: Promise<Buffer | undefined>; at: number }>();
export const keychainHelp = "Grok Bot keeps its sign-in in the macOS keychain. When macOS asks to use “Grok Bot Safe Storage”, choose Always Allow.";

/** Electron safeStorage on macOS: AES-128-CBC with a key derived from the app's keychain password. */
function safeStorageKey(sys: System): Promise<Buffer | undefined> {
  const cached = keys.get(sys.home);
  if (cached && Date.now() - cached.at < KEYCHAIN_RETRY_MS) return cached.key;
  // The first read shows a macOS prompt, so give it time to be answered.
  const key = command(sys, "security", ["find-generic-password", "-s", "Grok Bot Safe Storage", "-a", "Grok Bot Key", "-w"],
    undefined, 120_000).then(password => password ? pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1") : undefined);
  keys.set(sys.home, { key, at: Date.now() });
  key.then(value => { if (value) keys.set(sys.home, { key, at: Infinity }); });
  return key;
}

export function decryptSafeStorage(value: unknown, key: Buffer): string | undefined {
  const data = Buffer.from(string(value) ?? "", "base64");
  if (data.subarray(0, 3).toString() !== "v10") return;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
    return string(Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]).toString("utf8"));
  } catch {
    return undefined;
  }
}

/** The Grok Bot app's own Cursor sign-in on macOS, read-only. Falls back to the Cursor sign-in. */
export async function grokbotLogin(sys: System): Promise<Login | undefined> {
  return await grokbotApp(sys) ?? cursorLogin(sys);
}

/** Undefined when the Grok Bot app has no saved sign-in on this machine. */
export async function grokbotApp(sys: System): Promise<Login | undefined> {
  if (sys.platform !== "darwin") return;
  const secrets = await json(join(sys.home, "Library/Application Support/Grok Bot/sand-secrets.json"));
  const store = parse(string(secrets["cursor-accounts"]) ?? "");
  const accounts = object(store.accounts);
  const entry = object(accounts[string(store.active) ?? ""] ?? Object.values(accounts)[0]);
  if (!string(entry["cursor-access-token"]) && !string(entry["cursor-refresh-token"])) return;
  const key = await safeStorageKey(sys);
  if (!key) {
    // Grok Bot names each account by the SHA-256 of its Cursor subject, so the card keeps its identity.
    const cursor = await cursorLogin(sys);
    const subject = string(jwt(cursor?.token).sub);
    const same = subject && createHash("sha256").update(subject).digest("hex") === store.active;
    return { id: same ? cursor?.id : string(store.active), metadata: { keychain: "not allowed" } };
  }
  const token = decryptSafeStorage(entry["cursor-access-token"], key);
  const refreshToken = decryptSafeStorage(entry["cursor-refresh-token"], key);
  if (!token && !refreshToken) return;
  const claims = jwt(token ?? refreshToken);
  return { token, refreshToken, id: string(claims.sub)?.split("|").at(-1) ?? string(store.active),
    expiresAt: token ? timestamp(claims.exp) : undefined, refreshExpiresAt: timestamp(jwt(refreshToken).exp) };
}

export const grokbot: Adapter = {
  provider: "grokbot",
  commands: ["grokbot"],
  detect: grokbotLogin,
  async read(ctx, login) {
    if (login.metadata?.keychain) throw new AuthRequired(keychainHelp);
    if (login.credential && !login.token && !login.refreshToken) {
      return { windows: [], unavailable: "Cursor API key sign-ins have no Grok Bot allowance." };
    }
    const status = await dashboard(ctx, login, "GetSandUsageStatus");
    if (status.hasNonZeroIncludedLimit === false || Object.keys(status).length === 0) {
      return { windows: [], unavailable: "This account has no Grok Bot allowance." };
    }
    return { windows: status.hasNonZeroIncludedLimit === true ?
      percent("weekly", "Weekly", "weekly", status.usagePercent ?? 0, status.nextResetTimestampUtc) : [] };
  },
};
