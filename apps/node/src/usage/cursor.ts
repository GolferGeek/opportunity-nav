/* Usage collection adapted from omarchy-agent-usage-cursor and collectors.py (MIT). */
import { join } from "node:path";
import { command, json, localPath, number, object, string, timestamp } from "../system.ts";
import type { System } from "../system.ts";
import { AuthRequired, jwt, percent, request } from "./common.ts";
import type { Adapter, Login, UsageContext } from "./common.ts";
import type { UsageWindow } from "@opnav/shared";

export async function cursorLogin(sys: System): Promise<Login | undefined> {
  const config = sys.env.XDG_CONFIG_HOME ?? join(sys.home, ".config");
  const cli = await json(localPath(sys, sys.env.CURSOR_AUTH_PATH ?? join(config, "cursor/auth.json")));
  const envToken = string(sys.env.CURSOR_AUTH_TOKEN);
  const cliToken = string(cli.accessToken);
  const cliExpiry = timestamp(jwt(cliToken).exp);
  let token = envToken ?? cliToken;
  const apiKey = string(sys.env.CURSOR_API_KEY ?? cli.apiKey);
  if (!envToken && sys.env.CURSOR_API_KEY && cli.apiKey !== sys.env.CURSOR_API_KEY) {
    return { credential: apiKey };
  }
  if (!envToken && !sys.env.CURSOR_API_KEY && (!token || (cliExpiry && Date.parse(cliExpiry) <= Date.now()))) {
    const root = sys.platform === "darwin" ? join(sys.home, "Library/Application Support") : config;
    const editor = await command(sys, "sqlite3", ["-readonly", join(root, "Cursor/User/globalStorage/state.vscdb"),
      "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1"]);
    token = string(editor) ?? token;
  }
  const saved = !envToken && token === cliToken;
  const refreshToken = saved ? string(cli.refreshToken ?? cli.refresh_token) : undefined;
  if (!token && !refreshToken && !apiKey) return;
  const identity = saved ? jwt(string(cli.idToken ?? cli.id_token)) : {};
  const claims = jwt(token);
  const subject = string(claims.sub);
  return {
    id: string(identity.sub) ?? subject?.split("|").at(-1)
      ?? (saved ? string(cli.userId) ?? string(identity.email ?? cli.email)?.toLowerCase() : undefined),
    token, refreshToken, credential: apiKey,
    expiresAt: timestamp(claims.exp ?? (saved ? cli.expiresAt : undefined)),
    refreshExpiresAt: saved ? timestamp(cli.refreshTokenExpiresAt ?? cli.refresh_token_expires_at) : undefined,
  };
}

export function dashboard(ctx: UsageContext, login: Login, method: string, body: object = {}) {
  return request(ctx, `https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`, login, body, {
    "Connect-Protocol-Version": "1", "x-cursor-client-type": "cli",
  });
}

async function dailyTokens(ctx: UsageContext, login: Login): Promise<UsageWindow[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, index) => {
    const start = new Date(today);
    start.setDate(start.getDate() - index);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
  });
  const readings = await Promise.all(days.map(async ({ start, end }) => {
    const data = await dashboard(ctx, login, "GetAggregatedUsageEvents", {
      startDate: String(+start), endDate: String(+end),
    }).catch(() => undefined);
    if (!Array.isArray(data?.aggregations)) return [];
    const totals = new Map<string, number>();
    for (const raw of data.aggregations) {
      const row = object(raw);
      const model = string(row.modelIntent) ?? "Cursor";
      const total = [row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens]
        .reduce<number>((sum, value) => sum + Math.max(0, number(value) ?? 0), 0);
      if (total > 0) totals.set(model, (totals.get(model) ?? 0) + total);
    }
    const day = [start.getFullYear(), String(start.getMonth() + 1).padStart(2, "0"),
      String(start.getDate()).padStart(2, "0")].join("-");
    return [...totals].map(([model, used]): UsageWindow => ({
      id: `tokens:${day}:${model}`, label: `${model} tokens for ${day}`, kind: "period", unit: "tokens", used, model,
    }));
  }));
  return readings.flat();
}

export const cursor: Adapter = {
  provider: "cursor",
  commands: ["cursor-agent", "agent", "cursor"],
  detect: cursorLogin,
  async read(ctx, login) {
    if (login.credential && !login.token && !login.refreshToken) {
      return { windows: [], unavailable: "Cursor API key sign-ins have no subscription limits." };
    }
    const [period, response] = await Promise.all([
      dashboard(ctx, login, "GetCurrentPeriodUsage"),
      dashboard(ctx, login, "GetPlanInfo"),
    ]).catch(error => {
      if (error instanceof AuthRequired && error.message === "refused") {
        throw new AuthRequired("Cursor refused the saved sign-in. Sign in to the Cursor editor, or run `cursor-agent login`.");
      }
      throw error;
    });
    const plan = object(response.planInfo ?? response);
    const weekly = plan.includedUsagePeriod === 2 || /^(INCLUDED_USAGE_PERIOD_)?WEEKLY$/i.test(string(plan.includedUsagePeriod) ?? "");
    const reset = weekly ? plan.includedUsageResetsAt : period.billingCycleEnd;
    const included = object(period.planUsage);
    const windows = [
      ["total", "Included total", included.totalPercentUsed],
      ["auto", "Auto models", included.autoPercentUsed],
      ["named", "Named models", included.apiPercentUsed],
    ].flatMap(([id, label, value]) => percent(String(id), String(label), weekly ? "weekly" : "monthly",
      value, reset));
    const spend = object(period.spendLimitUsage);
    const used = number(spend.individualUsed);
    const limit = number(spend.individualLimit);
    if (used !== undefined && used >= 0 && limit && limit > 0) {
      const window: UsageWindow = { id: "on_demand", label: "On-demand spend", kind: "spend",
        unit: "usd", used: used / 100, limit: limit / 100, resetsAt: timestamp(period.billingCycleEnd) };
      windows.push(window);
    }
    if (windows.length) windows.push(...await dailyTokens(ctx, login));
    return { plan: string(plan.planName) ?? string(period.membershipType) ?? string(plan.planType), windows };
  },
};
