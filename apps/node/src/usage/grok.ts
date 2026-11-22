/* Usage collection adapted from omarchy-agent-usage-grok (MIT). */
import { join } from "node:path";
import { json, localPath, number, object, parse, string, timestamp } from "../system.ts";
import { jwt, percent, request } from "./common.ts";
import type { Adapter } from "./common.ts";

function amount(value: unknown) {
  return value && typeof value === "object" ? number(object(value).val ?? 0) : number(value);
}

export const grok: Adapter = {
  provider: "grok",
  commands: ["grok"],
  async detect(sys) {
    const home = localPath(sys, sys.env.GROK_HOME ?? "~/.grok");
    const auth = await json(join(home, "auth.json"));
    for (const value of Object.values(auth)) {
      const entry = object(value);
      const token = string(entry.key);
      const refreshToken = string(entry.refresh_token);
      if (!token && !refreshToken) continue;
      const claims = jwt(token);
      const identity = jwt(string(entry.id_token));
      const expiresAt = timestamp(entry.expires_at ?? claims.exp);
      // Grok's collector treats refresh as valid for 30 days after access expiry.
      const refreshExpiresAt = timestamp(entry.refresh_token_expires_at)
        ?? (expiresAt && new Date(Date.parse(expiresAt) + 30 * 86_400_000).toISOString());
      const cache = await json(join(home, "settings_cache.json"));
      const settings = object(parse(string(cache.payload) ?? "").settings);
      return { token, refreshToken, refreshExpiresAt,
        id: string(identity.sub ?? claims.sub ?? entry.user_id ?? entry.account_id) ?? string(identity.email ?? entry.email)?.toLowerCase(),
        expiresAt, plan: string(settings.subscription_tier_display) };
    }
  },
  async read(ctx, login) {
    const base = "https://cli-chat-proxy.grok.com/v1/billing";
    const [monthly, credits] = await Promise.allSettled([
      request(ctx, base, login), request(ctx, base + "?format=credits", login),
    ]);
    const billing = monthly.status === "fulfilled" ? object(monthly.value.config) : {};
    const credit = credits.status === "fulfilled" ? object(credits.value.config) : {};
    if (!login.refreshToken) login.id ??= string(billing.userId ?? credit.userId);
    const cap = amount(billing.monthlyLimit);
    const used = amount(billing.used);
    const period = object(credit.currentPeriod);
    const weekly = /week/i.test(string(period.type) ?? "");
    if (monthly.status === "rejected") throw monthly.reason;
    if (credits.status === "rejected") throw credits.reason;
    const windows = cap && cap > 0 && used !== undefined
      ? percent("monthly", "Monthly quota", "monthly", used * 100 / cap, billing.billingPeriodEnd) : [];
    const end = timestamp(period.end);
    if (end && !(credit.isUnifiedBillingUser === true && credit.creditUsagePercent == null && windows.length)) {
      windows.push(...percent("credits", "Included credits", weekly ? "weekly" : "monthly",
        amount(credit.creditUsagePercent) ?? (Date.parse(end) > Date.now() ? 0 : undefined), end));
    }
    return { windows };
  },
};
