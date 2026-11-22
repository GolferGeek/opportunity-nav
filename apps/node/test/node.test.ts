import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ClaimRequest, ExternalWorkReport, JobEventsRequest, NodeHeartbeat, NODE, UsageReport } from "@opnav/shared";
import type { JobEvent, Turn } from "@opnav/shared";
import { startNode } from "../src/index.ts";
import { normalizeRemote } from "../src/capabilities.ts";
import { handoffReport } from "../src/handoff.ts";
import { system } from "../src/system.ts";
import { createUsageCollector } from "../src/usage/index.ts";
import { terminal } from "../src/worker.ts";

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "opnav-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".claude"));
  await writeFile(join(home, ".claude/.credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "fixture-only", subscriptionType: "max", rateLimitTier: "default_claude_max_5x" },
  }));
  await writeFile(join(home, ".claude.json"), '{"oauthAccount":{"accountUuid":"account-a"}}');
  return home;
}

function usageFixture() {
  return readFile(new URL("./fixtures/claude-usage.json", import.meta.url), "utf8");
}

test("usage keeps only the matching account's last good reading and rolls over elapsed resets", async t => {
  const home = await fixture(t);
  let ok = true;
  const makeCollector = () => createUsageCollector({
    sys: system({ home, env: {} }),
    fetch: async (url, init) => {
      assert.equal(String(url), "https://api.anthropic.com/api/oauth/usage");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-only");
      return ok ? new Response(await usageFixture()) : new Response(null, { status: 503 });
    },
  });
  const collect = makeCollector();
  const fresh = (await collect()).report.accounts[0]!;
  assert.equal(fresh.accountKey, createHash("sha256").update("account-a").digest("hex"));
  assert.equal(fresh.plan, "Max 5x");
  assert.deepEqual(fresh.windows.map(value => value.used), [17, 36, 8]);
  ok = false;
  const stale = (await collect()).report.accounts[0]!;
  assert.equal(stale.status, "stale");
  assert.equal(stale.fetchedAt, fresh.fetchedAt);
  assert.deepEqual(stale.windows.map(value => value.used), [0, 36, 8]);
  assert.equal(JSON.stringify((await makeCollector()()).report.accounts[0]), JSON.stringify(stale));
  await writeFile(join(home, ".claude.json"), '{"oauthAccount":{"accountUuid":"account-b"}}');
  const changed = (await collect()).report.accounts[0]!;
  assert.equal(changed.status, "error");
  assert.deepEqual(changed.windows, []);
});

test("handoff keeps newest stage, DONE line and open questions", async t => {
  const home = await fixture(t);
  const dir = join(home, "Work/handoff");
  await Promise.all(["inbox", "working", "done"].map(stage => mkdir(join(dir, stage), { recursive: true })));
  await writeFile(join(dir, "STATUS.md"), [
    "2026-11-22 09:17:41 START task (in /checkout; commit=0 push=0)",
    "2026-11-22 DONE task: changed a file.",
  ].join("\n"));
  await writeFile(join(dir, "inbox/task.md"), "---\ntitle: Fix the thing\nrepo: ~/project # inline comment\n---\nBrief");
  await writeFile(join(dir, "working/running.md"), "# Work in progress");
  await writeFile(join(dir, "inbox/queued.md"), "# Work queued");
  await writeFile(join(dir, "done/task.md"), "# Report\n\n## Questions for the user\n- Ship it?\n- Which branch?\n\n## Files\n- file.txt");
  const report = ExternalWorkReport.parse(await handoffReport(system({ home }), dir));
  assert.deepEqual(report.complete, ["handoff"]);
  assert.equal(report.items.find(item => item.externalId === "queued.md")?.status, "queued");
  assert.equal(report.items.find(item => item.externalId === "running.md")?.status, "running");
  const done = report.items.find(item => item.externalId === "task.md")!;
  assert.equal(done.status, "succeeded");
  assert.equal(done.title, "Fix the thing");
  assert.equal(done.repo, "/checkout");
  assert.equal(done.summary, "2026-11-22 DONE task: changed a file.");
  assert.deepEqual(done.questions, ["Ship it?", "Which branch?"]);
});

