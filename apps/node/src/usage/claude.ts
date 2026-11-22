/* Usage collection adapted from omarchy-agent-usage-claude (MIT). */
import { join } from "node:path";
import { command, json, localPath, object, parse, string, timestamp } from "../system.ts";
import { percent, request } from "./common.ts";
import type { Adapter } from "./common.ts";

export const claude: Adapter = {
  provider: "claude",
  commands: ["claude"],
  async detect(sys) {
    const dir = localPath(sys, sys.env.CLAUDE_CONFIG_DIR ?? "~/.claude");
    let credentials = object((await json(join(dir, ".credentials.json"))).claudeAiOauth);
    if (!credentials.accessToken && sys.platform === "darwin") {
      credentials = object(parse(await command(sys, "security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"])).claudeAiOauth);
    }
    const token = string(credentials.accessToken);
    if (!token) return;
    const legacy = object((await json(join(dir, ".config.json"))).oauthAccount);
    const profile = Object.keys(legacy).length ? legacy :
      object((await json(join(sys.env.CLAUDE_CONFIG_DIR ? dir : sys.home, ".claude.json"))).oauthAccount);
    const subscription = string(credentials.subscriptionType);
    const tier = [profile.userRateLimitTier, profile.organizationRateLimitTier, credentials.rateLimitTier]
      .map(value => string(value)?.match(/max_(\d+x)/i)?.[1]).find(Boolean);
    const name = subscription && subscription[0]?.toUpperCase() + subscription.slice(1);
    return {
      id: string(profile.accountUuid) ?? string(profile.emailAddress)?.toLowerCase(),
      token, expiresAt: timestamp(credentials.expiresAt),
      plan: tier ? `${name ?? "Max"} ${tier}` : name,
    };
  },
  async read(ctx, login) {
    const data = await request(ctx, "https://api.anthropic.com/api/oauth/usage", login, undefined, {
      "anthropic-beta": "oauth-2025-04-20",
    });
    const windows = Object.entries(data).flatMap(([key, value]) => {
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
