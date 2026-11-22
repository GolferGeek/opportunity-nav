import { createHash } from "node:crypto";
import { UsageAccount } from "@opnav/shared";
import type { UsageReport } from "@opnav/shared";
import { agy } from "./agy.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { cursor } from "./cursor.ts";
import { gemini } from "./gemini.ts";
import { grok } from "./grok.ts";
import { grokbot } from "./grokbot.ts";
import { usageCache } from "./cache.ts";
import { AuthRequired, LoginStale } from "./common.ts";
import type { Adapter, Login, UsageContext } from "./common.ts";

export const adapters = [claude, codex, cursor, grokbot, agy, grok, gemini];

const displayNames = {
  claude: "Claude Code", codex: "Codex", cursor: "Cursor", grokbot: "Grok Bot",
  grok: "Grok", agy: "Antigravity", gemini: "Gemini CLI", ollama: "Ollama", mlx: "MLX",
};

export function createUsageCollector(ctx: UsageContext) {
  const cache = new Map<string, UsageAccount>();
  const disk = usageCache(ctx.sys);

  async function collect(adapter: Adapter, login: Login): Promise<{ account?: UsageAccount; retry: boolean }> {
    const key = () => createHash("sha256")
      .update(login.id ?? login.refreshToken ?? login.credential ?? login.token ?? ctx.sys.home)
      .digest("hex");
    try {
      const reading = await adapter.read(ctx, login);
      const accountKey = key();
      const account = UsageAccount.parse({
        provider: adapter.provider, accountKey, plan: reading.plan ?? login.plan,
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
      const last = cache.get(`${adapter.provider}:${accountKey}`) ?? await disk.read(adapter.provider, accountKey);
      const now = Date.now();
      return {
        retry: !auth,
        account: {
          provider: adapter.provider, accountKey, plan: login.plan ?? last?.plan,
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
