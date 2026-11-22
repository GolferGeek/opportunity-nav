import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { ProviderId, Turn } from "@opnav/shared";
import { redact, shortText, toolLine } from "./activity.ts";
import { normalizeRemote } from "./capabilities.ts";
import { childEnv, command, executable, object, string } from "./system.ts";
import type { System } from "./system.ts";
import { errorEvent, needsInputInstruction, terminal } from "./worker.ts";
import type { EventContent, Terminal } from "./worker.ts";
import { worktreeEnv } from "./worktrees.ts";

const exec = promisify(execFile);
const harnesses: Partial<Record<ProviderId, string>> = { claude: "claude-code", codex: "codex", agy: "antigravity" };
const threadId = /^thr_[\w-]+$/;
const pageSize = 200;

async function room(sys: System, binary: string, args: string[], signal?: AbortSignal) {
  const invocation = exec(binary, args, { env: childEnv(sys.env), signal, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  invocation.child.stdin?.end();
  const { stdout } = await invocation;
  return args.includes("--json") ? JSON.parse(stdout) as unknown : undefined;
}

export function cloudroomDetector(sys: System) {
  let cached: ReturnType<typeof detect> | undefined;
  let expires = 0;
  async function detect() {
    const binary = await executable(sys, ["room-cli"]);
    if (!binary) return;
    const status = object(await room(sys, binary, ["cloud", "status", "--json"]));
    if (status.ready !== true || !status.account || !Array.isArray(status.harnesses)) return;
    const defaults = new Map(status.harnesses.map(harness => [object(harness).id, string(object(harness).model)]));
    const providers = (Object.keys(harnesses) as ProviderId[]).filter(provider => defaults.has(harnesses[provider]));
    // Cloud threads need an explicit model; use each harness's own default when a job doesn't name one.
    const models: Partial<Record<ProviderId, string>> = {};
    for (const provider of providers) {
      const model = defaults.get(harnesses[provider]);
      if (model) models[provider] = model;
    }
    return { binary, providers, models, email: string(object(status.account).email) };
  }
  return () => {
    if (!cached || performance.now() >= expires) {
      cached = detect().catch(() => undefined);
      expires = performance.now() + 60_000;
    }
    return cached;
  };
}

export function cloudroomActivity(raw: unknown, hideEmail = (value: string) => value): string | undefined {
  const event = object(raw);
  const item = object(object(event.data).item);
  if (event.type === "item/started" && item.type === "toolCall") {
    const args = Object.fromEntries(Object.entries(object(item.arguments)).map(([key, value]) =>
      [key, typeof value === "string" ? hideEmail(value) : value]));
    return toolLine(item.tool, args);
  }
  if (event.type === "item/completed" && item.type === "agentMessage" && typeof item.text === "string") {
    return shortText(hideEmail(item.text));
  }
}

function tokens(raw: unknown) {
  const { inputTokens, outputTokens } = object(object(object(raw).tokenUsage).total);
  if (typeof inputTokens === "number" && Number.isSafeInteger(inputTokens) && inputTokens >= 0 &&
      typeof outputTokens === "number" && Number.isSafeInteger(outputTokens) && outputTokens >= 0) {
    return { inputTokens, outputTokens };
  }
}

function pendingQuestion(raw: unknown) {
  if (!Array.isArray(raw)) return;
  for (const entry of raw) {
    const { status, payload: value } = object(entry);
    const payload = object(value);
    if (status !== "pending" || payload.kind !== "user_question" || !Array.isArray(payload.questions)) continue;
    const questions = payload.questions.map(item => string(object(item).prompt)).filter(Boolean);
    if (questions.length) return questions.join("\n");
  }
}

class CloudroomError extends Error {}

export async function runCloudroom(sys: System, binary: string, turn: Turn, signal: AbortSignal,
  emit: (event: EventContent) => void,
  options: { email?: string; defaultModel?: string; pollMs?: number; provisioningMs?: number } = {}): Promise<Terminal> {
  const { job } = turn;
  const harness = harnesses[job.provider];
  const resume = turn.kind === "continue";
  const requestId = `opnav-${turn.turnId}`;
  let thread = resume && threadId.test(turn.providerSessionId ?? "") ? turn.providerSessionId : undefined;
  let directory: string | undefined;
  const hideEmail = (value: string) => options.email ? value.replaceAll(options.email, "[redacted]") : value;
  const clean = (value: string) => redact(hideEmail(value));
  const cli = (...args: string[]) => room(sys, binary, args, signal);
  const cancelled: Terminal = { type: "error", code: "cancelled", message: "The turn was cancelled.", retryable: false };
  let seq = 0;
  let priorUsage: ReturnType<typeof tokens>;
  async function log() {
    const rows = await cli("thread", "log", thread!, "--json", "--after-seq", String(seq), "--limit", String(pageSize));
    if (!Array.isArray(rows)) throw new CloudroomError("Cloudroom returned an invalid thread log.");
    return rows.map(object);
  }
  try {
    signal.throwIfAborted();
    if (!harness) throw new CloudroomError("Cloudroom does not support this provider.");
    if (resume && (!thread || !turn.answer)) throw new CloudroomError("Cloudroom needs a thread and an answer to continue.");
    const input = resume ? turn.answer!.text : job.prompt;
    const branch = `opnav/${job.id.slice(0, 8)}`;
    const origin = resume ? "" : "You start from the default branch on GitHub. Unpushed local changes are unavailable.\n";
    const prompt = `${input}\n\n${needsInputInstruction}\n${origin}Work on a branch named ${branch}: ${resume
      ? "continue on it if it already exists, or create it from where you are" : "create it from where you are"
    }. Commit there and push it to origin (git push -u origin HEAD). Don't open a pull request, and don't touch the default branch.\n`;
    directory = await mkdtemp(join(tmpdir(), "opnav-cloudroom-"));
    const file = join(directory, "prompt");
    await writeFile(file, prompt, { mode: 0o600 });
    if (thread) {
      // On a retried lease, replay from the same request if it already reached the log.
      let foundRequest = false;
      while (!foundRequest) {
        const rows = await log();
        for (const row of rows) {
          if (row.type === "client/turn/requested" && object(row.data).requestId === requestId) {
            foundRequest = true;
            break;
          }
          if (typeof row.seq !== "number" || row.seq <= seq) continue;
          seq = row.seq;
          if (row.type === "thread/tokenUsage/updated") priorUsage = tokens(row.data) ?? priorUsage;
        }
        if (rows.length < pageSize) break;
      }
      signal.throwIfAborted();
      const told = object(await room(sys, binary, ["thread", "tell", thread, "--message-file", file,
        "--request-id", requestId, "--json"]));
      if (told.ok !== true) throw new CloudroomError("Cloudroom could not send the answer.");
    } else {
      const remote = isAbsolute(job.checkoutPath) && normalizeRemote(await command(
        { ...sys, env: worktreeEnv(sys) }, "git", ["config", "--get", "remote.origin.url"], job.checkoutPath,
      ));
      if (!remote) throw new CloudroomError("The project checkout needs a Git origin for Cloudroom.");
      const projects = await cli("project", "list", "--json");
      if (!Array.isArray(projects)) throw new CloudroomError("Cloudroom returned an invalid project list.");
      const match = projects.map(object).find(project => normalizeRemote(string(project.gitRemoteUrl) ?? "") === remote);
      const project = match ?? object(await cli("project", "create", "--name", basename(remote), "--root", job.checkoutPath, "--json"));
      const id = string(project.id);
      if (!id || !/^proj_[\w-]+$/.test(id)) throw new CloudroomError("Cloudroom did not return a project ID.");
      signal.throwIfAborted();
      // Keep the response on abort so we can stop a thread accepted during the request.
      const spawned = object(await room(sys, binary, ["thread", "spawn", "--project", id, "--machine", "cloud",
        "--provider", harness, ...((job.model ?? options.defaultModel) ? ["--model", (job.model ?? options.defaultModel)!] : []),
        ...(job.effort ? ["--reasoning-level", job.effort] : []), "--title", job.title,
        "--request-id", requestId, "--prompt-file", file, "--json"]));
      const result = string(spawned.id);
      if (!result || !threadId.test(result)) throw new CloudroomError("Cloudroom did not return a thread ID.");
      thread = result;
      if (!signal.aborted) emit({ type: "session", providerSessionId: thread });
    }

    const started = performance.now();
    let running = false;
    let usage: ReturnType<typeof tokens>;
    let nextInspect = started;
    let nextProgress = 0;
    let pending: string | undefined;
    let previous: string | undefined;
    function flushProgress() {
      const text = pending;
      pending = undefined;
      if (!text || text === previous) return;
      emit({ type: "progress", text });
      previous = text;
      nextProgress = performance.now() + 1000;
    }
    while (!signal.aborted) {
      const rows = await log();
      for (const row of rows) {
        if (typeof row.seq !== "number" || row.seq <= seq) continue;
        seq = row.seq;
        const data = object(row.data);
        if (row.type === "turn/started") running = true;
        if (row.type === "thread/tokenUsage/updated") usage = tokens(data) ?? usage;
        if (row.type === "turn/completed") {
          if (performance.now() >= nextProgress) flushProgress();
          if (usage) {
            const inputTokens = usage.inputTokens - (priorUsage?.inputTokens ?? 0);
            const outputTokens = usage.outputTokens - (priorUsage?.outputTokens ?? 0);
            if (inputTokens >= 0 && outputTokens >= 0) emit({ type: "usage", inputTokens, outputTokens });
          }
          const output = object(await cli("thread", "output", thread, "--json"));
          if (output.error || data.status !== "completed") return errorEvent(
            string(output.error) ?? string(object(data.error).message) ?? "",
          );
          if (typeof output.output !== "string") throw new CloudroomError("Cloudroom did not return turn output.");
          return terminal(clean(output.output));
        }
        const progress = cloudroomActivity(row, hideEmail);
        if (progress) {
          pending = progress;
          if (performance.now() >= nextProgress) flushProgress();
        }
      }
      if (performance.now() >= nextProgress) flushProgress();
      if (rows.length === pageSize) continue;

      const now = performance.now();
      if (now >= nextInspect) {
        nextInspect = now + 10_000;
        const [shown, interactions] = await Promise.all([
          cli("thread", "show", thread, "--json", "--no-pr").catch(() => undefined),
          cli("thread", "interactions", "list", thread, "--json").catch(() => undefined),
        ]);
        const status = object(object(shown).thread);
        if (status.status === "failed" || string(object(status.runtime).displayStatus)?.toLowerCase() === "failed") {
          throw new CloudroomError("The Cloudroom thread failed.");
        }
        const question = pendingQuestion(interactions);
        if (question) return { type: "needs_input", needsInput: { question: clean(question) } };
      }
      if (!running && now - started >= (options.provisioningMs ?? 5 * 60_000)) {
        throw new CloudroomError(resume ? "Cloudroom did not start the next turn." : "Cloudroom did not finish provisioning the sandbox.");
      }
      await sleep(options.pollMs ?? 2000, undefined, { signal });
    }
    return cancelled;
  } catch (error) {
    if (signal.aborted) return cancelled;
    if (error instanceof CloudroomError) return {
      type: "error", code: "provider_error", message: error.message, retryable: false,
    };
    const { stderr, stdout } = object(error);
    const details = `${string(stderr) ?? ""}\n${string(stdout) ?? ""}`;
    const mapped = errorEvent(details);
    // Pass Cloudroom's own one-line reason through when it isn't a sign-in or limit problem.
    const reason = /^Error: (.{1,300})$/m.exec(details)?.[1];
    return mapped.type === "error" && mapped.code === "provider_error" && reason
      ? { ...mapped, message: `Cloudroom: ${clean(reason)}` } : mapped;
  } finally {
    if (signal.aborted && thread) await room(sys, binary, ["thread", "stop", thread]).catch(() => {});
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
