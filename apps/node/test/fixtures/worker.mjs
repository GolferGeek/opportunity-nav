#!/usr/bin/env node
import assert from "node:assert/strict";
import { basename } from "node:path";
if (process.argv.includes("--version")) {
  console.log("fixture 1.2.3");
  process.exit(0);
}
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
assert.match(prompt, /opnav-needs-input/);
assert.equal(process.env.OPNAV_NODE_TOKEN, undefined);
const args = process.argv.slice(2);
const codex = basename(process.argv[1]) === "codex";
assert.ok(args.includes("--model=test-model"));
const emit = data => console.log(JSON.stringify(data));
const question = 'Before I continue:\n```opnav-needs-input\n{"question":"Continue?","options":["Yes","No"]}\n```';
if (codex) {
  assert.deepEqual(args.slice(0, 3), ["exec", "resume", "--json"]);
  assert.ok(args.includes("model_reasoning_effort=\"high\""));
  assert.ok(args.includes("session-from-claude"));
  assert.match(prompt, /^Yes\n/);
  emit({ type: "thread.started", thread_id: "session-from-claude" });
  emit({ type: "item.completed", item: { type: "agent_message", text: "Finished." } });
  emit({ type: "turn.completed", usage: { input_tokens: 6, output_tokens: 3 } });
} else {
  assert.deepEqual(args.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.ok(args.includes("--effort"));
  emit({ type: "system", subtype: "init", session_id: "session-from-claude" });
  if (prompt.startsWith("Wait")) {
    setInterval(() => {}, 1000);
  } else {
    emit({ type: "result", subtype: "success", session_id: "session-from-claude",
      result: question, usage: { input_tokens: 5, output_tokens: 2 } });
  }
}
