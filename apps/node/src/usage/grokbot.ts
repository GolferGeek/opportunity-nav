/* Usage collection adapted from omarchy-agent-usage-grokbot (MIT). */
import { cursorLogin, dashboard } from "./cursor.ts";
import { percent } from "./common.ts";
import type { Adapter } from "./common.ts";

export const grokbot: Adapter = {
  provider: "grokbot",
  commands: ["grokbot"],
  detect: cursorLogin,
  async read(ctx, login) {
    const status = await dashboard(ctx, login, "GetSandUsageStatus");
    if (status.hasNonZeroIncludedLimit === false || Object.keys(status).length === 0) {
      return { windows: [], unavailable: "This account has no Grok Bot allowance." };
    }
    return { windows: status.hasNonZeroIncludedLimit === true ?
      percent("weekly", "Weekly", "weekly", status.usagePercent ?? 0, status.nextResetTimestampUtc) : [] };
  },
};
