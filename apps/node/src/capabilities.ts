import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Checkout, ProviderCapability } from "@opnav/shared";
import { command, executable, localPath } from "./system.ts";
import type { System } from "./system.ts";
import { adapters } from "./usage/index.ts";

export async function capabilities(sys: System): Promise<ProviderCapability[]> {
  const providers = await Promise.all(adapters.map(async adapter => {
    const [cliPath, login] = await Promise.all([executable(sys, adapter.commands), adapter.detect(sys)]);
    if (!cliPath && !login) return;
    const output = cliPath ? await command(sys, cliPath, ["--version"]) : "";
    const version = output.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
    return {
      provider: adapter.provider, cliPath, version, signedIn: !!login,
      canRunJobs: !!cliPath && (adapter.provider === "claude" || adapter.provider === "codex" || adapter.provider === "gemini"),
      locations: ["cloud"], models: [],
    } satisfies ProviderCapability;
  }));
  return providers.filter(value => value !== undefined);
}

export function normalizeRemote(remote: string): string | undefined {
  const scp = /^(?:[^@/:]+@)?([\w.-]+):([^/].*)$/.exec(remote);
  if (scp && !/^[a-z]:/i.test(remote)) {
    return remoteName(scp[1]!, scp[2]!);
  }
  try {
    const url = new URL(remote);
    if (!["ssh:", "git:", "http:", "https:"].includes(url.protocol)) return;
    return remoteName(url.host, url.pathname);
  } catch {
    return undefined;
  }
}

function remoteName(host: string, path: string): string | undefined {
  const clean = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (clean && !/[?#\s]/.test(clean)) return `${host.toLowerCase()}/${clean}`;
}

export async function checkouts(sys: System, roots: string[], maxDepth: number): Promise<Checkout[]> {
  const found = new Map<string, Checkout>();
  async function scan(path: string, depth: number) {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    if (entries.some(entry => entry.name === ".git" && (entry.isDirectory() || entry.isFile()))) {
      const [remote, branch] = await Promise.all([
        command(sys, "git", ["config", "--get", "remote.origin.url"], path),
        command(sys, "git", ["branch", "--show-current"], path),
      ]);
      found.set(path, { path, remote: normalizeRemote(remote), branch: branch || undefined });
      return;
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        await scan(join(path, entry.name), depth + 1);
      }
    }
  }
  for (const root of new Set(roots.map(value => localPath(sys, value)))) await scan(root, 0);
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}
