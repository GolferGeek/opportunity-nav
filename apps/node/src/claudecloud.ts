import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { Turn } from "@opnav/shared";
import { shortText } from "./activity.ts";
import { object, string } from "./system.ts";
import type { System } from "./system.ts";
import { land, needsInputInstruction, publishFreely, terminal } from "./worker.ts";
import type { EventContent, Publish, Terminal } from "./worker.ts";
import { GitError, openWorktree, repoKey, WorktreeError, worktreeEnv } from "./worktrees.ts";
import { sameRepo } from "@opnav/shared";

/**
 * Claude's cloud, through a Claude Code routine ("scheduled task") with an API trigger.
 * The helper fires the routine with the job's task and a branch name. The cloud session
 * pushes its work to that branch and ends with an `opnav-result` commit holding its answer.
 * Firing is the only thing the routine's token can do: there is no status or result API, so
 * the helper watches origin for the branch, and a run that never pushes shows up only as a timeout.
 * Runs count against the person's own Claude plan; nothing is billed separately.
 */

const exec = promisify(execFile);
/**
 * Where the person saves the routine's fire URL, token and repos, readable only by them (mode 600),
 * in the helper's settings directory. Only the helper reads it, and only the helper's own process:
 * the token never goes into a job's environment, worktree, prompt or log. Claude workers in edit mode
 * are refused reads of that directory (workerArgs). Codex and Antigravity workers, and any job in full
 * autonomy, run as the same OS account with no such restriction and could read it.
 */
export const ROUTINE_FILE = ".config/opportunity-nav/claude-routine.json";
const fireUrl = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[\w-]+\/fire$/;
const MAX_TEXT = 65_536;

export interface RoutineConfig { url: string; token: string; repos: string[] }
export type ClaudeCloudStatus = { ready: true; config: RoutineConfig } | { ready: false; reason: string };

/** A repo as the routine file may name it: github.com/owner/repo, owner/repo (GitHub), a URL, or a local path. */
export function routineRepo(value: string) {
  return repoKey(/^[\w-]+\/[\w.-]+$/.test(value.trim()) ? `github.com/${value.trim()}` : value);
}

/** The repos a routine covers, as repo identities (what the heartbeat and claim advertise). */
export function routineRepos(config: Pick<RoutineConfig, "repos">): string[] {
  return [...new Set(config.repos.map(routineRepo).filter((r): r is string => !!r))];
}

