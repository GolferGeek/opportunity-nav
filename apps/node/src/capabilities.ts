import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { MachineTool } from "@opnav/shared";
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
      canRunJobs: !!cliPath && (adapter.provider === "claude" || adapter.provider === "codex" || adapter.provider === "agy"),
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
      // origin's address as Git will really use it, after any insteadOf rewrite.
      const [remote, branch] = await Promise.all([
        command(sys, "git", ["remote", "get-url", "origin"], path),
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

/**
 * What this machine has for jobs that need more than an agent and a repo.
 * docker = a running Docker engine; database = a Postgres accepting
 * connections here. The machine's owner can say it outright with
 * OPNAV_MACHINE_TOOLS ("docker,database", or "none").
 */
export async function machineTools(sys: System): Promise<MachineTool[]> {
  const declared = sys.env.OPNAV_MACHINE_TOOLS?.trim();
  if (declared !== undefined && declared !== "") {
    const names = declared.toLowerCase().split(/[\s,]+/);
    return MachineTool.options.filter(tool => names.includes(tool));
  }
  const [docker, pgIsReady] = await Promise.all([executable(sys, ["docker"]), executable(sys, ["pg_isready"])]);
  const [engine, postgres] = await Promise.all([
    docker ? command(sys, docker, ["info", "--format", "{{.ServerVersion}}"]) : "",
    pgIsReady ? command(sys, pgIsReady, []) : "",
  ]);
  const tools: MachineTool[] = [];
  if (engine) tools.push("docker");
  if (postgres) tools.push("database");
  return tools;
}
