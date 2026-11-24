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
  /** For a pushing job: the repo the server said it belongs to. */
  repo?: string;
  /** For a pushing job: origin's fetch and push addresses, checked against repo when it started. Git fetches and pushes only these. */
  fetchUrl?: string;
  pushUrl?: string;
  /**
   * For a pushing job whose work was replayed onto a newer origin: the job branch's tip it replayed
   * and the commit that came of it, saved before that commit is pushed. The job's own branch is never
   * rewritten, so a retry still sees only its own commits, and knows its earlier push when origin has it.
   */
  landed?: { tip: string; commit: string };
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
  const text = (value: unknown) => typeof value === "string" && value ? value : undefined;
  const sha = (value: unknown) => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value) ? value : undefined;
  const landed = record.landed && sha(record.landed.tip) && sha(record.landed.commit)
    ? { tip: record.landed.tip, commit: record.landed.commit } : undefined;
  return { jobId: record.jobId, checkout: record.checkout, baseRef: record.baseRef, createdAt: record.createdAt, start,
    repo: text(record.repo), fetchUrl: text(record.fetchUrl), pushUrl: text(record.pushUrl), ...(landed ? { landed } : {}) };
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

// Git work that touches a checkout's shared refs (fetch, worktree add, landing and pushing a job)
// runs one job at a time per checkout, so jobs running side by side in the same repo don't
// trip over each other's ref locks, and a second push lands on top of the first instead of
// being refused. Everything else a job does happens in its own worktree, at the same time.
const checkoutQueues = new Map<string, Promise<void>>();

export function oneAtATime<T>(checkout: string, work: () => Promise<T>): Promise<T> {
  const before = checkoutQueues.get(checkout) ?? Promise.resolve();
  const run = before.then(work);
  const tail = run.then(() => {}, () => {});
  checkoutQueues.set(checkout, tail);
  void tail.then(() => {
    if (checkoutQueues.get(checkout) === tail) checkoutQueues.delete(checkout);
  });
  return run;
}

/**
 * fromOrigin: start a new worktree from the checkout's branch on origin even when the job
 * doesn't push (a cloud session can only start from commits origin has).
 */
export async function openWorktree(sys: System, job: JobSpec, options: { fromOrigin?: boolean } = {}) {
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
    return await oneAtATime(checkout, async () => {
      // The server said which repo the job belongs to. If this checkout's origin isn't that repo
      // (the checkout changed since the heartbeat, or a Git setting rewrites its address), the job
      // doesn't run here. A pushing job also needs origin's push address to be that repo.
      const checked = job.remote === undefined ? undefined : await checkOrigin(sys, checkout, job.remote, !!job.push);
      if (typeof checked === "string") throw new WorktreeError(`This checkout can't run the job: ${checked}.`);
      return prepare(sys, job, checkout, id, branch, checked, !!options.fromOrigin);
    });
  } catch (error) {
    if (error instanceof WorktreeError) throw error;
    throw new WorktreeError("Could not prepare a separate Git worktree for this job.");
  }
}

