#!/usr/bin/env node
// Stands in for `claude -p --output-format stream-json`: echoes the prompt back,
// pretends to use one tool, and reports whether it was resumed.
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1];
const resumed = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
out({ type: "system", subtype: "init", session_id: resumed ?? "fake-session-1" });
out({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__opnav__add_item", input: { title: "Try it" } }] } });
out({ type: "assistant", message: { content: [{ type: "text", text: `You said: ${prompt}${resumed ? ` (resumed ${resumed})` : ""}` }] } });
out({ type: "result", subtype: "success", is_error: false, result: "ok" });
