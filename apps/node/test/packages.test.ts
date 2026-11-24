import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { JobSpec } from "@opnav/shared";
import { installArgs, installPackages, installReason, lockfileManager } from "../src/packages.ts";
import { executable, system } from "../src/system.ts";
import { runWorker } from "../src/worker.ts";
import { worktreeEnv } from "../src/worktrees.ts";
import { git, initRepo } from "./fixtures/git.ts";

async function repo(t: TestContext, files: Record<string, string>) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "opnav-packages-test-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "project");
  const bin = join(home, "bin");
  await mkdir(path);
  await mkdir(bin);
  initRepo(path);
  for (const [name, text] of Object.entries(files)) await writeFile(join(path, name), text);
  git(path, "add", "-A");
  git(path, "commit", "--quiet", "-m", "Project files");
  return { home, path, bin };
}

/** A stand-in package manager: `body` is shell run in the worktree; it records its arguments. */
async function fakeManager(bin: string, name: string, body: string) {
  const file = join(bin, name);
  await writeFile(file, `#!/bin/sh\necho "$@" > "${bin}/${name}.args"\nenv > "${bin}/${name}.env"\n${body}\n`);
  await chmod(file, 0o755);
}

function sysFor(home: string, bin: string, extra: NodeJS.ProcessEnv = {}) {
  return system({ home, env: { PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: home, ...extra } });
}

const lock = JSON.stringify({ name: "p", version: "1.0.0", lockfileVersion: 3, requires: true,
  packages: { "": { name: "p", version: "1.0.0" } } });
const pkg = JSON.stringify({ name: "p", version: "1.0.0" });

