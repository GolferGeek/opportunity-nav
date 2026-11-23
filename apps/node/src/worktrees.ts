import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { JobSpec } from "@opnav/shared";
import { normalizeRemote } from "./capabilities.ts";
import { childEnv } from "./system.ts";
import type { System } from "./system.ts";

const exec = promisify(execFile);
const maxAge = 14 * 24 * 60 * 60 * 1000;
const shortId = /^[a-f0-9]{8}$/i;

interface WorktreeRecord {
  jobId: string;
  checkout: string;
  baseRef: string;
  createdAt: number;
  /** For a pushing job: the commit it started from, as fetched from origin. Without it, nothing is pushed. */
  start?: string;
  /** For a pushing job: origin's address when it started. The work is pushed only there. */
  remote?: string;
}

export class WorktreeError extends Error {}

export function worktreeEnv(sys: System) {
  const env = childEnv(sys.env);
  // A fetch or push must fail rather than wait for a password nobody can type:
  // no terminal prompt, no askpass program (an empty GIT_ASKPASS also skips core.askPass
  // and SSH_ASKPASS), and no credential-manager window.
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS_REQUIRE = "never";
  env.GCM_INTERACTIVE = "never";
  delete env.SSH_ASKPASS;
  // Git can inherit these when the node is started from another Git process.
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
    "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_PREFIX", "GIT_QUARANTINE_PATH"]) {
    delete env[key];
  }
  return env;
}

async function git(sys: System, cwd: string, ...args: string[]) {
  return gitWith(sys, cwd, {}, ...args);
}

async function gitWith(sys: System, cwd: string, opts: { signal?: AbortSignal; env?: NodeJS.ProcessEnv }, ...args: string[]) {
  const run = exec("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], {
    env: opts.env ?? worktreeEnv(sys), timeout: 60_000, signal: opts.signal,
  });
  run.child.stdin?.end();
  return (await run).stdout;
}

/**
 * Fetch or push without ever asking for a sign-in: SSH runs in batch mode (keeping any
 * ssh command the user set up) and credential helpers are told not to open a prompt.
 */
async function network(sys: System, cwd: string, signal: AbortSignal | undefined, ...args: string[]) {
  const env = worktreeEnv(sys);
  if (!env.GIT_SSH) {
    const ssh = env.GIT_SSH_COMMAND?.trim() ||
      (await git(sys, cwd, "config", "--get", "core.sshCommand").catch(() => "")).trim() || "ssh";
    env.GIT_SSH_COMMAND = `${ssh} -o BatchMode=yes`;
  }
  return gitWith(sys, cwd, { signal, env }, "-c", "credential.interactive=false", ...args);
}

function directory(sys: System) {
  const xdg = sys.env.XDG_DATA_HOME;
  return resolve(xdg && isAbsolute(xdg) ? xdg : join(sys.home, ".local/share"), "opportunity-nav", "worktrees");
}

