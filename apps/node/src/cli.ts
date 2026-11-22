#!/usr/bin/env node
import { delimiter } from "node:path";
import { readUsage, startNode } from "./index.ts";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "usage" && args[1] === "--print") {
    process.stdout.write(JSON.stringify(await readUsage(), null, 2) + "\n");
    return;
  }
  if (args.length) {
    process.stderr.write("Usage: opnav-node [usage --print]\n");
    process.exitCode = 1;
    return;
  }
  const { OPNAV_SERVER_URL: serverUrl, OPNAV_NODE_TOKEN: token, OPNAV_CHECKOUT_ROOTS, OPNAV_HANDOFF_DIR } = process.env;
  if (!serverUrl || !token) {
    process.stderr.write("Set OPNAV_SERVER_URL and OPNAV_NODE_TOKEN.\n");
    process.exitCode = 1;
    return;
  }
  const node = startNode({
    serverUrl, token, checkoutRoots: OPNAV_CHECKOUT_ROOTS?.split(delimiter).filter(Boolean),
    handoffDir: OPNAV_HANDOFF_DIR || undefined,
    onStatus(message) {
      process.stderr.write(message + "\n");
      if (message === "The node token was revoked.") process.exitCode = 1;
    },
  });
  process.once("SIGINT", () => void node.stop());
  process.once("SIGTERM", () => void node.stop());
}

main().catch(() => {
  process.stderr.write("Could not start opnav-node.\n");
  process.exitCode = 1;
});
