import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { JobEvent, NeedsInput } from "@opnav/shared";
import type { Turn } from "@opnav/shared";
import { geminiInvocation } from "./gemini.ts";
import { executable, object, parse, string } from "./system.ts";
import type { System } from "./system.ts";
import { openWorktree, WorktreeError, worktreeEnv } from "./worktrees.ts";

type WithoutEnvelope<T> = T extends unknown ? Omit<T, "seq" | "at"> : never;
export type EventContent = WithoutEnvelope<JobEvent>;
export type Terminal = Extract<EventContent, { type: "error" | "result" | "needs_input" }>;

const instruction = [
  "If you need the user to answer before you can continue, end your final reply with an opnav-needs-input fenced block.",
  "Inside the block put only JSON with a nonempty question string, optional options (up to six strings), and optional context string.",
  "For example:",
  "```opnav-needs-input",
  '{"question":"Which option should I use?","options":["First","Second"]}',
  "```",
].join("\n");

export type Autonomy = "edit" | "full";

export function workerArgs(turn: Turn, autonomy: Autonomy = "edit", claudeSandbox = false): string[] {
  const { job, providerSessionId } = turn;
  if (turn.kind === "continue" && (!providerSessionId || providerSessionId.startsWith("-") || !turn.answer)) {
    throw new Error("Continue turn needs a session and an answer");
  }
  const resume = turn.kind === "continue" ? providerSessionId : undefined;
  const model = job.model ? [`--model=${job.model}`] : [];
  if (job.provider === "claude") {
    const permissions = autonomy === "full" ? ["--dangerously-skip-permissions"] : [
      "--permission-mode", "acceptEdits",
      ...(claudeSandbox ? ["--settings", JSON.stringify({ sandbox: {
        enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
      } })] : []),
    ];
    return ["-p", "--output-format", "stream-json", "--verbose", ...permissions, ...model,
      ...(job.effort ? ["--effort", job.effort] : []), ...(resume ? ["--resume", resume] : [])];
  }
  if (job.provider === "codex") {
    const permissions = autonomy === "full" ? ["--dangerously-bypass-approvals-and-sandbox"]
      : resume ? ["-c", 'sandbox_mode="workspace-write"'] : ["--sandbox", "workspace-write"];
    return ["exec", ...(resume ? ["resume"] : []), ...permissions, "--json", ...model,
      ...(job.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(job.effort)}`] : []),
      ...(resume ? [resume] : []), "-"];
  }
  throw new Error("Unsupported provider");
}

export function terminal(text: string): Terminal {
  const matches = [...text.matchAll(/(?:^|\n)```opnav-needs-input[ \t]*\r?\n((?:(?!^[ \t]*```).*\r?\n)*)```[ \t]*(?=\r?\n|$)/gm)];
  const last = matches.at(-1);
  const block = last && !text.slice(last.index + last[0].length).trim() ? last[1] : undefined;
  if (block) {
    const parsed = NeedsInput.safeParse(parse(block));
    if (parsed.success) return { type: "needs_input", needsInput: parsed.data };
  }
  return { type: "result", summary: text };
}

function errorEvent(details: string, crashed = false): Terminal {
  if (/unauthorized|not logged in|authentication|auth required|invalid api key|please log in/i.test(details)) {
    return { type: "error", code: "auth_required", message: "Sign in to the worker and try again.", retryable: false };
  }
  if (/rate limit|usage limit|hit your limit|\b429\b/i.test(details)) {
    return { type: "error", code: "rate_limited", message: "The worker reached its usage limit.", retryable: true };
  }
  return { type: "error", code: crashed ? "worker_crashed" : "provider_error",
    message: crashed ? "The worker stopped before finishing." : "The worker reported an error.", retryable: false };
}

export async function runWorker(sys: System, binary: string, turn: Turn, signal: AbortSignal,
  emit: (event: EventContent) => void, autonomy: Autonomy = "edit"): Promise<Terminal> {
  if (turn.job.location !== "cloud") {
    return { type: "error", code: "provider_error", message: "This worker only runs cloud models.", retryable: false };
  }
  if (signal.aborted) return { type: "error", code: "cancelled", message: "The turn was cancelled.", retryable: false };
  const worktree = await openWorktree(sys, turn.job).catch(error => {
    if (error instanceof WorktreeError) return error;
    throw error;
  });
  if (worktree instanceof WorktreeError) {
    return { type: "error", code: "other", message: worktree.message, retryable: false };
  }
  try {
    return await runInWorktree(sys, binary, turn, signal, emit, autonomy, worktree.path, worktree.branch);
  } finally {
    await worktree.release();
  }
}

async function runInWorktree(sys: System, binary: string, turn: Turn, signal: AbortSignal,
  emit: (event: EventContent) => void, autonomy: Autonomy, cwd: string, branch: string): Promise<Terminal> {
  const claudeSandbox = turn.job.provider === "claude" && autonomy === "edit" &&
    (sys.platform === "darwin" || sys.platform === "linux" &&
      (await Promise.all([executable(sys, ["bwrap"]), executable(sys, ["socat"])])).every(Boolean));
  if (turn.kind === "continue" && !turn.answer) throw new Error("Continue turn needs an answer");
  const gemini = turn.job.provider === "gemini" ? await geminiInvocation(sys, binary, turn) : undefined;
  const args = gemini?.args ?? workerArgs(turn, autonomy, claudeSandbox);
  const input = gemini?.input ?? (turn.kind === "continue" ? turn.answer!.text : turn.job.prompt);
  const prompt = `${input}\n\n${instruction}\nYour work is already on branch ${branch}. Commit there and do not push.\n`;
  if (signal.aborted) return { type: "error", code: "cancelled", message: "The turn was cancelled.", retryable: false };
  const group = sys.platform !== "win32";
  const proc = spawn(binary, args, { cwd, env: worktreeEnv(sys), detached: group,
    stdio: ["pipe", "pipe", "pipe"] });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  function kill(force: boolean) {
    const name = force ? "SIGKILL" : "SIGTERM";
    try {
      if (group && proc.pid) process.kill(-proc.pid, name);
      else proc.kill(name);
    } catch {
      // The process exited before it could be signalled.
    }
  }
  const abort = () => {
    kill(false);
    killTimer = setTimeout(() => kill(true), 1500);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  let result: string | undefined;
  let session = turn.providerSessionId;
  let stderr = "";
  let stdout = "";
  let failure = "";
  let failed = false;
  let crashed = false;
  let complete = false;
  proc.on("error", () => { crashed = true; });
  proc.stdin.on("error", () => {});
  proc.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  const lines = createInterface({ input: proc.stdout });
  const setSession = (id?: string) => {
    if (id && id !== session) {
      session = id;
      emit({ type: "session", providerSessionId: id });
    }
  };
  const usage = (raw: unknown, cost?: unknown) => {
    const value = object(raw);
    const parsed = JobEvent.safeParse({ type: "usage", seq: 0, at: new Date().toISOString(),
      inputTokens: value.input_tokens, outputTokens: value.output_tokens, costUsd: cost });
    if (parsed.success && parsed.data.type === "usage") {
      const { seq: _seq, at: _at, ...event } = parsed.data;
      if (event.inputTokens !== undefined || event.outputTokens !== undefined || event.costUsd !== undefined) emit(event);
    }
  };
  lines.on("line", line => {
    if (signal.aborted) return;
    if (gemini && gemini.format !== "stream-json") {
      stdout += line + "\n";
      return;
    }
    const event = parse(line);
    if (gemini) {
      if (event.type === "init") setSession(string(event.session_id));
      if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
        result = event.delta === true ? (result ?? "") + event.content : event.content;
      }
      if (event.type === "tool_use") emit({ type: "progress", text: "Gemini CLI is using tools." });
      if (event.type === "error") failure = string(event.message) ?? failure;
      if (event.type === "result") {
        complete = true;
        failed = event.status !== "success";
        failure = string(object(event.error).message) ?? failure;
        usage(event.stats);
      }
      return;
    }
    if (turn.job.provider === "claude") {
      setSession(string(event.session_id));
      if (event.type === "assistant") {
        const content = object(event.message).content;
        if (Array.isArray(content) && content.some(item => object(item).type === "tool_use")) {
          emit({ type: "progress", text: "Claude is using tools." });
        }
      }
      if (event.type === "result") {
        complete = true;
        failed = event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success");
        result = typeof event.result === "string" ? event.result : undefined;
        if (failed) failure = [result, ...(Array.isArray(event.errors) ? event.errors.filter(item => typeof item === "string") : [])].join(" ");
        if (Array.isArray(event.permission_denials) && event.permission_denials.length) {
          emit({ type: "blocked", text: "Claude could not get permission to run a tool." });
        }
        usage(event.usage, event.total_cost_usd);
      }
      return;
    }
    if (event.type === "thread.started") setSession(string(event.thread_id));
    if (event.type === "turn.completed") {
      complete = true;
      usage(event.usage);
    }
    if (event.type === "turn.failed") {
      failed = true;
      failure = string(object(event.error).message) ?? failure;
    }
    if (event.type === "error") failure = string(event.message) ?? failure;
    const item = object(event.item);
    if (event.type === "item.started" && item.type === "command_execution") {
      emit({ type: "progress", text: "Codex is running a command." });
    }
    if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
      result = item.text;
    }
  });
  proc.stdin.end(prompt);
  const exit = await new Promise<number | null>(resolve => proc.once("close", resolve));
  if (signal.aborted) kill(true);
  clearTimeout(killTimer);
  signal.removeEventListener("abort", abort);
  lines.close();
  if (signal.aborted) return { type: "error", code: "cancelled", message: "The turn was cancelled.", retryable: false };
  if (gemini?.format === "json") {
    const event = parse(stdout);
    setSession(string(event.session_id));
    result = string(event.response);
    failed = !!event.error;
    failure = string(object(event.error).message) ?? failure;
    complete = result !== undefined;
  }
  if (gemini?.format === "text") {
    result = stdout.trimEnd();
    complete = !!result;
  }
  if (exit !== 0 || failed || !complete) return errorEvent(`${failure}\n${stderr}`, crashed || !complete && !failed);
  const outcome = terminal(result ?? "");
  if (gemini && outcome.type === "needs_input") await gemini.remember(result!);
  return outcome;
}
