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
  return { home: homedir(), env: process.env, platform: process.platform, ...overrides };
}

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { OPNAV_NODE_TOKEN: _token, ...rest } = env;
  return rest;
}

export async function command(sys: System, file: string, args: string[], cwd?: string): Promise<string> {
  try {
    const run = exec(file, args, { cwd, env: childEnv(sys.env), timeout: 4000, maxBuffer: 256 * 1024 });
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
