import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { UsageAccount } from "@opnav/shared";
import type { ProviderId } from "@opnav/shared";
import { json, localPath } from "../system.ts";
import type { System } from "../system.ts";

export function usageCache(sys: System) {
  const dir = join(localPath(sys, sys.env.XDG_STATE_HOME ?? "~/.local/state"), "opnav", "usage");
  const pathFor = (provider: ProviderId, accountKey: string) => join(dir, `${provider}-${accountKey}.json`);
  return {
    async read(provider: ProviderId, accountKey: string): Promise<UsageAccount | undefined> {
      const saved = UsageAccount.safeParse(await json(pathFor(provider, accountKey)));
      if (saved.success && saved.data.provider === provider && saved.data.accountKey === accountKey &&
        saved.data.status === "ok" && saved.data.fetchedAt) return saved.data;
    },
    async write(account: UsageAccount) {
      const path = pathFor(account.provider, account.accountKey);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify(account), { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } catch {
        // An unwritable cache does not invalidate a fresh reading.
        await rm(temporary, { force: true }).catch(() => {});
      }
    },
  };
}
