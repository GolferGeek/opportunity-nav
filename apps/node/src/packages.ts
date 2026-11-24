import { execFile } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { executable } from "./system.ts";
import type { System } from "./system.ts";
import { worktreeEnv } from "./worktrees.ts";

const exec = promisify(execFile);
const installTimeout = 120_000;

type Manager = "npm" | "pnpm";

async function exists(path: string) {
  return access(path).then(() => true, () => false);
}

async function git(sys: System, cwd: string, ...args: string[]) {
  const run = exec("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], { env: worktreeEnv(sys), timeout: 30_000 });
  run.child.stdin?.end();
  return (await run).stdout;
}

/** Which package manager the repo's lockfile at the worktree's top names, if any. */
export async function lockfileManager(path: string): Promise<Manager | "other" | undefined> {
  if (!await exists(join(path, "package.json"))) return undefined;
  if (await exists(join(path, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(path, "package-lock.json")) || await exists(join(path, "npm-shrinkwrap.json"))) return "npm";
  for (const other of ["yarn.lock", "bun.lock", "bun.lockb"]) {
    if (await exists(join(path, other))) return "other";
  }
  return undefined;
}

/**
 * Offline only: everything comes from this machine's npm cache or pnpm store, nothing from the
 * registry (an agent's sandbox can't reach it anyway). Lockfiles are only read, never written,
 * and no package scripts run.
 */
export function installArgs(manager: Manager): string[] {
  return manager === "npm"
    ? ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier", "--loglevel=error"]
    : ["install", "--offline", "--frozen-lockfile", "--ignore-scripts", "--reporter=append-only"];
}

/** A plain reason from the package manager's error output: its error code, never the raw text. */
export function installReason(manager: Manager, output: string): string {
  if (/ENOTCACHED|ERR_PNPM_NO_OFFLINE|NO_OFFLINE_TARBALL|NO_OFFLINE_META|not in (the )?(local )?(store|cache)/i.test(output)) {
    return manager === "npm" ? "a package it needs isn't in this machine's npm cache" : "a package it needs isn't in this machine's pnpm store";
  }
  if (/EUSAGE|in sync|ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_LOCKFILE/i.test(output)) {
    return "package.json and the lockfile don't match";
  }
  const code = /npm (?:error|ERR!) code (\w+)/.exec(output)?.[1] ?? /\b(ERR_PNPM_\w+)/.exec(output)?.[1];
  return code ? `${manager} failed (${code})` : `${manager} failed`;
}

/**
 * Run when a job's worktree is first made: install the repo's packages offline, so the agent can
 * run the repo's tests. Never fails the job: whatever happens, it says so in one line for the job log.
 * Skipped when node_modules isn't ignored by Git (it would be committed with the job's work).
 */
export async function installPackages(sys: System, path: string, signal?: AbortSignal): Promise<string | undefined> {
  const manager = await lockfileManager(path);
  if (!manager) return undefined;
  if (manager === "other") return "Packages not installed: the repo uses neither npm nor pnpm.";
  if (await exists(join(path, "node_modules"))) return undefined;
  const ignored = await git(sys, path, "check-ignore", "--quiet", "--no-index", "node_modules/").then(() => true, () => false);
  if (!ignored) return "Packages not installed: Git doesn't ignore node_modules in this repo, so they would be committed.";
  const binary = await executable(sys, [manager]);
  if (!binary) return `Packages not installed: ${manager} isn't installed on this machine.`;

  const env = worktreeEnv(sys);
  env.CI = "true";
  const started = Date.now();
  const seconds = () => `${Math.max(1, Math.round((Date.now() - started) / 1000))}s`;
  try {
    const run = exec(binary, installArgs(manager), { cwd: path, env, timeout: installTimeout, signal,
      maxBuffer: 4 * 1024 * 1024 });
    run.child.stdin?.end();
    await run;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; killed?: boolean; name?: string };
    // A half-made node_modules would look installed to the agent; take it away.
    await rm(join(path, "node_modules"), { recursive: true, force: true }).catch(() => {});
    await restore(sys, path);
    if (signal?.aborted || failure.name === "AbortError") return "Packages not installed: the turn was cancelled.";
    if (failure.killed) return `Packages not installed: ${manager} took longer than ${installTimeout / 1000}s.`;
    const why = installReason(manager, `${failure.stderr ?? ""}\n${failure.stdout ?? ""}`);
    return `Packages not installed offline (${seconds()}): ${why}. The job goes on; tests that need them won't run.`;
  }
  const changed = await restore(sys, path);
  return `Installed packages offline with ${manager} (${seconds()}).${changed ? " It changed tracked files; they were put back." : ""}`;
}

/**
 * The worktree was clean before the install, so anything tracked it changed (a lockfile) is put
 * back and anything new outside ignored files is removed. Returns whether it had to.
 */
async function restore(sys: System, path: string): Promise<boolean> {
  const status = await git(sys, path, "status", "--porcelain").catch(() => "");
  if (!status.trim()) return false;
  await git(sys, path, "checkout", "--quiet", "--", ".").catch(() => {});
  await git(sys, path, "clean", "--quiet", "-fd").catch(() => {});
  return true;
}
