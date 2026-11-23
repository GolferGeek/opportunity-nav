import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface System {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

export function system(overrides: Partial<System> = {}): System {
  const home = overrides.home ?? homedir();
  const platform = overrides.platform ?? process.platform;
  const env = overrides.env ?? { ...process.env, PATH: searchPath(process.env.PATH, home, platform) };
  return { home, env, platform };
}

/**
 * Apps started from the Dock or Finder get launchd's bare PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), so the desktop app's helper would miss
 * CLIs installed with npm or Homebrew, and `#!/usr/bin/env node` scripts like
 * codex couldn't find node. Append the usual install folders that are missing.
 */
export function searchPath(path: string | undefined, home: string, platform: NodeJS.Platform): string {
  const parts = (path ?? "").split(delimiter).filter(Boolean);
  if (platform === "win32") return parts.join(delimiter);
  const extra = [join(home, ".local/bin"), join(home, ".npm-global/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  return [...parts, ...extra.filter(dir => !parts.includes(dir))].join(delimiter);
}

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { OPNAV_NODE_TOKEN: _token, ...rest } = env;
  return rest;
}

export async function command(sys: System, file: string, args: string[], cwd?: string, timeout = 4000): Promise<string> {
  try {
    const run = exec(file, args, { cwd, env: childEnv(sys.env), timeout, maxBuffer: 256 * 1024 });
    run.child.stdin?.end();
    const { stdout } = await run;
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function executable(sys: System, names: string[]): Promise<string | undefined> {
  for (const name of names) {
    const roots = (sys.env.PATH ?? "").split(delimiter).filter(isAbsolute);
    for (const root of [...roots, join(sys.home, ".local/bin")]) {
      const file = join(root, name);
      try {
        await access(file, constants.X_OK);
        if (!(await stat(file)).isFile()) continue;
        return file;
      } catch {
        // Try the next directory.
      }
    }
  }
}

export function localPath(sys: System, value: string): string {
  if (value === "~") return sys.home;
  return value.startsWith("~/") ? join(sys.home, value.slice(2)) : resolve(value);
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function parse(text: string): Record<string, unknown> {
  try {
    return object(JSON.parse(text));
  } catch {
    return {};
  }
}

export async function json(path: string): Promise<Record<string, unknown>> {
  try {
    return parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

export function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function number(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : string(value) ? Number(value) : NaN;
  return Number.isFinite(numeric) ? numeric : undefined;
}

export function timestamp(value: unknown): string | undefined {
  const numeric = number(value);
  const date = new Date(numeric !== undefined ? numeric * (numeric < 1e11 ? 1000 : 1) : string(value) ?? "");
  return Number.isFinite(date.valueOf()) && date.valueOf() > 0 ? date.toISOString() : undefined;
}

const KEYCHAIN_RETRY_MS = 6 * 3_600_000;
const keychainRefused = new Map<string, number>();

/**
 * Read a macOS Keychain password without nagging. Checking that the item
 * exists never prompts; reading it can, the first time, so allow time for an
 * answer. If it's refused, don't ask again for six hours.
 */
export async function keychainSecret(sys: System, service: string, account: string): Promise<string> {
  if (sys.platform !== "darwin") return "";
  const key = `${sys.home}\0${service}\0${account}`;
  if (Date.now() - (keychainRefused.get(key) ?? -Infinity) < KEYCHAIN_RETRY_MS) return "";
  const exists = await command(sys, "security", ["find-generic-password", "-s", service, "-a", account]);
  if (!exists) return "";
  const secret = await command(sys, "security", ["find-generic-password", "-s", service, "-a", account, "-w"], undefined, 120_000);
  if (secret) keychainRefused.delete(key);
  else keychainRefused.set(key, Date.now());
  return secret;
}
