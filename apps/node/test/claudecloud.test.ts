import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { JobSpec, Turn } from "@opnav/shared";
import { claudeCloudStatus, ROUTINE_FILE, resultBranch, routineRepos, runClaudeCloud } from "../src/claudecloud.ts";
import { workerArgs } from "../src/worker.ts";
import type { RoutineConfig } from "../src/claudecloud.ts";
import { system } from "../src/system.ts";
import type { EventContent } from "../src/worker.ts";
import { git, initRepo } from "./fixtures/git.ts";

const token = "sk-ant-oat01-fake-routine-token";
const url = "https://api.anthropic.com/v1/claude_code/routines/trig_01TEST/fire";

type Cloud = (text: string, call: number) => void;

/** A checkout cloned from a bare origin, a routine file, and a fake routine API whose "session" pushes with git. */
async function fixture(t: TestContext, options: { push?: boolean; repos?: string[] } = {}) {
  const home = await mkdtemp(join(tmpdir(), "opnav-claude-cloud-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const seed = join(home, "seed");
  await mkdir(seed);
  initRepo(seed);
  const origin = join(home, "origin.git");
  git(home, "clone", "--quiet", "--bare", seed, origin);
  const checkout = join(home, "clone");
  git(home, "clone", "--quiet", origin, checkout);
  const sys = system({ home, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" } });
  const config: RoutineConfig = { url, token, repos: options.repos ?? [origin] };
  const job: JobSpec = { id: randomUUID(), projectId: randomUUID(), title: "Fix it", prompt: "Add fix.txt.", provider: "claude",
    location: "cloud", runner: "claude-cloud", checkoutPath: checkout, remote: origin, ...(options.push === false ? {} : { push: true }) };
  const turn: Turn = { turnId: randomUUID(), leaseId: randomUUID(), leaseExpiresAt: new Date().toISOString(), kind: "start", job };
  const fires: { url: string; headers: Record<string, string>; text: string }[] = [];
  let sessions = 0;
  /** What the cloud session does with the fired text: push a finished branch, by default. */
  let cloud: Cloud = text => session(text);
  let status = 200;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const text = JSON.parse(String(init!.body)).text as string;
    fires.push({ url: String(input), headers: init!.headers as Record<string, string>, text });
    if (status !== 200) return Response.json({ type: "error", error: { type: "x", message: `bad ${token}` } }, { status });
    cloud(text, fires.length);
    sessions++;
    return Response.json({ type: "routine_fire", claude_code_session_id: `session_${sessions}`,
      claude_code_session_url: `https://claude.ai/code/session_${sessions}` });
  }) as typeof globalThis.fetch;
  /** Play the cloud session: clone, branch from the start commit, commit, push. */
  function session(text: string, { finish = "opnav-result", answer = "Done in the cloud.", repo = undefined as string | null | undefined } = {}) {
    const branch = /^Result branch: (\S+)$/m.exec(text)![1]!;
    // The repo line names the repo the payload gave, unless a test says otherwise (null: no repo line).
    const said = repo === undefined ? /^Repository: (\S+)$/m.exec(text)?.[1] ?? origin : repo;
    const start = /^Start commit: ([a-f0-9]+)/m.exec(text)![1]!;
    const work = join(home, `cloud-${randomUUID()}`);
    git(home, "clone", "--quiet", origin, work);
    for (const [k, v] of [["user.name", "Claude"], ["user.email", "claude@example.com"]]) git(work, "config", k!, v!);
    git(work, "checkout", "--quiet", "-b", branch, start);
    writeFileSync(join(work, "fix.txt"), `fixed by ${branch} at ${randomUUID()}\n`);
    git(work, "add", "fix.txt");
    git(work, "commit", "--quiet", "-m", "Add fix.txt");
    if (finish) git(work, "commit", "--quiet", "--allow-empty", "-m", finish, ...(said === null ? [] : ["-m", `opnav-repo: ${said}`]),
      ...(answer ? ["-m", answer] : []));
    git(work, "push", "--quiet", "origin", branch);
  }
  const run = async (overrides: Partial<Turn> = {}, opts = {}) => {
    const events: EventContent[] = [];
    const controller = new AbortController();
    const outcome = await runClaudeCloud(sys, config, { ...turn, ...overrides }, controller.signal, e => events.push(e),
      { fetch, pollMs: 5, timeoutMs: 400, ...opts });
    return { outcome, events, progress: events.flatMap(e => e.type === "progress" ? [e.text] : []) };
  };
  return { home, sys, origin, checkout, config, turn, fires, run, session,
    setCloud: (c: Cloud) => { cloud = c; }, setStatus: (s: number) => { status = s; }, setRepos: (repos: string[]) => { config.repos = repos; } };
}


test("Claude's cloud is not set up without a routine file readable only by its owner", async t => {
  const home = await mkdtemp(join(tmpdir(), "opnav-claude-cloud-status-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sys = system({ home, platform: "darwin", env: {} });
  assert.deepEqual(await claudeCloudStatus(sys), { ready: false, reason: "not set up" });
  const file = join(home, ROUTINE_FILE);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify({ url, token, repos: ["GolferGeek/opportunity-nav"] }));
  await chmod(file, 0o644);
  const open = await claudeCloudStatus(sys);
  assert.equal(open.ready, false);
  assert.match(!open.ready ? open.reason : "", /readable only by you/);
  await chmod(file, 0o600);
  assert.deepEqual(await claudeCloudStatus(sys), { ready: true, config: { url, token, repos: ["GolferGeek/opportunity-nav"] } });
  await writeFile(file, JSON.stringify({ url: "https://example.com/fire", token, repos: ["a/b"] }));
  const elsewhere = await claudeCloudStatus(sys);
  assert.equal(elsewhere.ready, false);
  assert.ok(!JSON.stringify(elsewhere).includes(token));
});

test("a Claude cloud job fires the routine, waits for its branch, and lands the work without the marker commit", async t => {
  const { origin, checkout, turn, fires, run } = await fixture(t);
  const before = git(origin, "rev-parse", "main");
  const { outcome, events, progress } = await run();
  assert.deepEqual(outcome, { type: "result", summary: "Done in the cloud." });
  assert.equal(fires.length, 1);
  const [fired] = fires;
  assert.equal(fired!.url, url);
  assert.equal(fired!.headers.authorization, `Bearer ${token}`);
  assert.equal(fired!.headers["anthropic-version"], "2023-06-01");
  assert.ok(!fired!.text.includes(token));
  assert.match(fired!.text, new RegExp(`^Result branch: ${resultBranch(turn)}$`, "m"));
  assert.match(fired!.text, new RegExp(`^Start commit: ${before} \\(on branch main on origin\\)$`, "m"));
  assert.match(fired!.text, /Add fix\.txt\./);
  // The payload names the job's repo, and the session checks its checkout and push address against it first.
  assert.match(fired!.text, new RegExp(`^Repository: ${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.match(fired!.text, /^0\. Check this session's checkout is .* git remote get-url --push origin must both be that repo/m);
  assert.ok(fired!.text.includes(`-m "opnav-repo: ${origin}"`));
  assert.deepEqual(events.find(e => e.type === "session"), { type: "session", providerSessionId: "session_1" });
  assert.ok(progress.some(p => p.includes("https://claude.ai/code/session_1")));
  assert.equal(progress.at(-1), `Pushed to main as ${git(origin, "rev-parse", "--short", "main")}.`);
  assert.equal(git(origin, "log", "-1", "--format=%s", "main"), "Add fix.txt");
  assert.equal(git(origin, "show", "--name-only", "--format=", "main"), "fix.txt");
  assert.equal(git(checkout, "log", "-1", "--format=%s"), "Initial commit");
  assert.ok(!JSON.stringify(events).includes(token));
});

test("a Claude cloud job that hears nothing tries once more, then fails with a clear reason", async t => {
  const { origin, fires, run, setCloud, turn } = await fixture(t);
  setCloud(() => {});
  const { outcome, progress } = await run({}, { timeoutMs: 60 });
  assert.equal(fires.length, 2);
  assert.equal(outcome.type, "error");
  assert.match(outcome.type === "error" ? outcome.message : "", new RegExp(`pushed nothing to ${resultBranch(turn)} within 0 minutes, twice`));
  assert.ok(progress.some(p => /Starting the routine once more/.test(p)));
  assert.equal(git(origin, "log", "-1", "--format=%s", "main"), "Initial commit");
});

test("a Claude cloud job takes the second run's work when the first never came back", async t => {
  const { fires, run, setCloud, session } = await fixture(t);
  setCloud((text, call) => { if (call === 2) session(text, { answer: "Second time lucky." }); });
  const { outcome } = await run({}, { timeoutMs: 60 });
  assert.equal(fires.length, 2);
  assert.deepEqual(outcome, { type: "result", summary: "Second time lucky." });
});

test("a Claude cloud job waits for the last commit and never lands a half-pushed branch", async t => {
  const { origin, fires, run, setCloud, session } = await fixture(t);
  setCloud(text => session(text, { finish: "" }));
  const { outcome, progress } = await run({}, { timeoutMs: 60 });
  assert.equal(fires.length, 1);
  assert.match(outcome.type === "error" ? outcome.message : "", /pushed to claude\/opnav-.* but didn't finish/);
  assert.ok(progress.some(p => /Waiting for its last commit/.test(p)));
  assert.equal(git(origin, "log", "-1", "--format=%s", "main"), "Initial commit");
});

test("a Claude cloud run that says it failed fails the job and pushes nothing", async t => {
  const { origin, run, setCloud, session } = await fixture(t);
  setCloud(text => session(text, { finish: "opnav-failed", answer: "The tests need a database." }));
  const { outcome } = await run();
  assert.deepEqual(outcome, { type: "error", code: "provider_error", retryable: false,
    message: "Claude's cloud session couldn't do it: The tests need a database." });
  assert.equal(git(origin, "log", "-1", "--format=%s", "main"), "Initial commit");
});

test("a refused routine token fails at once, without retrying or showing the token", async t => {
  const { fires, run, setStatus } = await fixture(t);
  setStatus(401);
  const { outcome } = await run();
  assert.equal(fires.length, 1);
  assert.equal(outcome.type === "error" && outcome.code, "auth_required");
  assert.ok(!JSON.stringify(outcome).includes(token));
});

test("a Claude cloud job for a repo the routine doesn't have never fires", async t => {
  const { fires, run } = await fixture(t, { repos: ["github.com/someone/else"] });
  const { outcome } = await run();
  assert.equal(fires.length, 0);
  assert.match(outcome.type === "error" ? outcome.message : "", /isn't set up for/);
});

test("a Claude cloud turn claimed again picks up a branch already pushed instead of firing again", async t => {
  const { fires, run, session, turn, origin } = await fixture(t);
  session(`Result branch: ${resultBranch(turn)}\nStart commit: ${git(origin, "rev-parse", "main")}`, { answer: "Already done." });
  const { outcome } = await run();
  assert.equal(fires.length, 0);
  assert.deepEqual(outcome, { type: "result", summary: "Already done." });
});

test("a Claude cloud job without push keeps the work on its own branch", async t => {
  const { origin, checkout, turn, run } = await fixture(t, { push: false });
  const { outcome, progress } = await run();
  assert.deepEqual(outcome, { type: "result", summary: "Done in the cloud." });
  assert.ok(!progress.some(p => /Pushed/.test(p)));
  assert.equal(git(origin, "log", "-1", "--format=%s", "main"), "Initial commit");
  assert.equal(git(checkout, "log", "-1", "--format=%s", `opnav/${turn.job.id.slice(0, 8)}`), "Add fix.txt");
});

test("a Claude cloud job can ask a question, and the answer's run starts from the work so far", async t => {
  const { fires, run, setCloud, session, turn, origin, checkout } = await fixture(t, { push: false });
  setCloud(text => session(text, { answer: 'Half done.\n```opnav-needs-input\n{"question":"Which name?"}\n```' }));
  const first = await run();
  assert.deepEqual(first.outcome, { type: "needs_input", needsInput: { question: "Which name?" } });
  const branch = `opnav/${turn.job.id.slice(0, 8)}`;
  const sofar = git(checkout, "rev-parse", branch);
  setCloud(text => session(text, { answer: "All done." }));
  const second = await run({ kind: "continue", turnId: randomUUID(), providerSessionId: "session_1",
    answer: { answerId: randomUUID(), questionId: randomUUID(), text: "Call it fix." } });
  assert.deepEqual(second.outcome, { type: "result", summary: "All done." });
  assert.equal(fires.length, 2);
  assert.match(fires[1]!.text, new RegExp(`^Start commit: ${sofar}$`, "m"));
  assert.match(fires[1]!.text, /Call it fix\./);
  assert.equal(git(checkout, "rev-list", "--count", `${sofar}..${branch}`), "1");
  assert.equal(git(origin, "log", "-1", "--format=%s", "main"), "Initial commit");
});

test("only an exact opnav-result subject finishes a run: a progress commit like \"opnav-result: draft\" doesn't", async t => {
  const { origin, fires, run, setCloud, session } = await fixture(t);
  setCloud(text => session(text, { finish: "opnav-result: draft", answer: "Not done yet." }));
  const { outcome, progress } = await run({}, { timeoutMs: 60 });
  assert.equal(fires.length, 1);
  assert.match(outcome.type === "error" ? outcome.message : "", /pushed to claude\/opnav-.* but didn't finish/);
  assert.ok(progress.some(p => /Waiting for its last commit/.test(p)));
  assert.equal(git(origin, "log", "-1", "--format=%s", "main"), "Initial commit");
});

test("a finished run's commit is checked before the job's branch moves: no answer, no repo line or another repo is refused", async t => {
  for (const [options, message] of [
    [{ answer: "" }, "Claude's cloud session finished without an answer."],
    [{ repo: null }, "Claude's cloud session's last commit doesn't say which repo it worked in, so its work wasn't taken."],
    [{ repo: "github.com/someone/else" }, "Claude's cloud session says it worked in another repo, so its work wasn't taken."],
  ] as const) {
    const { origin, checkout, turn, run, setCloud, session } = await fixture(t);
    const start = git(origin, "rev-parse", "main");
    setCloud(text => session(text, options));
    const { outcome, progress } = await run();
    assert.deepEqual(outcome, { type: "error", code: "provider_error", retryable: false, message });
    assert.ok(!progress.some(p => /Brought in/.test(p)));
    assert.equal(git(checkout, "rev-parse", `opnav/${turn.job.id.slice(0, 8)}`), start, "the job's branch didn't move");
    assert.equal(git(origin, "rev-parse", "main"), start);
  }
});

test("a routine whose repos differ from the job's only in case (on a host where case counts) never fires", async t => {
  // The routine names the job's local origin with its file name in another case.
  const { fires, run, setRepos, origin } = await fixture(t);
  setRepos([join(origin, "..", "ORIGIN.git")]);
  const { outcome } = await run();
  assert.equal(fires.length, 0);
  assert.match(outcome.type === "error" ? outcome.message : "", /isn't set up for/);
  // GitHub ignores case, so there it's the same repo; another host keeps it.
  assert.deepEqual(routineRepos({ repos: ["GolferGeek/Opportunity-Nav", "https://github.com/golfergeek/opportunity-nav.git", "https://git.example.com/Team/Repo"] }),
    ["github.com/golfergeek/opportunity-nav", "git.example.com/Team/Repo"]);
});

test("a rewrite set up in the job's worktree during the wait stops the helper fetching from it", async t => {
  const { home, origin, checkout, fires, run, setCloud, session } = await fixture(t);
  const elsewhere = join(home, "elsewhere.git");
  git(home, "clone", "--quiet", "--bare", origin, elsewhere);
  setCloud(text => {
    session(text);
    // Only the job's worktree gets the rule: the checkout itself still looks fine.
    const worktree = /^worktree (.+)$/gm.exec(git(checkout, "worktree", "list", "--porcelain").split("\n\n")[1]!)![1]!;
    git(checkout, "config", "extensions.worktreeConfig", "true");
    git(worktree, "config", "--worktree", `url.${elsewhere}.insteadOf`, origin);
  });
  const { outcome } = await run({}, { timeoutMs: 60, attempts: 1 });
  assert.equal(fires.length, 1);
  assert.match(outcome.type === "error" ? outcome.message : "", /pushed nothing .* \(the last check said: a Git setting rewrites origin's address\)/);
  assert.equal(git(origin, "log", "-1", "--format=%s", "main"), "Initial commit");
});

test("a Claude worker in edit mode can't read the helper's settings, where the routine token lives", () => {
  const home = "/Users/someone";
  const dir = join(home, ".config", "opportunity-nav");
  assert.ok(join(home, ROUTINE_FILE).startsWith(dir + "/"));
  const turn: Turn = { turnId: randomUUID(), leaseId: randomUUID(), leaseExpiresAt: "", kind: "start",
    job: { id: randomUUID(), projectId: randomUUID(), title: "x", prompt: "x", provider: "claude", location: "cloud", runner: "direct", checkoutPath: "/tmp/x" } };
  for (const sandbox of [true, false]) {
    const args = workerArgs(turn, "edit", sandbox, [dir]);
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
    assert.deepEqual(settings.permissions.deny, [`Read(/${dir})`, `Read(/${dir}/**)`]);
    assert.deepEqual(settings.sandbox?.filesystem?.denyRead, sandbox ? [dir] : undefined);
  }
  assert.ok(!workerArgs(turn, "full", false, [dir]).includes("--settings"), "full autonomy has no such restriction");
});
