/* Usage collection adapted from omarchy-agent-usage-claude (MIT). */
import { join } from "node:path";
import { command, json, localPath, object, parse, string, timestamp } from "../system.ts";
import { jwt, percent, request } from "./common.ts";
import type { Adapter } from "./common.ts";

export const claude: Adapter = {
  provider: "claude",
  commands: ["claude"],
  async detect(sys) {
    const dir = localPath(sys, sys.env.CLAUDE_CONFIG_DIR ?? "~/.claude");
    let credentials = object((await json(join(dir, ".credentials.json"))).claudeAiOauth);
    if (!credentials.accessToken && !credentials.refreshToken && sys.platform === "darwin") {
      credentials = object(parse(await command(sys, "security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"])).claudeAiOauth);
    }
    const token = string(credentials.accessToken);
    const refreshToken = string(credentials.refreshToken);
    if (!token && !refreshToken) return;
    const claims = jwt(string(credentials.idToken));
    const legacy = object((await json(join(dir, ".config.json"))).oauthAccount);
    const profile = Object.keys(legacy).length ? legacy :
      object((await json(join(sys.env.CLAUDE_CONFIG_DIR ? dir : sys.home, ".claude.json"))).oauthAccount);
    const subscription = string(credentials.subscriptionType);
    const tier = [profile.userRateLimitTier, profile.organizationRateLimitTier, credentials.rateLimitTier]
      .map(value => string(value)?.match(/max_(\d+x)/i)?.[1]).find(Boolean);
    const name = subscription && subscription[0]?.toUpperCase() + subscription.slice(1);
    return {
      id: string(claims.sub) ?? string(profile.accountUuid) ?? string(profile.emailAddress ?? claims.email)?.toLowerCase(),
      token, refreshToken, refreshExpiresAt: timestamp(credentials.refreshTokenExpiresAt), expiresAt: timestamp(credentials.expiresAt),
      plan: tier ? `${name ?? "Max"} ${tier}` : name,
    };
  },
  async read(ctx, login) {
    const data = await request(ctx, "https://api.anthropic.com/api/oauth/usage", login, undefined, {
      "anthropic-beta": "oauth-2025-04-20",
    });
    const windows = Array.isArray(data.limits) ? data.limits.flatMap(raw => {
      const item = object(raw);
      const id = string(item.kind);
      if (!id) return [];
      const model = string(object(object(item.scope).model).display_name);
      const group = string(item.group) ?? id;
      const weekly = /^week/.test(group);
      const session = /^(five.hour|5.hour|session)/.test(group);
      const kind = weekly ? "weekly" : session ? "session" : "period";
      const label = weekly ? "Weekly" : session ? "5-hour" : group;
      return percent(model ? `${id}:${model.toLowerCase()}` : id,
        model ? `${model} ${label.toLowerCase()}` : label, kind, item.percent, item.resets_at, model);
    }) : Object.entries(data).flatMap(([key, value]) => {
      const match = /^(five_hour|seven_day)(?:_(.+))?$/.exec(key);
      if (!match) return [];
      const item = object(value);
      const label = match[1] === "five_hour" ? "5-hour" : "Weekly";
      return percent(key, match[2] ? `${label} ${match[2]}` : label,
        match[1] === "five_hour" ? "session" : "weekly", item.utilization, item.resets_at, match[2]);
    });
    const extra = object(data.extra_usage);
    if (extra.is_enabled === true) windows.push(...percent("extra_usage", "Extra usage", "spend", extra.utilization));
    return { windows };
  },
};
