/* Usage collection adapted from omarchy-agent-usage-codex (MIT). */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { childEnv, command, executable, json, localPath, number, object, parse, string, timestamp } from "../system.ts";
import { accessToken, AuthRequired, jwt, LoginStale, percent, request } from "./common.ts";
import type { System } from "../system.ts";
import type { Adapter, Login, UsageContext } from "./common.ts";

const plans: ReadonlyMap<string, string> = new Map([
  ["pro", "Pro 200"], ["prolite", "Pro 100"], ["promax", "Pro 500"], ["team", "Business"], ["plus", "Plus"],
]);

function usageWindow(id: string, key: string, minutes: number | undefined, used: unknown, reset: unknown, label?: string) {
  const kind = minutes === 10080 ? "weekly" : minutes === 43200 ? "monthly" :
    minutes !== undefined && minutes <= 1440 ? "session" : "period";
  const title = minutes === 300 ? "5-hour" : kind === "weekly" ? "Weekly" :
    kind === "monthly" ? "Monthly" : minutes ? `${minutes}-minute` : key;
  return percent(`${id}:${key}`, label ? `${label} ${title}` : title, kind, used, reset);
}

async function fileLimits(ctx: UsageContext, login: Login, accountId: string) {
  // The usage endpoint and response fields follow Cloudroom's Codex collector (Apache 2.0).
  if (login.token && login.expiresAt && Date.parse(login.expiresAt) <= Date.now()) throw new LoginStale();
  const data = await request(ctx, "https://chatgpt.com/backend-api/wham/usage", login, undefined, {
    "ChatGPT-Account-Id": accountId,
  }).catch(error => {
    if (error instanceof AuthRequired && error.message === "refused") throw new LoginStale();
    throw error;
  });
  const rateLimit = object(data.rate_limit);
  const windows = ["primary", "secondary"].flatMap(key => {
    const window = object(rateLimit[`${key}_window`]);
    const seconds = number(window.limit_window_seconds);
    return usageWindow("codex", key, seconds === undefined ? undefined : seconds / 60, window.used_percent, window.reset_at);
  });
  const plan = string(data.plan_type);
  return { plan: plan && (plans.get(plan.toLowerCase()) ?? plan), windows };
}