function inside(parent: string, path: string) {
  const rel = relative(parent, path);
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

async function recordAt(path: string): Promise<WorktreeRecord> {
  const record: Partial<WorktreeRecord> = JSON.parse(await readFile(path, "utf8"));
  if (typeof record.jobId !== "string" || typeof record.checkout !== "string" || !isAbsolute(record.checkout) ||
    typeof record.baseRef !== "string" || typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) {
    throw new Error("Invalid worktree record");
  }
  const start = typeof record.start === "string" && /^[a-f0-9]{40,64}$/.test(record.start) ? record.start : undefined;
  const remote = typeof record.remote === "string" && record.remote ? record.remote : undefined;
  return { jobId: record.jobId, checkout: record.checkout, baseRef: record.baseRef, createdAt: record.createdAt, start, remote };
}

async function registered(sys: System, checkout: string, path: string, branch: string) {
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) return false;
  const [actualRoot, commonDir, checkoutCommonDir, list] = await Promise.all([
    git(sys, path, "rev-parse", "--show-toplevel"),
    git(sys, path, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    git(sys, checkout, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    git(sys, checkout, "worktree", "list", "--porcelain", "-z"),
  ]);
  if (actualRoot.trimEnd() !== path || commonDir !== checkoutCommonDir) return false;
  return list.split("\0\0").some(entry => {
    const [location, ...fields] = entry.split("\0");
    return location === `worktree ${path}` && fields.includes(`branch refs/heads/${branch}`);
  });
}

export async function openWorktree(sys: System, job: JobSpec) {
  let checkout: string;
  try {
    if (!isAbsolute(job.checkoutPath)) throw new Error();
    const root = await git(sys, job.checkoutPath, "rev-parse", "--show-toplevel");
    checkout = await realpath(root.trimEnd());
  } catch {
    throw new WorktreeError("The project checkout is not a Git repository.");
  }

  const id = job.id.slice(0, 8);
  const branch = `opnav/${id}`;
  try {
    if (!shortId.test(id)) throw new Error();
    const dir = await canonicalPath(directory(sys));
    if (inside(checkout, dir)) throw new Error();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, id);
    const metadata = path + ".json";
    const baseRef = (await git(sys, checkout, "symbolic-ref", "--quiet", "HEAD").catch(() => "")).trim();
    const record: WorktreeRecord = { jobId: job.id, checkout, baseRef, createdAt: Date.now() };
    await writeFile(metadata, JSON.stringify(record), { flag: "wx", mode: 0o600 }).catch(error => {
      if (error.code !== "EEXIST") throw error;
    });
    let saved = await recordAt(metadata);
    if (saved.jobId !== job.id || saved.checkout !== checkout) throw new Error();

    const exists = await lstat(path).then(() => true, error => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (!exists) {
      // A job that pushes lands on its checkout's branch on origin, so it starts from there.
      // If origin can't be fetched it starts from this machine's HEAD, and then it never pushes:
      // that history may hold commits that were never meant to leave this machine.
      const base = job.push ? landingBranch(saved.baseRef) : undefined;
      const start = base && await fetchBranch(sys, checkout, base)
        .then(() => git(sys, checkout, "rev-parse", "--verify", `refs/remotes/origin/${base}^{commit}`))
        .then(sha => sha.trim(), () => undefined);
      const remote = start && await originUrls(sys, checkout).then(urls => urls.length === 1 ? urls[0] : undefined, () => undefined);
      const branchExists = await git(sys, checkout, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`)
        .then(() => true, error => {
          if (error.code === 1) return false;
          throw error;
        });
      await git(sys, checkout, "worktree", "add", "--lock",
        ...(branchExists ? [path, branch] : ["-b", branch, path, start || "HEAD"]));
      if (!branchExists && start && remote) {
        saved = { ...saved, start, remote };
        await writeFile(metadata, JSON.stringify(saved), { mode: 0o600 });
      }
    } else {
      if (!await registered(sys, checkout, path, branch)) throw new Error();
      await git(sys, checkout, "worktree", "lock", path);
    }
    const landing = saved;
    return { path, branch, commit: (message: string) => commitLeftovers(sys, path, message, branch),
      push: (signal?: AbortSignal) => pushWork(sys, path, landing, branch, signal), async release() {
      await git(sys, checkout, "worktree", "unlock", path).catch(() => {});
    } };
  } catch {
    throw new WorktreeError("Could not prepare a separate Git worktree for this job.");
  }
}

/**
 * Commit whatever an agent left uncommitted in its worktree, and return the new commit.
 * Agent sandboxes (agy --sandbox, Codex workspace-write, Claude's sandbox) can write the
 * worktree but not its Git metadata, which lives in the main checkout's .git/worktrees/<id>,
 * so their own `git commit` fails. The helper commits for them, outside the sandbox and with
 * hooks off, so nothing the agent wrote runs unsandboxed.
 */
export async function commitLeftovers(sys: System, path: string, message: string, branch?: string): Promise<string | undefined> {
  // Leftovers belong on the job's branch; if the agent switched away, don't commit them anywhere else.
  if (branch && !await onBranch(sys, path, branch)) {
    if (!(await git(sys, path, "status", "--porcelain", "--untracked-files=all", "--", ".",
      ":(exclude,glob)**/node_modules", ":(exclude,glob)**/node_modules/**")).trim()) return undefined;
    throw new Error(`The worktree is not on ${branch}`);
  }
  // A node_modules symlink into the main checkout isn't matched by a "node_modules/" ignore rule.
  await git(sys, path, "add", "--all", "--", ".", ":(exclude,glob)**/node_modules", ":(exclude,glob)**/node_modules/**");
  if (!(await git(sys, path, "diff", "--cached", "--name-only")).trim()) return undefined;
  await git(sys, path, "commit", "--quiet", "--no-verify", "-m", message);
  return (await git(sys, path, "rev-parse", "--short", "HEAD")).trim();
}

/** The branch a pushing job lands on: the checkout's branch, unless it was detached or a job's own. */
function landingBranch(baseRef: string): string | undefined {
  return baseRef.startsWith("refs/heads/") && !baseRef.startsWith("refs/heads/opnav/") ? baseRef.slice("refs/heads/".length) : undefined;
}

async function onBranch(sys: System, path: string, branch: string) {
  return (await git(sys, path, "symbolic-ref", "--quiet", "HEAD").catch(() => "")).trim() === `refs/heads/${branch}`;
}

function fetchBranch(sys: System, cwd: string, base: string, signal?: AbortSignal) {
  return network(sys, cwd, signal, "fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`);
}

/** origin's addresses, fetch or push, with insteadOf and pushInsteadOf applied. */
async function originUrls(sys: System, cwd: string, push = false) {
  return (await git(sys, cwd, "remote", "get-url", "--all", ...(push ? ["--push"] : []), "origin"))
    .split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

/** Two addresses for the same repo: identical, or the same host and path (SSH and HTTPS alike). */
function sameRepo(a: string, b: string) {
  const key = normalizeRemote(a);
  return a === b || key !== undefined && key === normalizeRemote(b);
}

/**
 * Why Git failed, as a fixed phrase. Git's own text never leaves this machine: it can
 * hold a credential (in a URL, or from a credential helper) that no pattern would catch.
 */
export function gitReason(error: unknown): string {
  const e = error as { stderr?: unknown; killed?: boolean; signal?: unknown; name?: unknown; code?: unknown };
  if (e.name === "AbortError" || e.code === "ABORT_ERR") return "the job was cancelled";
  if (e.killed || e.signal) return "Git took too long, perhaps waiting for a sign-in";
  const stderr = String(e.stderr ?? "");
  if (/terminal prompts disabled|could not read (username|password)|authentication|permission denied|publickey|host key verification|\b40[13]\b|credential/i.test(stderr)) {
    return "origin needs a sign-in this machine can't give without asking";
  }
  if (/could not resolve host|connection (refused|timed out|reset|closed)|network is unreachable|timed out|unable to access|could not connect/i.test(stderr)) {
    return "origin couldn't be reached";
  }
  if (/repository not found|does not appear to be a git repository|not found/i.test(stderr)) return "origin couldn't find the repo";
  if (/rejected|non-fast-forward|fetch first|protected|declined|denied/i.test(stderr)) return "origin refused it";
  return "Git failed";
}

/**
 * Land a job's committed work on the branch its checkout was on, and push it.
 * Only the job's own commits leave this machine: the ones on its branch since the
 * commit it started from on origin. It pushes that branch's tip by commit ID, never
 * whatever happens to be checked out. Fast-forward when origin hasn't moved; replay
 * the job's commits onto origin when it has. If that conflicts or the push is refused,
 * push the job's own branch instead. Returns one plain line saying what happened.
 */
export async function pushWork(sys: System, path: string, record: Pick<WorktreeRecord, "baseRef" | "start" | "remote">,
  branch: string, signal?: AbortSignal): Promise<string> {
  const kept = `The work is on branch ${branch} on this machine.`;
  const cancelled = `Not pushed: the job was cancelled. ${kept}`;
  if (signal?.aborted) return cancelled;
  const base = landingBranch(record.baseRef);
  if (!base) return `Not pushed: the checkout wasn't on a branch, so there was no branch to land the work on. ${kept}`;
  const start = record.start;
  if (!start) return `Not pushed: the job couldn't start from ${base} on origin, and its branch may hold commits from this machine that aren't on origin. ${kept}`;
  if (!await onBranch(sys, path, branch)) return `Not pushed: the worktree was no longer on branch ${branch}. ${kept}`;
  const resolve = async (ref: string) => (await git(sys, path, "rev-parse", "--verify", `${ref}^{commit}`)).trim();
  const ancestor = (a: string, b: string) => git(sys, path, "merge-base", "--is-ancestor", a, b).then(() => true, () => false);
  let tip: string;
  try {
    tip = await resolve(`refs/heads/${branch}`);
  } catch {
    return `Not pushed: could not read branch ${branch}. ${kept}`;
  }
  // The branch must still grow from where the job started, or its history isn't the job's.
  if (!await ancestor(start, tip)) return `Not pushed: branch ${branch} no longer builds on ${base} from origin. ${kept}`;
  if (tip === start) return `Nothing new to push: the job made no commits.`;
  // The job's commits are its own: none of them is on another branch of this checkout.
  const count = async (...args: string[]) => Number((await git(sys, path, "rev-list", "--count", tip, `^${start}`, ...args)).trim());
  try {
    if (await count() !== await count("--not", `--exclude=${branch}`, "--branches")) {
      return `Not pushed: branch ${branch} holds commits from another branch on this machine. ${kept}`;
    }
  } catch {
    return `Not pushed: could not check the commits on branch ${branch}. ${kept}`;
  }
  // Push only to the repo the job started from: not to a push URL, rewrite or new origin pointing elsewhere.
  try {
    const [fetchUrls, pushUrls] = await Promise.all([originUrls(sys, path), originUrls(sys, path, true)]);
    const own = (url: string) => record.remote !== undefined && sameRepo(url, record.remote);
    if (fetchUrls.length !== 1 || !own(fetchUrls[0]!) || !pushUrls.length || !pushUrls.every(own)) {
      return `Not pushed: origin's address isn't only the repo the job started from. ${kept}`;
    }
  } catch {
    return `Not pushed: could not read origin's address. ${kept}`;
  }

  const push = (commit: string, target: string) =>
    network(sys, path, signal, "push", "--quiet", "origin", `${commit}:refs/heads/${target}`);
  const toBranch = async (why: string, commit: string) => {
    if (signal?.aborted) return `${why} ${cancelled}`;
    try {
      await push(commit, branch);
      return `${why} Pushed the work to branch ${branch} instead.`;
    } catch (error) {
      return `${why} Could not push branch ${branch} either (${gitReason(error)}). ${kept}`;
    }
  };
  try {
    await fetchBranch(sys, path, base, signal);
  } catch (error) {
    if (signal?.aborted) return cancelled;
    return toBranch(`Could not fetch ${base} from origin (${gitReason(error)}).`, tip);
  }
  let remote: string;
  try {
    remote = await resolve(`refs/remotes/origin/${base}`);
  } catch (error) {
    return toBranch(`Could not read ${base} from origin (${gitReason(error)}).`, tip);
  }
  if (await ancestor(tip, remote)) return `Nothing new to push: ${base} on origin already has this work.`;
  let landing = tip;
  if (!await ancestor(remote, tip)) {
    // A rebase replays commits one by one and drops merges, with whatever was fixed in them.
    const merges = await git(sys, path, "rev-list", "--count", "--merges", tip, `^${start}`).then(n => Number(n.trim()), () => NaN);
    if (merges !== 0) return toBranch(`${base} moved on, and the work has merge commits a rebase would lose.`, tip);
    if (signal?.aborted) return cancelled;
    // Replay only the job's commits, start..tip, onto origin's branch.
    try {
      await git(sys, path, "rebase", "--quiet", "--onto", remote, start, branch);
      landing = await resolve(`refs/heads/${branch}`);
    } catch {
      await git(sys, path, "rebase", "--abort").catch(() => {});
      return toBranch(`${base} moved on, and the work doesn't rebase cleanly onto it.`, tip);
    }
    if (!await ancestor(remote, landing)) return toBranch(`${base} moved on, and the work didn't land on top of it.`, tip);
  }
  if (signal?.aborted) return cancelled;
  try {
    await push(landing, base);
  } catch (error) {
    if (signal?.aborted) return cancelled;
    return toBranch(`Could not push to ${base} (${gitReason(error)}).`, landing);
  }
  return `Pushed to ${base} as ${(await git(sys, path, "rev-parse", "--short", landing)).trim()}.`;
}

export async function pruneWorktrees(sys: System, now = Date.now()) {
  const dir = await canonicalPath(directory(sys));
  const files = await readdir(dir).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  let removed = 0;
  for (const file of files) {
    const id = file.slice(0, -5);
    if (!file.endsWith(".json") || !shortId.test(id)) continue;
    const path = join(dir, id);
    const branch = `opnav/${id}`;
    try {
      const { jobId, checkout, baseRef, createdAt } = await recordAt(join(dir, file));
      if (!jobId.startsWith(id) || !await registered(sys, checkout, path, branch)) continue;
      const merged = baseRef.startsWith("refs/heads/") && !baseRef.startsWith("refs/heads/opnav/") &&
        await git(sys, checkout, "merge-base", "--is-ancestor", `refs/heads/${branch}`, baseRef)
          .then(() => true, () => false);
      if (!merged && now - createdAt <= maxAge) continue;
      // Git refuses to remove active or dirty worktrees. The branch keeps committed work available.
      await git(sys, checkout, "worktree", "remove", path);
      removed++;
    } catch {
      // A worktree may have moved, been removed, or still be in use.
    }
  }
  return removed;
}
