import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { readUsage } from "../src/index.ts";

function fixtureJwt(fields: object) {
  return "fixture." + Buffer.from(JSON.stringify(fields)).toString("base64url") + ".fixture";
}

async function workspace(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "opnav-usage-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return {
    home,
    async save(name: string, data: object) {
      const file = join(home, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(data));
    },
  };
}

test("Cursor, Grok Bot, Antigravity, Grok and Gemini report fixture accounts", async t => {
  const { home, save } = await workspace(t);
  await save(".config/cursor/auth.json", { accessToken: fixtureJwt({ sub: "auth0|cursor-test" }) });
  await save(".gemini/antigravity-cli/antigravity-oauth-token",
    { token: { access_token: "test-agy" }, id_token: fixtureJwt({ sub: "google-agy" }) });
  await save(".grok/auth.json", { fixture: { key: fixtureJwt({ sub: "grok-test" }) } });
  await save(".gemini/oauth_creds.json", { access_token: "test-gemini" });
  await save(".gemini/google_accounts.json", { active: "test@example.invalid" });
  const data = JSON.parse(await readFile(new URL("./fixtures/usage-responses.json", import.meta.url), "utf8"));
  const calls: string[] = [];
  const report = await readUsage({
    system: { home, env: {}, platform: "linux" },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = url.pathname.split(/[/:]/).at(-1) + url.search;
      calls.push(method);
      if (method === "retrieveUserQuotaSummary") assert.deepEqual(JSON.parse(String(init?.body)), { project: "test-project" });
      assert.ok(data[method], method);
      return Response.json(data[method]);
    },
  });
  const [cursor, grokbot, agy, grok, gemini] = report.accounts;
  assert.deepEqual(report.accounts.map(account => account.provider), ["cursor", "grokbot", "agy", "grok", "gemini"]);
  assert.equal(cursor?.plan, "Fixture plan");
  assert.deepEqual(cursor?.windows.slice(0, 4).map(window => [window.kind, window.used]), [
    ["weekly", 25], ["weekly", 5], ["weekly", 40], ["spend", 1],
  ]);
  assert.equal(cursor?.windows.filter(window => window.unit === "tokens" && window.used === 12).length, 7);
  assert.equal(grokbot?.windows[0]?.used, 0);
  assert.deepEqual(agy?.windows.map(window => window.used), [50, 100]);
  assert.deepEqual(grok?.windows.map(window => window.used), [20, 30]);
  assert.equal(gemini?.status, "unavailable");
  assert.equal(calls.length, 14);
});

test("Codex uses the app-server with isolated external auth and falls back to account/read", async t => {
  const { home, save } = await workspace(t);
  const bin = join(home, "bin");
  await mkdir(bin);
  await symlink(process.execPath, join(bin, "node"));
  await copyFile(new URL("./fixtures/app-server.mjs", import.meta.url), join(bin, "codex"));
  await chmod(join(bin, "codex"), 0o700);
  const auth = { tokens: { access_token: fixtureJwt({}), account_id: "fixture-workspace",
    id_token: fixtureJwt({ "https://api.openai.com/auth": { chatgpt_user_id: "fixture-user" } }) } };
  await save(".codex/auth.json", auth);
  const { accounts } = await readUsage({
    system: { home, env: { PATH: bin, OPNAV_NODE_TOKEN: "fixture-service" } },
    fetch: async () => { throw new Error("No provider HTTP expected"); },
  });
  const account = accounts[0];
  assert.equal(account?.plan, "Plus");
  assert.deepEqual(account?.windows.map(window => window.used), [12, 37, 25]);
  assert.deepEqual(JSON.parse(await readFile(join(home, ".codex/auth.json"), "utf8")), auth);
});

test("scoped Claude windows win over legacy windows and lapsed accounts stay visible", async t => {
  const { home, save } = await workspace(t);
  await save(".claude/.credentials.json", { claudeAiOauth: { accessToken: "test-claude" } });
  await save(".gemini/antigravity-cli/antigravity-oauth-token",
    { token: { access_token: "test-agy", refresh_token: "fixture-refresh", expiry: "2000-01-01" } });
  await save(".config/cursor/auth.json", { accessToken: "test-cursor" });
  const { accounts } = await readUsage({
    system: { home, env: {}, platform: "linux" },
    fetch: async url => {
      assert.doesNotMatch(String(url), /googleapis/);
      if (String(url).includes("cursor.sh")) return new Response(null, { status: 401 });
      return Response.json({
        five_hour: null, seven_day: { utilization: 99 },
        limits: [
          { kind: "weekly_all", group: "weekly", percent: 9 },
          { kind: "weekly_scoped", group: "weekly", percent: 0, scope: { model: { display_name: "Fable" } } },
        ],
      });
    },
  });
  assert.deepEqual(accounts.find(a => a.provider === "claude")?.windows.map(w => [w.id, w.label, w.used, w.model]), [
    ["weekly_all", "Weekly", 9, undefined], ["weekly_scoped:fable", "Fable weekly", 0, "Fable"],
  ]);
  const agy = accounts.find(a => a.provider === "agy");
  assert.equal(agy?.status, "stale");
  assert.equal(agy?.message, "Start Antigravity to refresh it. No need to sign in again.");
  assert.match(agy?.accountKey ?? "", /^[a-f0-9]{64}$/);
  const cursor = accounts.find(a => a.provider === "cursor");
  assert.equal(cursor?.status, "auth_required");
  assert.equal(cursor?.message, "Cursor refused the saved sign-in. Sign in to the Cursor editor, or run `cursor-agent login`.");
});
