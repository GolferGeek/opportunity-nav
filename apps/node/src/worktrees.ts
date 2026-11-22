import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { JobSpec } from "@opnav/shared";
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
}

export class WorktreeError extends Error {}

export function worktreeEnv(sys: System) {
  const env = childEnv(sys.env);
  // Git can inherit these when the node is started from another Git process.
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
    "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_PREFIX", "GIT_QUARANTINE_PATH"]) {
    delete env[key];
  }
  return env;
}

async function git(sys: System, cwd: string, ...args: string[]) {
  const { stdout } = await exec("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], {
    env: worktreeEnv(sys), timeout: 60_000,
  });
  return stdout;
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
  return { jobId: record.jobId, checkout: record.checkout, baseRef: record.baseRef, createdAt: record.createdAt };
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
    const saved = await recordAt(metadata);
    if (saved.jobId !== job.id || saved.checkout !== checkout) throw new Error();

    const exists = await lstat(path).then(() => true, error => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (!exists) {
      const branchExists = await git(sys, checkout, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`)
        .then(() => true, error => {
          if (error.code === 1) return false;
          throw error;
        });
      await git(sys, checkout, "worktree", "add", "--lock",
        ...(branchExists ? [path, branch] : ["-b", branch, path, "HEAD"]));
    } else {
      if (!await registered(sys, checkout, path, branch)) throw new Error();
      await git(sys, checkout, "worktree", "lock", path);
    }
    return { path, branch, async release() {
      await git(sys, checkout, "worktree", "unlock", path).catch(() => {});
    } };
  } catch {
    throw new WorktreeError("Could not prepare a separate Git worktree for this job.");
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
