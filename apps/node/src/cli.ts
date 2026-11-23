#!/usr/bin/env node
import { homedir } from "node:os";
import { delimiter } from "node:path";
import { manageService, ServiceError, serviceEnv } from "./service.ts";
import { searchPath, system } from "./system.ts";
import { pruneWorktrees } from "./worktrees.ts";
import { readUsage, startNode } from "./index.ts";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "usage" && args[1] === "--print") {
    process.stdout.write(JSON.stringify(await readUsage(), null, 2) + "\n");
    return;
  }
  if (args.length === 2 && args[0] === "worktrees" && args[1] === "--prune") {
    const removed = await pruneWorktrees(system());
    process.stdout.write(`Removed ${removed} ${removed === 1 ? "worktree" : "worktrees"}.\n`);
    return;
  }
  const [action] = args;
  if (args.length === 1 && (action === "install-service" || action === "uninstall-service" || action === "status")) {
    process.stdout.write(await manageService(action) + "\n");
    return;
  }
  const service = args.length === 1 && action === "service-run";
  if (args.length && !service) {
    process.stderr.write("Usage: opnav-node [usage --print | worktrees --prune | install-service | uninstall-service | status]\n");
    process.exitCode = 1;
    return;
  }
  const base: NodeJS.ProcessEnv = service ? { ...process.env, ...await serviceEnv() } : process.env;
  // Passing env to system() skips its PATH widening, so widen it here: launchd's
  // PATH misses /usr/local/bin, where Docker Desktop puts `docker`.
  const env: NodeJS.ProcessEnv = { ...base, PATH: searchPath(base.PATH, homedir(), process.platform) };
  const { OPNAV_SERVER_URL: serverUrl, OPNAV_NODE_TOKEN: token, OPNAV_CHECKOUT_ROOTS, OPNAV_HANDOFF_DIR } = env;
  if (!serverUrl || !token) {
    process.stderr.write("Set OPNAV_SERVER_URL and OPNAV_NODE_TOKEN.\n");
    process.exitCode = 1;
    return;
  }
  const node = startNode({
    serverUrl, token, system: { env }, checkoutRoots: OPNAV_CHECKOUT_ROOTS?.split(delimiter).filter(Boolean),
    handoffDir: OPNAV_HANDOFF_DIR || undefined,
    onStatus(message) {
      process.stderr.write(message + "\n");
      if (message === "The node token was revoked.") process.exitCode = 1;
    },
  });
  process.once("SIGINT", () => void node.stop());
  process.once("SIGTERM", () => void node.stop());
}

main().catch(error => {
  // Service manager errors may contain process output. Only print our own messages.
  const message = error instanceof ServiceError
    ? error.message : "Could not complete the opnav-node command.";
  process.stderr.write(message + "\n");
  process.exitCode = 1;
});