async function prepare(sys: System, job: JobSpec, checkout: string, id: string, branch: string, checked: Origin | undefined,
  fromOrigin: boolean) {
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
    // If origin can't be fetched (or the server didn't say which repo the job belongs to) it starts
    // from this machine's HEAD, and then it never pushes: that history may hold commits that were
    // never meant to leave this machine.
    const base = job.push && checked?.pushUrl || fromOrigin && checked ? landingBranch(saved.baseRef) : undefined;
    const start = base && await fetchBranch(sys, checkout, checked!.fetchUrl, base)
      .then(() => git(sys, checkout, "rev-parse", "--verify", `refs/remotes/origin/${base}^{commit}`))
      .then(sha => sha.trim(), () => undefined);
    const branchExists = await git(sys, checkout, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`)
      .then(() => true, error => {
        if (error.code === 1) return false;
        throw error;
      });
    await git(sys, checkout, "worktree", "add", "--lock",
      ...(branchExists ? [path, branch] : ["-b", branch, path, start || "HEAD"]));
    if (!branchExists && start) {
      saved = { ...saved, start, repo: job.remote, fetchUrl: checked!.fetchUrl, pushUrl: checked!.pushUrl };
      await writeFile(metadata, JSON.stringify(saved), { mode: 0o600 });
    }
  } else {
    if (!await registered(sys, checkout, path, branch)) throw new Error();
    // A later turn of a pushing job still belongs to the repo it started in.
    if (saved.repo !== undefined && (job.remote === undefined || repoKey(job.remote) !== repoKey(saved.repo))) {
      throw new WorktreeError("This checkout can't run the job: the project's repo changed since the job started.");
    }
    await git(sys, checkout, "worktree", "lock", path);
  }
  let landing = saved;
  const fetchUrl = checked?.fetchUrl ?? saved.fetchUrl;
  const remember = async (landed: { tip: string; commit: string }) => {
    landing = { ...landing, landed };
    await writeFile(metadata, JSON.stringify(landing), { mode: 0o600 });
  };
  return { path, branch, commit: (message: string) => commitLeftovers(sys, path, message, branch),
    push: (signal?: AbortSignal) => oneAtATime(checkout, () => pushWork(sys, path, landing, branch, signal, remember)),
    /** The branch it lands on and the commit it started from on origin, when it started there. */
    landing: landing.start ? { base: landingBranch(landing.baseRef), start: landing.start } : undefined,
    /** A branch's commit on origin (at the checked address), or undefined when origin hasn't got it. */
    remoteBranch: (name: string, signal?: AbortSignal) => remoteBranch(sys, path, fetchUrl, name, signal),
    /** Fetch a branch from origin (at the checked address) and return its tip. */
    fetchBranch: (name: string, signal?: AbortSignal) => oneAtATime(checkout, () => fetchOther(sys, path, fetchUrl, name, signal)),
    /** Fast-forward the job's branch to a commit. Returns how many commits it gained. */
    fastForward: (target: string) => oneAtATime(checkout, () => fastForward(sys, path, branch, target)),
    async release() {
      await git(sys, checkout, "worktree", "unlock", path).catch(() => {});
    } };
}

export class GitError extends Error {}

async function remoteBranch(sys: System, path: string, url: string | undefined, name: string, signal?: AbortSignal) {
  if (!url) throw new GitError("the job has no checked address for its repo");
  const out = await network(sys, path, signal, "ls-remote", "--heads", "--", url, `refs/heads/${name}`)
    .catch(error => { throw new GitError(gitReason(error)); });
  const sha = out.split(/\s+/)[0];
  return sha && /^[a-f0-9]{40,64}$/.test(sha) ? sha : undefined;
}

async function fetchOther(sys: System, path: string, url: string | undefined, name: string, signal?: AbortSignal) {
  if (!url) throw new GitError("the job has no checked address for its repo");
  const ref = `refs/opnav-cloud/${name}`;
  await network(sys, path, signal, "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--", url, `+refs/heads/${name}:${ref}`)
    .catch(error => { throw new GitError(`could not fetch ${name} (${gitReason(error)})`); });
  return (await git(sys, path, "rev-parse", "--verify", `${ref}^{commit}`)).trim();
}

/**
 * Bring work someone else pushed (a cloud session) into the job's worktree, by fast-forward only:
 * the job's branch must be an ancestor of the commit taken, so nothing on it is lost or rewritten.
 */
async function fastForward(sys: System, path: string, branch: string, target: string): Promise<number> {
  if (!await onBranch(sys, path, branch)) throw new GitError(`the worktree is not on ${branch}`);
  const head = (await git(sys, path, "rev-parse", "HEAD")).trim();
  if (!await git(sys, path, "merge-base", "--is-ancestor", head, target).then(() => true, () => false)) {
    throw new GitError("its branch doesn't build on the commit it was given");
  }
  if ((await git(sys, path, "status", "--porcelain", "--untracked-files=no")).trim()) {
    throw new GitError("the worktree has uncommitted changes");
  }
  const count = Number((await git(sys, path, "rev-list", "--count", target, `^${head}`)).trim());
  if (count) await git(sys, path, "merge", "--ff-only", "--quiet", target);
  return count;
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

/** Fetch a branch from origin's checked address, never from whatever "origin" names by then. */
function fetchBranch(sys: System, cwd: string, url: string, base: string, signal?: AbortSignal) {
  return network(sys, cwd, signal, "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--",
    url, `+refs/heads/${base}:refs/remotes/origin/${base}`);
}

/** origin's addresses, fetch or push, with insteadOf and pushInsteadOf applied. */
async function originUrls(sys: System, cwd: string, push = false) {
  return (await git(sys, cwd, "remote", "get-url", "--all", ...(push ? ["--push"] : []), "origin"))
    .split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

/**
 * A repo address as something to compare: host and path for a network address (SSH and HTTPS
 * alike, case and ".git" aside), or the path of a local repo. A relative path never matches.
 * The server's own form (github.com/owner/repo) counts as a network address only when expected.
 */
export function repoKey(remote: string, expected = true): string | undefined {
  const value = remote.trim();
  const key = isAbsolute(value) ? `path:${value}` : normalizeRemote(value) ??
    (expected && /^[\w.-]+(?::\d+)?\/[^\s?#]+$/.test(value) ? value : undefined);
  return key?.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

function isRepo(url: string, repo: string) {
  const key = repoKey(url, false);
  return key !== undefined && key === repoKey(repo);
}

/** origin's addresses, checked: Git fetches from fetchUrl and pushes to pushUrl as they are. */
export interface Origin { fetchUrl: string; pushUrl?: string }

/**
 * Why the addresses Git would really use for this fetch and push aren't the job's repo, as a fixed
 * phrase (an address can hold a credential, so none is ever shown), or undefined when they are.
 * Git rewrites even an address given on its command line (insteadOf for both, pushInsteadOf for a
 * push) and reads a remote's settings when one is named after it, so a checked address must be
 * one no setting touches.
 */
async function addressProblem(sys: System, cwd: string, repo: string, fetchUrl: string, pushUrl?: string) {
  if (!isRepo(fetchUrl, repo)) return "origin isn't the project's repo";
  if (pushUrl !== undefined && !isRepo(pushUrl, repo)) return "origin's push address isn't the project's repo";
  const config = (await git(sys, cwd, "config", "--null", "--list")).split("\0").filter(Boolean).map(entry => {
    const at = entry.indexOf("\n");
    return at < 0 ? { key: entry, value: "" } : { key: entry.slice(0, at), value: entry.slice(at + 1) };
  });
  const rule = (push: boolean) => push ? /^url\..*\.(push)?insteadof$/i : /^url\..*\.insteadof$/i;
  const rewrites = (url: string, push: boolean) => config.some(({ key, value }) => rule(push).test(key) && url.startsWith(value));
  const named = (url: string) => config.some(({ key }) => key.startsWith(`remote.${url}.`));
  if (rewrites(fetchUrl, false) || pushUrl !== undefined && rewrites(pushUrl, true)) return "a Git setting rewrites origin's address";
  if (named(fetchUrl) || pushUrl !== undefined && named(pushUrl)) return "a Git remote is named after origin's address";
  return undefined;
}

/**
 * origin's effective addresses (after insteadOf / pushInsteadOf), checked against the job's repo:
 * exactly one fetch address, and for a pushing job exactly one push address, all the job's repo.
 * Returns the checked addresses, or why not as a fixed phrase.
 */
async function checkOrigin(sys: System, cwd: string, repo: string, push: boolean): Promise<Origin | string> {
  try {
    const fetchUrls = await originUrls(sys, cwd).catch(() => []);
    if (!fetchUrls.length) return "it has no origin";
    if (fetchUrls.length !== 1) return "origin has more than one address";
    const pushUrls = push ? await originUrls(sys, cwd, true) : [];
    if (push && pushUrls.length !== 1) return "origin doesn't have exactly one push address";
    const origin = { fetchUrl: fetchUrls[0]!, pushUrl: pushUrls[0] };
    return await addressProblem(sys, cwd, repo, origin.fetchUrl, origin.pushUrl) ?? origin;
  } catch {
    return "could not read origin's address";
  }
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
 * the job's commits onto origin when it has, on a temporary ref, so the job's own
 * branch (and the commit it started from) stay as they were and a retry checks the
 * same commits again. If that conflicts or the push is refused, push the job's own
 * branch instead. Returns one plain line saying what happened.
 *
 * remember saves a replayed commit before it's pushed, so a retry after an interrupted
 * push knows the work is already on origin when origin has that commit.
 */
export async function pushWork(sys: System, path: string,
  record: Pick<WorktreeRecord, "baseRef" | "start" | "repo" | "fetchUrl" | "pushUrl" | "landed">,
  branch: string, signal?: AbortSignal, remember?: (landed: { tip: string; commit: string }) => Promise<void>): Promise<string> {
  const kept = `The work is on branch ${branch} on this machine.`;
  const cancelled = `Not pushed: the job was cancelled. ${kept}`;
  if (signal?.aborted) return cancelled;
  const base = landingBranch(record.baseRef);
  if (!base) return `Not pushed: the checkout wasn't on a branch, so there was no branch to land the work on. ${kept}`;
  const { start, repo, fetchUrl, pushUrl } = record;
  if (start && !(repo && fetchUrl && pushUrl)) return `Not pushed: the job started without a checked address for its repo. ${kept}`;
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
  // Push only to the job's repo, at the addresses checked when it started: not to a push URL,
  // rewrite or new origin pointing elsewhere since. origin must still be that repo, and no Git
  // setting may have started rewriting the checked addresses.
  const now = await checkOrigin(sys, path, repo!, true);
  const problem = typeof now === "string" ? now
    : await addressProblem(sys, path, repo!, fetchUrl!, pushUrl).catch(() => "could not read origin's address");
  if (problem) return `Not pushed: ${problem}. ${kept}`;

  // Where origin's branch is now. A retry whose earlier push got there has nothing left to do,
  // and says so before anything else is checked: nothing leaves this machine.
  let remote: string | undefined;
  let unreachable: string | undefined;
  try {
    await fetchBranch(sys, path, fetchUrl!, base, signal);
    remote = await resolve(`refs/remotes/origin/${base}`).catch(error => {
      unreachable = `Could not read ${base} from origin (${gitReason(error)}).`;
      return undefined;
    });
  } catch (error) {
    if (signal?.aborted) return cancelled;
    unreachable = `Could not fetch ${base} from origin (${gitReason(error)}).`;
  }
  const onOrigin = `Nothing new to push: ${base} on origin already has this work.`;
  if (remote && await ancestor(tip, remote)) return onOrigin;
  const landed = record.landed;
  if (remote && landed && landed.tip === tip && await ancestor(landed.commit, remote)) return onOrigin;

  // The job's commits are its own: none of them is on another branch of this checkout.
  const count = async (...args: string[]) => Number((await git(sys, path, "rev-list", "--count", tip, `^${start}`, ...args)).trim());
  try {
    if (await count() !== await count("--not", `--exclude=${branch}`, "--branches")) {
      return `Not pushed: branch ${branch} holds commits from another branch on this machine. ${kept}`;
    }
  } catch {
    return `Not pushed: could not check the commits on branch ${branch}. ${kept}`;
  }

  // Only the job's commit, to one branch: no tags (whatever push.followTags says) and nothing in
  // a submodule's repo (whatever push.recurseSubmodules or submodule.recurse say).
  const push = (commit: string, target: string) => network(sys, path, signal, "push", "--quiet", "--no-follow-tags",
    "--recurse-submodules=no", "--", pushUrl!, `${commit}:refs/heads/${target}`);
  // The fallback is always the job's own branch as it is on this machine.
  const toBranch = async (why: string) => {
    if (signal?.aborted) return `${why} ${cancelled}`;
    try {
      await push(tip, branch);
      return `${why} Pushed the work to branch ${branch} instead.`;
    } catch (error) {
      return `${why} Could not push branch ${branch} either (${gitReason(error)}). ${kept}`;
    }
  };
  if (!remote) return toBranch(unreachable ?? `Could not read ${base} from origin.`);
  let landing = tip;
  if (!await ancestor(remote, tip)) {
    // Replaying copies commits one by one and drops merges, with whatever was fixed in them.
    const merges = await git(sys, path, "rev-list", "--count", "--merges", tip, `^${start}`).then(n => Number(n.trim()), () => NaN);
    if (merges !== 0) return toBranch(`${base} moved on, and the work has merge commits a rebase would lose.`);
    if (signal?.aborted) return cancelled;
    const replayed = await replay(sys, path, remote, start, tip, branch);
    if (!replayed) return toBranch(`${base} moved on, and the work doesn't rebase cleanly onto it.`);
    if (!await ancestor(remote, replayed)) return toBranch(`${base} moved on, and the work didn't land on top of it.`);
    landing = replayed;
    // Saved before the push: if the push gets through but this machine never hears, the retry knows.
    await remember?.({ tip, commit: landing }).catch(() => {});
  }
  if (signal?.aborted) return cancelled;
  try {
    await push(landing, base);
  } catch (error) {
    if (signal?.aborted) return cancelled;
    return toBranch(`Could not push to ${base} (${gitReason(error)}).`);
  }
  return `Pushed to ${base} as ${(await git(sys, path, "rev-parse", "--short", landing)).trim()}.`;
}

/**
 * Replay the job's commits (start..tip) onto origin's branch without touching the job's branch or
 * worktree: on a temporary ref, with git replay (Git 2.44 or later). Returns the new tip, or
 * undefined when the commits don't apply cleanly (or this Git can't replay).
 */
async function replay(sys: System, path: string, onto: string, start: string, tip: string, branch: string) {
  const temp = `refs/opnav-landing/${branch.slice("opnav/".length)}`;
  try {
    await git(sys, path, "update-ref", temp, onto);
    // Older Gits print the ref update for us to make; newer ones make it themselves.
    const out = await git(sys, path, "replay", "--advance", temp, `${start}..${tip}`);
    const printed = /^update \S+ ([a-f0-9]{40,64}) /m.exec(out)?.[1];
    const commit = printed ?? (await git(sys, path, "rev-parse", "--verify", `${temp}^{commit}`)).trim();
    return commit === onto ? undefined : commit;
  } catch {
    return undefined;
  } finally {
    await git(sys, path, "update-ref", "-d", temp).catch(() => {});
  }
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
      const { jobId, checkout, baseRef, createdAt, landed } = await recordAt(join(dir, file));
      if (!jobId.startsWith(id) || !await registered(sys, checkout, path, branch)) continue;
      const within = (commit: string) => git(sys, checkout, "merge-base", "--is-ancestor", commit, baseRef).then(() => true, () => false);
      // Merged: the branch is in the checkout's branch, or the copy of it that was replayed and pushed is.
      const tip = landed && (await git(sys, checkout, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`).catch(() => "")).trim();
      const merged = baseRef.startsWith("refs/heads/") && !baseRef.startsWith("refs/heads/opnav/") &&
        (await within(`refs/heads/${branch}`) || !!landed && tip === landed.tip && await within(landed.commit));
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
