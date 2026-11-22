#!/usr/bin/env node
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";

assert.equal(process.argv[2], "app-server");
assert.equal(process.env.CODEX_HOME, process.cwd());
assert.equal(existsSync(join(process.cwd(), "auth.json")), false);
assert.equal(process.env.OPNAV_NODE_TOKEN, undefined);
const methods = ["initialize", "initialized", "account/login/start", "account/rateLimits/read", "account/read"];
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  assert.equal(method, methods.shift());
  if (method === "initialized") continue;
  let result = {};
  if (method === "account/login/start") {
    assert.equal(params.type, "chatgptAuthTokens");
    assert.equal(params.chatgptAccountId, "fixture-workspace");
    assert.ok(params.accessToken);
    assert.equal("refreshToken" in params, false);
  }
  if (method === "account/rateLimits/read") {
    result = { rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 4070908800 },
        secondary: { usedPercent: 37, windowDurationMins: 10080 },
        individualLimit: { used: 3, limit: 12 },
      },
    } };
  }
  if (method === "account/read") {
    assert.equal(params.refreshToken, false);
    result = { account: { planType: "plus" } };
  }
  console.log(JSON.stringify({ id, result }));
}
