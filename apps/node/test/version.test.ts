import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { system } from "../src/system.ts";
import { helperVersion, sourceVersion } from "../src/version.ts";
import { git, initRepo } from "./fixtures/git.ts";

test("the helper's version is its package version plus the commit it runs from", async t => {
  const root = await mkdtemp(join(tmpdir(), "opnav-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = join(root, "src");
  await mkdir(src);
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  const sys = system();

  assert.equal(await sourceVersion(sys, src), "1.2.3", "outside a checkout it's just the package version");

  initRepo(root);
  await writeFile(join(src, "a.ts"), "1");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "One");
  const first = git(root, "rev-parse", "--short=7", "HEAD");
  assert.equal(await sourceVersion(sys, src), `1.2.3+${first}`);

  await writeFile(join(src, "new.ts"), "untracked");
  assert.equal(await sourceVersion(sys, src), `1.2.3+${first}`, "untracked files don't count");

  await writeFile(join(src, "a.ts"), "2");
  assert.equal(await sourceVersion(sys, src), `1.2.3+${first}.dirty`);

  git(root, "commit", "--quiet", "-am", "Two");
  const second = git(root, "rev-parse", "--short=7", "HEAD");
  assert.notEqual(second, first);
  assert.equal(await sourceVersion(sys, src), `1.2.3+${second}`, "a new commit is a new version");
});

test("this checkout's helper reports a commit, not just 0.1.0", async () => {
  const head = git(import.meta.dirname, "rev-parse", "--short=7", "HEAD");
  assert.match(await helperVersion(system()), new RegExp(`^0\\.1\\.0\\+${head}(\\.dirty)?$`));
});