test("knows npm and pnpm repos by their lockfile", async t => {
  const npm = await repo(t, { "package.json": pkg, "package-lock.json": lock });
  assert.equal(await lockfileManager(npm.path), "npm");
  const pnpm = await repo(t, { "package.json": pkg, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
  assert.equal(await lockfileManager(pnpm.path), "pnpm");
  const yarn = await repo(t, { "package.json": pkg, "yarn.lock": "" });
  assert.equal(await lockfileManager(yarn.path), "other");
  const none = await repo(t, { "README.md": "no packages" });
  assert.equal(await lockfileManager(none.path), undefined);
  assert.equal(await installPackages(system({ home: none.home }), none.path), undefined, "says nothing without package.json");
});

test("installs offline, never writing the lockfile or running scripts", () => {
  assert.deepEqual(installArgs("npm").slice(0, 3), ["ci", "--offline", "--ignore-scripts"]);
  assert.ok(installArgs("pnpm").includes("--frozen-lockfile"));
  assert.ok(installArgs("pnpm").includes("--offline"));
  assert.ok(installArgs("pnpm").includes("--ignore-scripts"));
});

test("names a missing package plainly", () => {
  assert.equal(installReason("npm", "npm error code ENOTCACHED\nnpm error request to https://registry.npmjs.org/x failed"),
    "a package it needs isn't in this machine's npm cache");
  assert.equal(installReason("pnpm", "ERR_PNPM_NO_OFFLINE_TARBALL  A package is missing from the store"),
    "a package it needs isn't in this machine's pnpm store");
  assert.equal(installReason("npm", "npm error code EUSAGE\nnpm error `npm ci` can only install packages when your package.json and package-lock.json are in sync"),
    "package.json and the lockfile don't match");
  assert.equal(installReason("npm", "npm error code E401\nsecret-token-here"), "npm failed (E401)");
});

test("an npm repo gets its packages, and a lockfile the install touched is put back", async t => {
  const { home, path, bin } = await repo(t, { "package.json": pkg, "package-lock.json": lock, ".gitignore": "node_modules\n" });
  await fakeManager(bin, "npm", "mkdir -p node_modules/x && echo changed > package-lock.json && echo junk > stray.txt");
  const said = await installPackages(sysFor(home, bin, { npm_config_local_prefix: "/elsewhere", INIT_CWD: "/elsewhere" }), path);
  assert.match(said!, /^Installed packages offline with npm \(\d+s\)\. It changed tracked files; they were put back\.$/);
  assert.equal(await readFile(join(bin, "npm.args"), "utf8"), installArgs("npm").join(" ") + "\n");
  const env = await readFile(join(bin, "npm.env"), "utf8");
  assert.doesNotMatch(env, /npm_config_local_prefix|INIT_CWD/, "npm settings from the helper's own npm run don't reach it");
  assert.match(env, /^CI=true$/m);
  assert.ok((await stat(join(path, "node_modules", "x"))).isDirectory());
  assert.equal(await readFile(join(path, "package-lock.json"), "utf8"), lock);
  assert.equal(git(path, "status", "--porcelain"), "");
  assert.equal(await installPackages(sysFor(home, bin), path), undefined, "already there: nothing to do");
});

test("a pnpm repo uses pnpm", async t => {
  const { home, path, bin } = await repo(t, { "package.json": pkg, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", ".gitignore": "node_modules/\n" });
  await fakeManager(bin, "pnpm", "mkdir -p node_modules/.pnpm");
  assert.match((await installPackages(sysFor(home, bin), path))!, /^Installed packages offline with pnpm \(\d+s\)\.$/);
  assert.equal(await readFile(join(bin, "pnpm.args"), "utf8"), installArgs("pnpm").join(" ") + "\n");
});

test("a package missing from the cache is reported, and nothing half-installed is left", async t => {
  const { home, path, bin } = await repo(t, { "package.json": pkg, "package-lock.json": lock, ".gitignore": "node_modules\n" });
  await fakeManager(bin, "npm", "mkdir -p node_modules/half\necho 'npm error code ENOTCACHED' >&2\nexit 1");
  assert.match((await installPackages(sysFor(home, bin), path))!,
    /^Packages not installed offline \(\d+s\): a package it needs isn't in this machine's npm cache\. The job goes on; tests that need them won't run\.$/);
  await assert.rejects(stat(join(path, "node_modules")), { code: "ENOENT" });
  assert.equal(git(path, "status", "--porcelain"), "");
});

test("skips repos where node_modules would be committed, or the manager is missing", async t => {
  const tracked = await repo(t, { "package.json": pkg, "package-lock.json": lock });
  await fakeManager(tracked.bin, "npm", "mkdir node_modules");
  assert.equal(await installPackages(sysFor(tracked.home, tracked.bin), tracked.path),
    "Packages not installed: Git doesn't ignore node_modules in this repo, so they would be committed.");
  await assert.rejects(readFile(join(tracked.bin, "npm.args")), { code: "ENOENT" });

  const pnpm = await repo(t, { "package.json": pkg, "pnpm-lock.yaml": "", ".gitignore": "node_modules\n" });
  if (!await executable(system({ home: pnpm.home, env: { PATH: "/usr/bin:/bin" } }), ["pnpm"])) {
    assert.equal(await installPackages(system({ home: pnpm.home, env: { PATH: "/usr/bin:/bin" } }), pnpm.path),
      "Packages not installed: pnpm isn't installed on this machine.");
  }
});

test("real npm: installs from the cache offline and says so when the cache lacks a package", async t => {
  const npm = await executable(system(), ["npm"]);
  if (!npm) return t.skip("npm isn't on PATH");
  const missing = JSON.stringify({ name: "p", version: "1.0.0", lockfileVersion: 3, requires: true, packages: {
    "": { name: "p", version: "1.0.0", dependencies: { "opnav-not-cached": "1.0.0" } },
    "node_modules/opnav-not-cached": { version: "1.0.0",
      resolved: "https://registry.npmjs.org/opnav-not-cached/-/opnav-not-cached-1.0.0.tgz",
      integrity: "sha512-" + "A".repeat(86) + "==" } } });
  const empty = await repo(t, { "package.json": pkg, "package-lock.json": lock, ".gitignore": "node_modules\n" });
  const sys = system({ home: empty.home, env: { ...process.env, HOME: empty.home } });
  assert.match((await installPackages(sys, empty.path))!, /^Installed packages offline with npm/);

  const lacking = await repo(t, { "package.json": JSON.stringify({ name: "p", version: "1.0.0", dependencies: { "opnav-not-cached": "1.0.0" } }),
    "package-lock.json": missing, ".gitignore": "node_modules\n" });
  const said = await installPackages(system({ home: lacking.home, env: { ...process.env, HOME: lacking.home } }), lacking.path);
  assert.match(said!, /^Packages not installed offline \(\d+s\): a package it needs isn't in this machine's npm cache\./);
  assert.equal(await readFile(join(lacking.path, "package-lock.json"), "utf8"), missing);
  assert.equal(git(lacking.path, "status", "--porcelain"), "");
});

test("a job's first turn installs packages in its new worktree and logs it; a later turn doesn't", async t => {
  const { home, path: checkout, bin } = await repo(t, { "package.json": pkg, "package-lock.json": lock, ".gitignore": "node_modules\n" });
  await fakeManager(bin, "npm", "mkdir -p node_modules/x");
  const sys = sysFor(home, bin, { XDG_DATA_HOME: join(home, "data") });
  const worker = join(bin, "worker");
  await writeFile(worker, "#!/bin/sh\ncat > /dev/null\ntest -d node_modules/x && echo '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Saw packages.\"}}'\necho '{\"type\":\"turn.completed\",\"usage\":{}}'\n");
  await chmod(worker, 0o755);
  const job: JobSpec = { id: randomUUID(), projectId: randomUUID(), checkoutPath: checkout,
    title: "Test", prompt: "Run the tests", provider: "codex", runner: "direct", location: "cloud" };
  const turn = { turnId: randomUUID(), leaseId: randomUUID(), leaseExpiresAt: "", kind: "start" as const, job };
  const events: unknown[] = [];
  assert.deepEqual(await runWorker(sys, worker, turn, new AbortController().signal, event => events.push(event)),
    { type: "result", summary: "Saw packages." });
  assert.ok(events.some(event => /Installed packages offline with npm/.test(JSON.stringify(event))));
  assert.equal(git(checkout, "status", "--porcelain"), "");
  await rm(join(bin, "npm.args"));
  const later: unknown[] = [];
  await runWorker(sys, worker, turn, new AbortController().signal, event => later.push(event));
  assert.ok(!later.some(event => /packages/i.test(JSON.stringify(event)) && /Installed|not installed/.test(JSON.stringify(event))));
  await assert.rejects(readFile(join(bin, "npm.args")), { code: "ENOENT" });
});

test("job worktrees don't inherit npm's settings from the helper's own npm run", () => {
  const env = worktreeEnv(system({ env: { PATH: "/bin", npm_config_local_prefix: "/helper", npm_lifecycle_event: "x", INIT_CWD: "/h", KEEP: "1" } }));
  assert.deepEqual(Object.keys(env).sort(), ["GCM_INTERACTIVE", "GIT_ASKPASS", "GIT_TERMINAL_PROMPT", "KEEP", "PATH", "SSH_ASKPASS_REQUIRE"]);
});
