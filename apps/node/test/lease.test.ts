import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { NODE } from "@opnav/shared";
import type { JobEvent, Turn } from "@opnav/shared";
import { ApiError } from "../src/api.ts";
import type { Post } from "../src/api.ts";
import { runTurn } from "../src/lease.ts";
import { land } from "../src/worker.ts";

function pushingTurn(): Turn {
  return { turnId: randomUUID(), leaseId: randomUUID(), leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), kind: "start",
    job: { id: randomUUID(), projectId: randomUUID(), checkoutPath: "/tmp/x", title: "Fix it", prompt: "Fix it",
      provider: "codex", runner: "direct", location: "cloud", push: true } };
}

/** A server that answers publish with `answer` and keeps the events it's sent. */
function server(turn: Turn, answer: (calls: number) => unknown) {
  const events: JobEvent[] = [];
  let publishCalls = 0;
  const post = (async (path: string, body: any) => {
    if (path === NODE.lease(turn.job.id)) return { leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), cancel: false };
    if (path === NODE.publish(turn.job.id)) {
      assert.equal(body.leaseId, turn.leaseId);
      const a = answer(++publishCalls);
      if (a instanceof Error) throw a;
      return a;
    }
    if (path === NODE.events(turn.job.id)) {
      events.push(...body.events);
      return { lastSeq: body.events.at(-1).seq };
    }
    throw new Error(`unexpected ${path}`);
  }) as Post;
  return { post, events, publishCalls: () => publishCalls };
}

async function finish(turn: Turn, post: Post) {
  let pushes = 0;
  const worktree = { branch: "opnav/x", push: async () => { pushes++; return "Pushed to main as abc1234."; } };
  await runTurn(post, turn, new AbortController().signal, () => {}, async (signal, emit, publish) => {
    const outcome = { type: "result" as const, summary: "Done." };
    await land(worktree, turn, outcome, true, signal, emit, publish);
    return outcome;
  });
  return pushes;
}

test("a cancel the server accepted just before publishing: no push, and the turn ends cancelled", async () => {
  const turn = pushingTurn();
  const s = server(turn, () => ({ publish: false, cancel: true }));
  assert.equal(await finish(turn, s.post), 0);
  assert.equal(s.publishCalls(), 1);
  assert.ok(s.events.some(e => e.type === "progress" && e.text === "Not pushed: the job was cancelled. The work is on branch opnav/x on this machine."));
  const last = s.events.at(-1)!;
  assert.equal(last.type, "error");
  assert.equal(last.type === "error" && last.code, "cancelled");
  assert.ok(!s.events.some(e => e.type === "result"));
});

test("publishing approved: the push happens and the result stands", async () => {
  const turn = pushingTurn();
  const s = server(turn, () => ({ publish: true, cancel: false }));
  assert.equal(await finish(turn, s.post), 1);
  assert.equal(s.events.at(-1)!.type, "result");
});

test("no answer from the server means no push; a lost lease means no push either", async () => {
  const turn = pushingTurn();
  const flaky = server(turn, () => new ApiError(503));
  assert.equal(await finish(turn, flaky.post), 0);
  assert.equal(flaky.publishCalls(), 4);
  assert.ok(flaky.events.some(e => e.type === "progress" && /^Not pushed: the server didn't say/.test(e.text)));

  const lost = pushingTurn();
  const gone = server(lost, () => new ApiError(409));
  assert.equal(await finish(lost, gone.post), 0);
  assert.equal(gone.publishCalls(), 1);
});
