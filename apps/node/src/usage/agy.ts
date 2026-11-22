/* Usage collection adapted from omarchy-agent-usage-agy (MIT). */
import { join } from "node:path";
import { command, json, localPath, number, object, parse, string, timestamp } from "../system.ts";
import { jwt, percent, request } from "./common.ts";
import type { Adapter } from "./common.ts";

export const agy: Adapter = {
  provider: "agy",
  commands: ["agy"],
  async detect(sys) {
    const secret = sys.platform === "darwin"
      ? await command(sys, "security", ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"])
      : await command(sys, "secret-tool", ["lookup", "service", "gemini", "username", "antigravity"]);
    const prefix = "go-keyring-base64:";
    const keyring = parse(secret.startsWith(prefix) ? Buffer.from(secret.slice(prefix.length), "base64").toString("utf8") : secret);
    const saved = Object.keys(keyring).length ? keyring :
      await json(join(localPath(sys, sys.env.AGY_DIR ?? "~/.gemini/antigravity-cli"), "antigravity-oauth-token"));
    const oauth = object(saved.token);
    const token = string(oauth.access_token ?? saved.access_token);
    if (!token) return;
    const claims = jwt(string(oauth.id_token ?? saved.id_token));
    return { token, id: string(claims.sub) ?? string(claims.email ?? saved.email)?.toLowerCase(),
      expiresAt: timestamp(oauth.expiry ?? saved.expiry) };
  },
  async read(ctx, login) {
    const base = "https://daily-cloudcode-pa.googleapis.com/v1internal:";
    const headers = { "User-Agent": "antigravity" };
    if (!login.id) {
      const profile = await request(ctx, "https://openidconnect.googleapis.com/v1/userinfo", login);
      login.id = string(profile.sub) ?? string(profile.email)?.toLowerCase();
    }
    const assist = await request(ctx, base + "loadCodeAssist", login, {}, headers);
    const project = string(assist.cloudaicompanionProject) ?? string(object(assist.cloudaicompanionProject).id);
    const quota = await request(ctx, base + "retrieveUserQuotaSummary", login, project ? { project } : {}, headers);
    const groups = Array.isArray(quota.groups) ? quota.groups : [{ displayName: "Gemini", buckets: quota.buckets }];
    const windows = groups.flatMap(raw => {
      const group = object(raw);
      const label = string(group.displayName) ?? "Gemini";
      if (!Array.isArray(group.buckets)) return [];
      return group.buckets.flatMap(rawBucket => {
        const bucket = object(rawBucket);
        const id = string(bucket.bucketId ?? bucket.window ?? bucket.displayName);
        if (!id || bucket.disabled === true) return [];
        const reset = bucket.resetTime ?? bucket.reset_time;
        const fraction = number(bucket.remainingFraction ?? bucket.remaining_fraction);
        const amount = bucket.remainingAmount ?? bucket.remaining_amount;
        const remaining = fraction ?? (number(amount) === 0 || (amount == null && timestamp(reset)) ? 0 : undefined);
        const key = `${id} ${string(bucket.window) ?? ""}`;
        const kind = /week/i.test(key) ? "weekly" : /5h|five/i.test(key) ? "session" : "period";
        return percent(`${label}:${id}`, `${label} ${kind === "session" ? "5-hour" : kind === "weekly" ? "weekly" : id}`,
          kind, remaining === undefined ? undefined : (1 - remaining) * 100, reset);
      });
    });
    const tier = object(assist.paidTier ?? assist.currentTier);
    return { plan: string(tier.name ?? tier.id), windows };
  },
};