async function limits(ctx: UsageContext, login: Login, binary: string) {
  const dir = await mkdtemp(join(tmpdir(), "opnav-codex-"));
  const env = childEnv(ctx.sys.env);
  for (const key of ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL", "CODEX_API_KEY", "RUST_LOG", "RUST_LOG_STYLE"]) delete env[key];
  const proc = spawn(binary, ["app-server"], {
    cwd: dir, env: { ...env, CODEX_HOME: dir, RUST_LOG: "off" }, stdio: ["pipe", "pipe", "ignore"],
  });
  const exited = new Promise<void>(resolve => proc.once("close", () => resolve()));
  const lines = createInterface({ input: proc.stdout });
  let seq = 0;
  let pending: { id: number; finish: (error?: Error, value?: Record<string, unknown>) => void } | undefined;
  const fail = () => pending?.finish(new Error("Codex app-server stopped"));
  const abort = () => fail();
  proc.on("error", fail);
  proc.stdin.on("error", fail);
  proc.on("close", fail);
  ctx.signal?.addEventListener("abort", abort, { once: true });
  lines.on("line", line => {
    const message = parse(line);
    if (message.method === "account/chatgptAuthTokens/refresh") {
      proc.stdin.write(JSON.stringify({ id: message.id, error: { code: -32000, message: "Token refresh unavailable" } }) + "\n");
      pending?.finish(new AuthRequired());
    } else if (pending && message.id === pending.id && !message.method) {
      if (message.error) pending.finish(new Error("Codex app-server request failed"));
      else pending.finish(undefined, object(message.result));
    }
  });
  function rpc(method: string, params?: object, timeout = 8000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (ctx.signal?.aborted || proc.exitCode !== null || proc.stdin.destroyed) {
        reject(new Error("Codex app-server stopped"));
        return;
      }
      const id = ++seq;
      const timer = setTimeout(() => pending?.finish(new Error("Codex app-server timed out")), timeout);
      pending = { id, finish(error, value) {
        clearTimeout(timer);
        pending = undefined;
        if (error) reject(error);
        else resolve(value ?? {});
      } };
      proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  try {
    await rpc("initialize", { clientInfo: { name: "opnav-node", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    proc.stdin.write('{"method":"initialized"}\n');
    // External-token mode has no refresh token and cannot update the user's sign-in.
    await rpc("account/login/start", { type: "chatgptAuthTokens", accessToken: login.token,
      chatgptAccountId: login.metadata?.workspace, chatgptPlanType: login.metadata?.rawPlan });
    const data = await rpc("account/rateLimits/read");
    const buckets = Object.entries(object(data.rateLimitsByLimitId));
    const legacy = object(data.rateLimits);
    if (!buckets.length) buckets.push([string(legacy.limitId) ?? "codex", legacy]);
    let plan = string(legacy.planType);
    const windows = buckets.flatMap(([id, raw]) => {
      const bucket = object(raw);
      plan ??= string(bucket.planType);
      const label = string(bucket.limitName);
      return ["primary", "secondary"].flatMap(key => {
        const window = object(bucket[key]);
        return usageWindow(id, key, number(window.windowDurationMins), window.usedPercent, window.resetsAt, label);
      });
    });
    const cap = [legacy, ...buckets.map(([, value]) => object(value))]
      .map(bucket => object(bucket.individualLimit)).find(bucket => Object.keys(bucket).length);
    if (cap) {
      const limit = number(cap.limit);
      const used = number(cap.used);
      const remaining = number(cap.remainingPercent);
      windows.push(...percent("spend", "Spend limit", "spend", limit && limit > 0 && used !== undefined
        ? used * 100 / limit : remaining === undefined ? undefined : 100 - remaining, cap.resetsAt));
    }
    if (!plan) {
      const account = await rpc("account/read", { refreshToken: false }, 2000).catch(() => ({}));
      plan = string(object(object(account).account).planType) ?? login.plan;
    }
    return { plan: plan && (plans.get(plan.toLowerCase()) ?? plan), windows };
  } finally {
    ctx.signal?.removeEventListener("abort", abort);
    lines.close();
    proc.kill("SIGKILL");
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
}

async function savedAuth(sys: System) {
  const home = localPath(sys, sys.env.CODEX_HOME ?? "~/.codex");
  const path = join(home, "auth.json");
  const config = await readFile(join(home, "config.toml"), "utf8").catch(() => "");
  const mode = /^\s*cli_auth_credentials_store\s*=\s*["'](file|keyring|auto)["']/m.exec(config)?.[1];
  if (mode === "keyring" || mode === "auto") {
    const canonical = await realpath(home).catch(() => home);
    const account = "cli|" + createHash("sha256").update(canonical).digest("hex").slice(0, 16);
    const secret = sys.platform === "darwin"
      ? await command(sys, "security", ["find-generic-password", "-s", "Codex Auth", "-a", account, "-w"])
      : await command(sys, "secret-tool", ["lookup", "service", "Codex Auth", "username", account]);
    if (secret || mode === "keyring") return { auth: parse(secret), file: false };
  }
  return { auth: await json(path), file: true };
}

export const codex: Adapter = {
  provider: "codex",
  commands: ["codex"],
  async detect(sys) {
    const { auth, file } = await savedAuth(sys);
    const tokens = object(auth.tokens);
    const token = string(sys.env.CODEX_ACCESS_TOKEN) ?? string(tokens.access_token);
    const refreshToken = sys.env.CODEX_ACCESS_TOKEN ? undefined : string(tokens.refresh_token);
    const credential = string(auth.OPENAI_API_KEY ?? sys.env.OPENAI_API_KEY);
    if (!token && !refreshToken) return credential || auth.auth_mode === "apikey"
      ? { credential, plan: "API key" } : undefined;
    const claims = jwt(token);
    const access = object(claims["https://api.openai.com/auth"]);
    const profile = sys.env.CODEX_ACCESS_TOKEN ? {} : jwt(string(tokens.id_token));
    const identity = sys.env.CODEX_ACCESS_TOKEN ? access : object(profile["https://api.openai.com/auth"]);
    const workspace = string((sys.env.CODEX_ACCESS_TOKEN ? undefined : tokens.account_id) ?? access.chatgpt_account_id);
    const user = string(identity.chatgpt_user_id ?? identity.user_id ?? access.chatgpt_user_id ?? access.user_id);
    const plan = string(access.chatgpt_plan_type);
    return { token, refreshToken, refreshExpiresAt: timestamp(tokens.refresh_token_expires_at),
      id: workspace && user ? `${workspace}\n${user}` : string(profile.sub ?? claims.sub) ?? string(profile.email)?.toLowerCase(),
      expiresAt: timestamp(claims.exp), plan: plan && (plans.get(plan.toLowerCase()) ?? plan),
      metadata: { workspace, rawPlan: plan,
        fileAccountId: file && !sys.env.CODEX_ACCESS_TOKEN ? string(tokens.account_id) : undefined } };
  },
  async read(ctx, login) {
    if (login.plan === "API key") return { windows: [], unavailable: "API key sign-ins have no subscription limits." };
    const binary = await executable(ctx.sys, ["codex"]);
    if (!binary) {
      const accountId = string(login.metadata?.fileAccountId);
      return accountId ? fileLimits(ctx, login, accountId) :
        { windows: [], unavailable: "Install the Codex CLI to read usage on this machine." };
    }
    accessToken(login);
    if (!login.metadata?.workspace) throw new Error("Codex account could not be identified");
    return limits(ctx, login, binary);
  },
};