test("normalizes remotes and only treats a final valid fence as a question", () => {
  assert.equal(normalizeRemote("git@GitHub.COM:GolferGeek/repo.git"), "github.com/GolferGeek/repo");
  assert.equal(normalizeRemote("https://user:placeholder@github.com/GolferGeek/repo.git/?x=1"), "github.com/GolferGeek/repo");
  assert.equal(normalizeRemote("/tmp/repo.git"), undefined);
  assert.equal(terminal('```opnav-needs-input\n{"question":""}\n```').type, "result");
  assert.equal(terminal('```opnav-needs-input\n{"question":"What?"}\n```\nGoodbye').type, "result");
});

test("node sends heartbeat, uploads usage, retries events, resumes and cancels workers", { timeout: 15_000 }, async t => {
  const home = await fixture(t);
  const bin = join(home, "bin");
  await mkdir(bin);
  await symlink(process.execPath, join(bin, "node"));
  for (const name of ["claude", "codex"]) {
    const path = join(bin, name);
    await copyFile(new URL("./fixtures/worker.mjs", import.meta.url), path);
    await chmod(path, 0o700);
  }
  await mkdir(join(home, ".codex"));
  await writeFile(join(home, ".codex/auth.json"), '{"auth_mode":"apikey"}');
  await mkdir(join(home, "Work/handoff/inbox"), { recursive: true });
  await writeFile(join(home, "Work/handoff/inbox/test.md"), "# Test handoff");
  const projectId = randomUUID();
  const nodeId = randomUUID();
  const turns: Turn[] = [
    { turnId: randomUUID(), leaseId: randomUUID(), leaseExpiresAt: "", kind: "start",
      job: { id: randomUUID(), projectId, title: "Question", prompt: "Ask me", provider: "claude",
        model: "test-model", effort: "high", location: "cloud", checkoutPath: home } },
    { turnId: randomUUID(), leaseId: randomUUID(), leaseExpiresAt: "", kind: "continue",
      job: { id: randomUUID(), projectId, title: "Resume", prompt: "Ask me", provider: "codex",
        model: "test-model", effort: "high", location: "cloud", checkoutPath: home, nodeId },
      answer: { answerId: randomUUID(), questionId: randomUUID(), text: "Yes" }, providerSessionId: "session-from-claude" },
    { turnId: randomUUID(), leaseId: randomUUID(), leaseExpiresAt: "", kind: "start",
      job: { id: randomUUID(), projectId, title: "Cancel", prompt: "Wait", provider: "claude",
        model: "test-model", effort: "high", location: "cloud", checkoutPath: home } },
  ];
  turns.push({ turnId: randomUUID(), leaseId: randomUUID(), leaseExpiresAt: "", kind: "start",
    job: { id: randomUUID(), projectId, title: "Local draft", prompt: "Draft a note", provider: "ollama",
      model: "fixture:latest", location: "local", checkoutPath: "" } });
  const received = new Map<string, JobEvent[]>();
  let claim = 0;
  let firstBatch = "";
  let renewed = false;
  let usage = false;
  let external = false;
  let active = false;
  let revoked = false;
  let requestError: unknown;
  const server = createServer(async (req, res) => {
    try {
      let data = "";
      for await (const chunk of req) data += chunk;
      const body: unknown = JSON.parse(data);
      assert.equal(req.headers.authorization, "Bearer node-fixture");
      assert.equal(req.method, "POST");
      const respond = (value: object, code = 200) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url === NODE.heartbeat) {
        const heartbeat = NodeHeartbeat.parse(body);
        assert.equal(heartbeat.autonomy, "edit");
        assert.deepEqual(heartbeat.providers.find(value => value.provider === "ollama")?.models, ["fixture:latest"]);
        assert.ok(heartbeat.providers.some(value => value.provider === "claude" && value.canRunJobs && value.signedIn));
        active ||= heartbeat.activeJobIds.includes(turns[2]!.job.id);
        return respond({ nodeId, serverTime: new Date().toISOString(), usageIntervalSec: 1, heartbeatIntervalSec: 1 }, revoked ? 401 : 200);
      }
      if (req.url === NODE.usage) {
        usage = UsageReport.parse(body).accounts.some(account => account.windows[0]?.used === 17);
        return respond({ accepted: 1 });
      }
      if (req.url === NODE.external) {
        external = ExternalWorkReport.parse(body).items.some(item => item.title === "Test handoff");
        return respond({ accepted: 1 });
      }
      if (req.url === NODE.claim) {
        assert.deepEqual(ClaimRequest.parse(body), { providers: ["claude", "codex", "ollama"], max: 1 });
        const turn = turns[claim++];
        if (turn) turn.leaseExpiresAt = new Date(Date.now() + 3500).toISOString();
        return respond({ turns: turn ? [turn] : [] });
      }
      const turn = turns.find(item => req.url === NODE.lease(item.job.id) || req.url === NODE.events(item.job.id));
      assert.ok(turn);
      if (req.url === NODE.lease(turn.job.id)) {
        assert.equal(turn, turns[2]);
        assert.deepEqual(body, { leaseId: turn.leaseId });
        renewed = true;
        return respond({ cancel: true, leaseExpiresAt: new Date(Date.now() + 3500).toISOString() });
      }
      const events = JobEventsRequest.parse(body);
      assert.equal(events.leaseId, turn.leaseId);
      if (!firstBatch) {
        firstBatch = data;
        return respond({ error: "temporary fixture failure" }, 503);
      }
      const recorded = received.get(turn.job.id) ?? [];
      if (!received.size) assert.equal(data, firstBatch);
      for (const event of events.events) {
        assert.equal(event.seq, recorded.length);
        recorded.push(event);
      }
      received.set(turn.job.id, recorded);
      return respond({ lastSeq: recorded.at(-1)?.seq });
    } catch (error) {
      requestError = error;
      res.writeHead(500).end("{}");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const statuses: string[] = [];
  const service = startNode({
    serverUrl: `http://127.0.0.1:${address.port}`, token: "node-fixture", claimIntervalMs: 25,
    externalIntervalMs: 25, system: { home, env: { PATH: bin, OPNAV_NODE_TOKEN: "node-fixture" } },
    onStatus: message => statuses.push(message),
    fetch: async (url, init) => {
      if (String(url).startsWith("https://api.anthropic.com")) return new Response(await usageFixture());
      if (String(url) === "http://127.0.0.1:11434/api/tags") {
        return Response.json({ models: [{ model: "fixture:latest" }] });
      }
      if (String(url) === "http://127.0.0.1:11434/api/chat") {
        assert.deepEqual(JSON.parse(String(init?.body)), {
          model: "fixture:latest", stream: false, messages: [{ role: "user", content: "Draft a note" }],
        });
        assert.equal(new Headers(init?.headers).get("authorization"), null);
        return Response.json({ done: true, message: { content: "A short note." } });
      }
      return fetch(url, init);
    },
  });
  try {
    for (let i = 0; i < 160 && !received.get(turns[3]!.job.id)?.some(event => event.type === "result"); i++) {
      if (requestError) throw requestError;
      await sleep(30);
    }
    assert.ifError(requestError);
    assert.ok(usage && external && renewed && active, JSON.stringify({ usage, external, renewed, active, claim, events: [...received.values()].map(batch => batch.map(event => event.type)), statuses }));
    const first = received.get(turns[0]!.job.id);
    assert.equal(first?.[0]?.type, "session");
    assert.equal(first?.at(-1)?.type, "needs_input");
    const second = received.get(turns[1]!.job.id)?.at(-1);
    assert.ok(second?.type === "result" && second.summary === "Finished.");
    const last = received.get(turns[2]!.job.id)?.at(-1);
    assert.ok(last?.type === "error" && last.code === "cancelled");
    const draft = received.get(turns[3]!.job.id)?.at(-1);
    assert.ok(draft?.type === "result" && draft.summary === "A short note.");
    revoked = true;
    for (let i = 0; i < 60 && !statuses.includes("The node token was revoked."); i++) await sleep(30);
    assert.ok(statuses.includes("The node token was revoked."));
  } finally {
    await service.stop();
  }
});
