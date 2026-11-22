import { createHash } from "node:crypto";
import { UsageAccount } from "@opnav/shared";
import type { UsageReport } from "@opnav/shared";
import { agy } from "./agy.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { cursor } from "./cursor.ts";
import { grok } from "./grok.ts";
import { grokbot } from "./grokbot.ts";
import { identityCache, usageCache } from "./cache.ts";
import { AuthRequired, LoginStale } from "./common.ts";
import type { Adapter, Login, UsageContext } from "./common.ts";

export const adapters = [claude, codex, cursor, grokbot, agy, grok];

const displayNames = {
  claude: "Claude Code", codex: "Codex", cursor: "Cursor", grokbot: "Grok Bot",
  grok: "Grok", agy: "Antigravity", gemini: "Gemini CLI", ollama: "Ollama", mlx: "MLX",
};

export function createUsageCollector(ctx: UsageContext) {
  const cache = new Map<string, UsageAccount>();
  const disk = usageCache(ctx.sys);
  const identities = identityCache(ctx.sys);
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");

  async function collect(adapter: Adapter, login: Login): Promise<{ account?: UsageAccount; retry: boolean }> {
    // The key must name the account, so every machine signed in to it agrees.
    // A sign-in is machine-local (each machine has its own refresh token), so it
    // is only the last resort, and an account learned later is remembered for it.
    const signIn = login.refreshToken ?? login.credential ?? login.token;
    const signInKey = signIn && sha(`${adapter.provider}\n${signIn}`);
    if (!login.id && signInKey) login.id = await identities.read(signInKey);
    const machineKey = sha(signIn ?? ctx.sys.home);
    const key = () => sha(login.id ?? signIn ?? ctx.sys.home);
    // Keys older helpers reported this account under, so the server can fold those cards in.
    const aliases = () => {
      const accountKey = key();
      const old = [...new Set([machineKey, ...(login.formerIds ?? []).map(sha)])].filter(k => k !== accountKey);
      return old.length ? old.slice(0, 4) : undefined;
    };
    try {
      const reading = await adapter.read(ctx, login);
      if (login.id && signInKey) await identities.write(signInKey, login.id);
      const accountKey = key();
      const account = UsageAccount.parse({
        provider: adapter.provider, accountKey, aliases: aliases(), plan: reading.plan ?? login.plan,
        status: reading.unavailable ? "unavailable" : "ok", message: reading.unavailable,
        fetchedAt: reading.unavailable ? undefined : new Date().toISOString(), windows: reading.windows,
      });
      if (!reading.unavailable && !account.windows.length) throw new Error("No usage windows");
      if (account.status === "ok") {
        cache.set(`${adapter.provider}:${accountKey}`, account);
        await disk.write(account);
      }
      return { account, retry: false };
    } catch (error) {
      const auth = error instanceof AuthRequired;
      const accountKey = key();
      const lapsed = error instanceof LoginStale;
      const name = displayNames[adapter.provider];
      const old = aliases();
      let last = cache.get(`${adapter.provider}:${accountKey}`) ?? await disk.read(adapter.provider, accountKey);
      for (const alias of old ?? []) last ??= await disk.read(adapter.provider, alias);
      const now = Date.now();
      return {
        retry: !auth,
        account: {
          provider: adapter.provider, accountKey, aliases: old, plan: login.plan ?? last?.plan,
          status: auth ? "auth_required" : last || lapsed ? "stale" : "error",
          message: lapsed ? `Start ${name} to refresh it. No need to sign in again.`
            : auth ? error.message && error.message !== "refused" ? error.message : `Sign in to ${name} to refresh usage.`
            : `${name} usage could not be refreshed.`,
          fetchedAt: last?.fetchedAt,
          windows: last?.windows.map(window => window.resetsAt && Date.parse(window.resetsAt) <= now
            ? { ...window, used: 0, resetsAt: undefined } : { ...window }) ?? [],
        },
      };
    }
  }

  return async (): Promise<{ report: UsageReport; retry: boolean }> => {
    const results = await Promise.all(adapters.map(async adapter => {
      try {
        const login = await adapter.detect(ctx.sys);
        return login ? await collect(adapter, login) : { account: undefined, retry: false };
      } catch {
        return { account: undefined, retry: true };
      }
    }));
    return {
      report: { observedAt: new Date().toISOString(), accounts: results.flatMap(result => result.account ? [result.account] : []) },
      retry: results.some(result => result.retry),
    };
  };
}