/** Read the routine file. Missing or unsafe means "not set up", and the machine takes no Claude cloud jobs. */
export async function claudeCloudStatus(sys: System): Promise<ClaudeCloudStatus> {
  const file = join(sys.home, ROUTINE_FILE);
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return { ready: false, reason: "not set up" };
  if (sys.platform !== "win32" && (info.mode & 0o077) !== 0) {
    return { ready: false, reason: `not set up: ~/${ROUTINE_FILE} must be readable only by you (chmod 600)` };
  }
  let raw: Record<string, unknown>;
  try {
    raw = object(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return { ready: false, reason: `not set up: ~/${ROUTINE_FILE} isn't valid JSON` };
  }
  const url = string(raw.url);
  const token = string(raw.token);
  const repos = Array.isArray(raw.repos) ? raw.repos.map(string).filter((r): r is string => !!r) : [];
  if (!url || !fireUrl.test(url)) return { ready: false, reason: "not set up: the routine's fire URL is missing or isn't a Claude routine URL" };
  if (!token || /\s/.test(token)) return { ready: false, reason: "not set up: the routine's token is missing" };
  if (!routineRepos({ repos }).length) return { ready: false, reason: "not set up: the file names no repos" };
  return { ready: true, config: { url, token, repos } };
}

/** The routine file, read at most every 10 seconds. */
export function claudeCloudDetector(sys: System) {
  let cached: Promise<ClaudeCloudStatus> | undefined;
  let expires = 0;
  return () => {
    if (!cached || performance.now() >= expires) {
      cached = claudeCloudStatus(sys).catch(() => ({ ready: false as const, reason: "not set up" }));
      expires = performance.now() + 10_000;
    }
    return cached;
  };
}

/** The branch a turn's cloud session pushes to. Claude's cloud pushes claude/ branches without extra setup. */
export function resultBranch(turn: Turn) {
  return `claude/opnav-${turn.job.id.slice(0, 8)}-${turn.turnId.slice(0, 8)}`;
}

/** The text the routine is fired with. The routine's saved prompt says to follow it. */
export function fireText(turn: Turn, branch: string, start: string, base: string | undefined): string {
  const { job } = turn;
  const repo = job.remote!;
  const task = turn.kind === "continue"
    ? `${job.prompt}\n\nThis continues an earlier run of this job. Its work so far is at the start commit.\nYou asked the person a question; their answer:\n${turn.answer?.text ?? ""}`
    : job.prompt;
  return [
    `Opportunity Nav job ${job.id.slice(0, 8)}: ${job.title.split("\n")[0]!.trim()}`,
    `Repository: ${repo}`,
    `Start commit: ${start}${base ? ` (on branch ${base} on origin)` : ""}`,
    `Result branch: ${branch}`,
    "",
    "Steps:",
    `0. Check this session's checkout is ${repo} before anything else: git remote get-url origin and git remote get-url --push origin must both be that repo (the same host and owner/repo path; ${repo.startsWith("github.com/") ? "GitHub ignores case" : "case counts"}; an address through Claude's local Git proxy counts when its path ends in that owner/repo). If either isn't, stop: change nothing, commit nothing, push nothing, and say why in this session.`,
    `1. git fetch origin ${base ?? start} && git checkout -b ${branch} ${start}`,
    "2. Do the task below on that branch. Commit your work there.",
    "3. When you're done, add one last commit, empty is fine. Its first line is exactly opnav-result, then the repo line, then your answer:",
    `   git commit --allow-empty -m "opnav-result" -m "opnav-repo: ${repo}" -m "<your final answer to the person>"`,
    `4. Check origin's push address again (step 0), then: git push origin ${branch}`,
    "Push only that branch, only to origin, and only after step 0 passed. Don't push anywhere else, and don't open a pull request.",
    "Push when you're done. Opportunity Nav takes the branch only once its last commit's first line is exactly opnav-result.",
    `If you can't do the task (but step 0 passed), still push ${branch} with an empty last commit:`,
    `   git commit --allow-empty -m "opnav-failed" -m "opnav-repo: ${repo}" -m "<why>"`,
    "",
    "Task:",
    task,
    "",
    needsInputInstruction,
    "If you end with that question block, put it in the opnav-result commit's message, after your answer.",
  ].join("\n");
}

type Fired = { session: string; url?: string } | { fatal: Terminal } | { transient: string };

/** Fire the routine. The token goes only in the Authorization header and is never logged. */
async function fire(transport: typeof fetch, config: RoutineConfig, text: string, signal: AbortSignal): Promise<Fired> {
  let response: Response;
  try {
    response = await transport(config.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
  } catch {
    if (signal.aborted) throw signal.reason;
    return { transient: "Claude's routine API couldn't be reached" };
  }
  const body = object(await response.json().catch(() => ({})));
  const said = shortText(string(object(body.error).message)?.replaceAll(config.token, "[redacted]"));
  const fatal = (code: "auth_required" | "rate_limited" | "provider_error", message: string, retryable = false): Fired =>
    ({ fatal: { type: "error", code, message, retryable } });
  if (response.status === 401) return fatal("auth_required", "The Claude routine refused its token. Make a new token for the routine and save it again (docs/claude-cloud-setup.md).");
  if (response.status === 403) return fatal("auth_required", "This Claude account can't fire routines.");
  if (response.status === 404) return fatal("provider_error", "The Claude routine wasn't found. Check its fire URL in the routine file (docs/claude-cloud-setup.md).");
  if (response.status === 429) return fatal("rate_limited", "The Claude routine reached its hourly limit.", true);
  if (response.status >= 400 && response.status < 500) return fatal("provider_error", `Claude refused to start the routine${said ? `: ${said}` : "."}`);
  if (!response.ok) return { transient: `Claude's routine API had an error (${response.status})` };
  const session = string(body.claude_code_session_id);
  if (!session) return { transient: "Claude's routine API didn't return a session" };
  return { session, url: string(body.claude_code_session_url) };
}

async function readGit(sys: System, cwd: string, ...args: string[]) {
  const run = exec("git", ["-C", cwd, ...args], { env: worktreeEnv(sys), timeout: 30_000 });
  run.child.stdin?.end();
  return (await run).stdout;
}

/**
 * A pushed branch's finishing commit. Finished only when the tip's first line is exactly opnav-result
 * or opnav-failed ("opnav-result: draft" is a progress commit, not the end). Its body must start with
 * the repo line naming the job's repo, and a result must hold an answer: both are checked here, before
 * anything moves the job's branch. Returns undefined while unfinished, or which commit holds the work.
 */
export async function finish(sys: System, cwd: string, tip: string, repo: string):
  Promise<undefined | { refused: string } | { failed: boolean; answer: string; target: string }> {
  const message = await readGit(sys, cwd, "log", "-1", "--format=%B", tip);
  const [subject = "", ...rest] = message.replace(/\r\n/g, "\n").split("\n");
  const kind = /^opnav-(result|failed)[ \t]*$/.exec(subject)?.[1];
  if (!kind) return undefined;
  const body = rest.join("\n").trim();
  const said = /^opnav-repo:[ \t]*(\S+)[ \t]*(?:\n|$)/.exec(body);
  if (!said) return { refused: "Claude's cloud session's last commit doesn't say which repo it worked in, so its work wasn't taken." };
  if (!sameRepo(said[1]!, repo, { serverForm: true })) {
    return { refused: "Claude's cloud session says it worked in another repo, so its work wasn't taken." };
  }
  const answer = body.slice(said[0].length).trim();
  if (kind === "result" && !answer) return { refused: "Claude's cloud session finished without an answer." };
  // An empty marker commit isn't work: land its parent, so it never reaches the person's branch.
  const [tree, parentTree] = await Promise.all([readGit(sys, cwd, "rev-parse", `${tip}^{tree}`),
    readGit(sys, cwd, "rev-parse", `${tip}^^{tree}`).catch(() => "")]);
  const target = tree.trim() === parentTree.trim() ? (await readGit(sys, cwd, "rev-parse", `${tip}^`)).trim() : tip;
  return { failed: kind === "failed", answer, target };
}

export interface ClaudeCloudOptions {
  fetch?: typeof fetch;
  /** How long one run gets to push its finished branch. Default 45 minutes. */
  timeoutMs?: number;
  /** Runs fired in all: the first plus retries. Default 2. */
  attempts?: number;
  pollMs?: number;
  /** Asks the server before landing the work (lease.ts). */
  publish?: Publish;
}

export async function runClaudeCloud(sys: System, config: RoutineConfig, turn: Turn, signal: AbortSignal,
  emit: (event: EventContent) => void, options: ClaudeCloudOptions = {}): Promise<Terminal> {
  const { job } = turn;
  const cancelled: Terminal = { type: "error", code: "cancelled", message: "The turn was cancelled.", retryable: false };
  const failed = (message: string): Terminal => ({ type: "error", code: "provider_error", message, retryable: false });
  if (signal.aborted) return cancelled;
  if (job.provider !== "claude") return failed("Claude's cloud runs only Claude.");
  if (!job.remote) return failed("Claude's cloud needs the server to say which repo the job is in. Update the server.");
  const repo = repoKey(job.remote);
  if (!repo || !routineRepos(config).includes(repo)) {
    return failed(`The Claude routine isn't set up for ${job.remote}. Add the repo to the routine and to its file (docs/claude-cloud-setup.md).`);
  }
  const worktree = await openWorktree(sys, job, { fromOrigin: true }).catch(error => {
    if (error instanceof WorktreeError) return error;
    throw error;
  });
  if (worktree instanceof WorktreeError) return { type: "error", code: "other", message: worktree.message, retryable: false };
  try {
    if (!worktree.landing) {
      return failed("Claude's cloud starts from a branch on origin, and this job couldn't start from one: the checkout must be on a branch that origin has.");
    }
    const start = (await readGit(sys, worktree.path, "rev-parse", "HEAD")).trim();
    const branch = resultBranch(turn);
    const text = fireText(turn, branch, start, turn.kind === "start" ? worktree.landing.base : undefined);
    if (text.length > MAX_TEXT) return failed(`The task is too long for a Claude routine run (over ${MAX_TEXT.toLocaleString("en-US")} characters).`);
    const outcome = await follow(sys, config, turn, signal, emit, options, worktree, branch, text);
    if (signal.aborted) return cancelled;
    await land(worktree, turn, outcome, true, signal, emit, options.publish ?? publishFreely);
    return outcome;
  } catch (error) {
    if (signal.aborted) return cancelled;
    return failed(`Claude's cloud work couldn't be brought in${error instanceof GitError ? `: ${error.message}` : ""}.`);
  } finally {
    await worktree.release();
  }
}

async function follow(sys: System, config: RoutineConfig, turn: Turn, signal: AbortSignal, emit: (event: EventContent) => void,
  options: ClaudeCloudOptions, worktree: Awaited<ReturnType<typeof openWorktree>>, branch: string, text: string): Promise<Terminal> {
  const transport = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 45 * 60_000;
  const attempts = Math.max(1, options.attempts ?? 2);
  const pollMs = options.pollMs ?? 30_000;
  const minutes = `${Math.round(timeoutMs / 60_000)} minutes`;
  const wait = (ms: number) => sleep(ms, undefined, { signal });
  let seen: string | undefined;
  let unfinished = false;
  let lastProblem: string | undefined;

  /** Look at the branch once: a terminal outcome when it's finished, else undefined. */
  async function check(): Promise<Terminal | undefined> {
    let sha: string | undefined;
    try {
      sha = await worktree.remoteBranch(branch, signal);
    } catch (error) {
      if (signal.aborted || !(error instanceof GitError)) throw error;
      lastProblem = error.message;
      return undefined;
    }
    if (!sha || sha === seen) return undefined;
    seen = sha;
    const tip = await worktree.fetchBranch(branch, signal);
    const done = await finish(sys, worktree.path, tip, turn.job.remote!);
    if (!done) {
      if (!unfinished) emit({ type: "progress", text: `Claude's cloud session pushed to ${branch}. Waiting for its last commit.` });
      unfinished = true;
      return undefined;
    }
    if ("refused" in done) return { type: "error", code: "provider_error", message: done.refused, retryable: false };
    const count = await worktree.fastForward(done.target);
    emit({ type: "progress", text: count ? `Brought in ${count} commit${count === 1 ? "" : "s"} from ${branch}.` : `${branch} has no new commits.` });
    if (done.failed) return { type: "error", code: "provider_error", retryable: false,
      message: `Claude's cloud session couldn't do it${done.answer ? `: ${shortText(done.answer)}` : "."}` };
    return terminal(done.answer);
  }

  // A turn claimed again after a restart may already have its branch: don't fire a second run.
  const already = await check();
  if (already) return already;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (!seen) {
      const fired = await fire(transport, config, text, signal);
      if ("fatal" in fired) return fired.fatal;
      if ("transient" in fired) {
        emit({ type: "progress", text: `${fired.transient}.${attempt < attempts ? " Trying once more." : ""}` });
        if (attempt < attempts) {
          await wait(Math.min(pollMs, 60_000));
          continue;
        }
        return { type: "error", code: "provider_error", message: `${fired.transient}.`, retryable: true };
      }
      emit({ type: "session", providerSessionId: fired.session });
      emit({ type: "progress", text: `Started Claude's cloud session${fired.url ? ` ${fired.url}` : ""}. Its work comes back on ${branch}.` });
    }
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      await wait(Math.max(0, Math.min(pollMs, deadline - performance.now())));
      const outcome = await check();
      if (outcome) return outcome;
    }
    // A run that already pushed is still working: let it finish rather than start another.
    if (unfinished) {
      return { type: "error", code: "provider_error", retryable: false,
        message: `Claude's cloud session pushed to ${branch} but didn't finish within ${minutes}. Its work so far is on that branch.` };
    }
    if (attempt < attempts) emit({ type: "progress", text: `Nothing on ${branch} after ${minutes}. Starting the routine once more.` });
  }
  const why = lastProblem ? ` (the last check said: ${lastProblem})` : "";
  return { type: "error", code: "provider_error", retryable: false,
    message: `Claude's cloud session pushed nothing to ${branch} within ${minutes}, ${attempts === 1 ? "once" : attempts === 2 ? "twice" : `${attempts} times`}${why}. It may have failed or be waiting for an answer: look at it on claude.ai/code.` };
}
