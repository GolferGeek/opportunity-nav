import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { UsageAccount } from "@opnav/shared";
import type { ProviderId } from "@opnav/shared";
import { json, localPath } from "../system.ts";
import type { System } from "../system.ts";

const stateDir = (sys: System) => join(localPath(sys, sys.env.XDG_STATE_HOME ?? "~/.local/state"), "opnav", "usage");

async function save(dir: string, path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch {
    // An unwritable cache does not invalidate a fresh reading.
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Remembers which account a saved sign-in belongs to, once a reading has told
 * us, so a later stale reading (expired access token) still reports under the
 * same account. Keyed by a hash of the sign-in; the sign-in itself is never stored.
 */
export function identityCache(sys: System) {
  const dir = stateDir(sys);
  const pathFor = (signIn: string) => join(dir, `identity-${signIn}.json`);
  return {
    async read(signIn: string): Promise<string | undefined> {
      const saved = await json(pathFor(signIn));
      return typeof saved.id === "string" && saved.id ? saved.id : undefined;
    },
    async write(signIn: string, id: string) {
      await save(dir, pathFor(signIn), { id });
    },
  };
}

export function usageCache(sys: System) {
  const dir = stateDir(sys);
  const pathFor = (provider: ProviderId, accountKey: string) => join(dir, `${provider}-${accountKey}.json`);
  return {
    async read(provider: ProviderId, accountKey: string): Promise<UsageAccount | undefined> {
      const saved = UsageAccount.safeParse(await json(pathFor(provider, accountKey)));
      if (saved.success && saved.data.provider === provider && saved.data.accountKey === accountKey &&
        saved.data.status === "ok" && saved.data.fetchedAt) return saved.data;
    },
    async write(account: UsageAccount) {
      await save(dir, pathFor(account.provider, account.accountKey), account);
    },
  };
}
