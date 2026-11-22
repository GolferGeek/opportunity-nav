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
import { AuthRequired } from "./common.ts";
import type { Adapter, Login, UsageContext } from "./common.ts";

export const adapters = [claude, codex, cursor, grokbot, agy, grok, gemini];

export function createUsageCollector(ctx: UsageContext) {
  const cache = new Map<string, UsageAccount>();

  async function collect(adapter: Adapter, login: Login): Promise<{ account?: UsageAccount; retry: boolean }> {
    const key = () => login.id && createHash("sha256").update(login.id).digest("hex");
    try {
      const reading = await adapter.read(ctx, login);
      const accountKey = key();
      if (!accountKey) return { retry: false };
      const account = UsageAccount.parse({
        provider: adapter.provider, accountKey, plan: reading.plan ?? login.plan,
        status: reading.unavailable ? "unavailable" : "ok", message: reading.unavailable,
        fetchedAt: reading.unavailable ? undefined : new Date().toISOString(), windows: reading.windows,
      });
      if (!reading.unavailable && !account.windows.length) throw new Error("No usage windows");
      if (account.status === "ok") cache.set(`${adapter.provider}:${accountKey}`, account);
      return { account, retry: false };
    } catch (error) {
      const auth = error instanceof AuthRequired;
      const accountKey = key();
      if (!accountKey) return { retry: !auth };
      const last = cache.get(`${adapter.provider}:${accountKey}`);
      const now = Date.now();
      return {
        retry: !auth,
        account: {
          provider: adapter.provider, accountKey, plan: login.plan ?? last?.plan,
          status: last ? "stale" : auth ? "auth_required" : "error",
          message: auth ? `Open ${adapter.provider} to renew its sign-in.` : "Usage could not be refreshed.",
          fetchedAt: last?.fetchedAt,
          windows: last?.windows.map(window => window.resetsAt && Date.parse(window.resetsAt) <= now
            ? { ...window, used: 0, resetsAt: undefined } : { ...window }) ?? [],
        },
      };
    }
  }

  return async (): Promise<{ report: UsageReport; retry: boolean }> => {
    const results = await Promise.all(adapters.map(async adapter => {
      const login = await adapter.detect(ctx.sys);
      return login ? collect(adapter, login) : { retry: false };
    }));
    return {
      report: { observedAt: new Date().toISOString(), accounts: results.flatMap(result => result.account ? [result.account] : []) },
      retry: results.some(result => result.retry),
    };
  };
}
