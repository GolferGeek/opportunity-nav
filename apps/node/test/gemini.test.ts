import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Turn } from "@opnav/shared";
import { system } from "../src/system.ts";
import { runWorker } from "../src/worker.ts";
import type { EventContent } from "../src/worker.ts";

for (const resume of [true, false]) {
  test(`Gemini CLI ${resume ? "resumes a streamed session" : "includes the previous reply in a fresh turn"}`, async t => {
    const home = await mkdtemp(join(tmpdir(), "opnav-gemini-test-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const binary = join(home, "gemini");
    const id = randomUUID();
    await writeFile(binary, `#!/usr/bin/env node
import assert from "node:assert/strict";
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(${JSON.stringify(resume ? "--output-format [choices: json, stream-json] --resume" : "--output-format [choices: json]")});
  process.exit(0);
}
assert.ok(args.includes(${JSON.stringify(resume ? "stream-json" : "json")}));
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const followup = prompt.startsWith("Yes") || prompt.includes("User's answer:");
if (followup && ${resume}) assert.equal(args[args.indexOf("--resume") + 1], ${JSON.stringify(id)});
if (followup && !${resume}) assert.match(prompt, /Previous reply:[\\s\\S]*Here is my first reply/);
const reply = followup ? "Finished." : ${JSON.stringify('Here is my first reply.\n```opnav-needs-input\n{"question":"Continue?"}\n```')};
const emit = data => console.log(JSON.stringify(data));
if (${resume}) {
  emit({ type: "init", session_id: ${JSON.stringify(id)} });
  emit({ type: "message", role: "assistant", content: reply.slice(0, 3), delta: true });
  emit({ type: "message", role: "assistant", content: reply.slice(3), delta: true });
  emit({ type: "result", status: "success", stats: { input_tokens: 10, output_tokens: 4 } });
} else emit({ response: reply });
`, { mode: 0o700 });
    const sys = system({ home, env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` } });
    const turn: Turn = {
      turnId: randomUUID(), leaseId: randomUUID(), leaseExpiresAt: "", kind: "start",
      job: { id: randomUUID(), projectId: randomUUID(), title: "Gemini", provider: "gemini",
        location: "cloud", checkoutPath: home, prompt: "Draft a note." },
    };
    const events: EventContent[] = [];
    const run = (input: Turn) => runWorker(sys, binary, input, new AbortController().signal, event => events.push(event));
    assert.equal((await run(turn)).type, "needs_input");
    const session = events.find(event => event.type === "session");
    if (resume) assert.equal(session?.providerSessionId, id);
    assert.deepEqual(await run({ ...turn, kind: "continue", providerSessionId: session?.providerSessionId,
      answer: { answerId: randomUUID(), questionId: randomUUID(), text: "Yes" },
    }), { type: "result", summary: "Finished." });
  });
}
