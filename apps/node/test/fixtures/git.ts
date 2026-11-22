import { execFileSync } from "node:child_process";

export function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

export function initRepo(path: string) {
  git(path, "init", "--quiet", "--initial-branch=main");
  git(path, "config", "user.name", "Test User");
  git(path, "config", "user.email", "test@example.com");
  git(path, "commit", "--quiet", "--allow-empty", "-m", "Initial commit");
}
