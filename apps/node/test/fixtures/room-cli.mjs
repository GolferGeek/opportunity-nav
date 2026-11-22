#!/usr/bin/env node
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const state = process.env.ROOM_FIXTURE;
const config = JSON.parse(readFileSync(state, "utf8"));
const flag = name => args[args.indexOf(name) + 1];
const [group, action] = args;
const start = action === "spawn";
let prompt;
let mode;
if (group === "thread" && (start || action === "tell")) {
  const file = flag(start ? "--prompt-file" : "--message-file");
  prompt = readFileSync(file, "utf8");
  mode = statSync(file).mode & 0o777;
  writeFileSync(state, JSON.stringify({ ...config, told: !start, requestId: flag("--request-id") }));
}
if (process.env.OPNAV_NODE_TOKEN) process.exit(2);
appendFileSync(state + ".calls", JSON.stringify({ args, prompt, mode }) + "\n");
const row = (seq, type, data = {}) => ({ seq, type, data });
const usage = (seq, inputTokens, outputTokens) =>
  row(seq, "thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens, outputTokens } } });
const print = value => console.log(JSON.stringify(value));
switch (group + " " + action) {
  case "cloud status":
    print({ ready: true, account: { id: "fixture", email: "account@example.test" },
      harnesses: [{ id: "claude-code" }, { id: "codex" }, { id: "antigravity" }, { id: "cursor" }] });
    break;
  case "project list":
    print(config.create ? [] : [{ id: "proj_demo", gitRemoteUrl: "git@github.com:example/demo.git" }]);
    break;
  case "project create": print({ id: "proj_demo" }); break;
  case "thread spawn": print({ id: "thr_demo", status: "pending" }); break;
  case "thread tell": print({ threadId: "thr_demo", ok: true }); break;
  case "thread log": {
    const initial = [row(1, "turn/started"), usage(2, 10, 5), row(3, "turn/completed", { status: "completed" })];
    const events = config.wait ? [] : config.resume
      ? [...initial, ...(config.told ? [row(4, "client/turn/requested", { requestId: config.requestId }),
        row(5, "turn/started"), usage(6, 13, 7), row(7, "turn/completed", { status: "completed" })] : [])]
      : [row(1, "turn/started"), row(2, "item/started", { item: { type: "toolCall", tool: "Bash",
        arguments: { command: "echo account@example.test" } } }), ...initial.slice(1).map(item => ({ ...item, seq: item.seq + 1 }))];
    print(events.filter(event => event.seq > Number(flag("--after-seq"))));
    break;
  }
  case "thread output": print({ output: config.output ?? "Done.", error: config.error ?? null }); break;
  case "thread show": print({ thread: { status: config.status ?? "pending", runtime: { displayStatus: "Provisioning" } } }); break;
  case "thread interactions": print(config.question ? [{ status: "pending", payload: { kind: "user_question",
    questions: [{ prompt: config.question }] } }] : []); break;
  case "thread stop": break;
  default: process.exitCode = 1;
}
