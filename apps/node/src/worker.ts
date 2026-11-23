import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { JobEvent, NeedsInput } from "@opnav/shared";
import type { Turn } from "@opnav/shared";
import { claudeActivity, codexActivity, shortText, toolLine } from "./activity.ts";
import { executable, object, parse, string } from "./system.ts";
import type { System } from "./system.ts";
import { openWorktree, WorktreeError, worktreeEnv } from "./worktrees.ts";

type WithoutEnvelope<T> = T extends unknown ? Omit<T, "seq" | "at"> : never;
export type EventContent = WithoutEnvelope<JobEvent>;
export type Terminal = Extract<EventContent, { type: "error" | "result" | "needs_input" }>;

export const needsInputInstruction = [
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
  if (job.provider === "agy") {
    // Headless agy can't ask, so it refuses anything not allowed up front and ends with an empty answer.
    // Edit mode: commands run inside agy's own sandbox (terminal restrictions, no network), files can be read
    // anywhere (like Claude and Codex), and edits stay inside the worktree.
    const permissions = autonomy === "full" ? ["--dangerously-skip-permissions"]
      : ["--mode", "accept-edits", "--sandbox", "--settings", JSON.stringify({ permissions: { allow: ["command(*)", "read_file(*)"] } })];
    return ["-p", "", "--input-format", "stream-json", "--output-format", "stream-json", ...permissions, ...model,
      ...(job.effort ? ["--effort", job.effort] : []), ...(resume ? ["--conversation", resume] : [])];
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

/**
 * Read agy's final result. agy says SUCCESS even when it stopped because a
 * tool was refused and it never answered; that's a failure, not a result.
 */
export function agyOutcome(final: Record<string, unknown>): { failed: boolean; result?: string; failure?: string; blocked?: string } {
  const result = typeof final.response === "string" ? final.response : undefined;
  const denied = Array.isArray(final.denied_actions)
    ? [...new Set(final.denied_actions.map(item => string(object(item).display_name) ?? string(object(item).action)).filter(Boolean))]
    : [];
  const blocked = denied.length ? `Antigravity could not get permission to run ${denied.join(", ")}.` : undefined;
  if (final.status !== "SUCCESS") return { failed: true, result, failure: string(final.error ?? final.response), blocked };
  if (!result?.trim()) {
    return { failed: true, failure: blocked ?? "Antigravity stopped without an answer.", blocked };
  }
  return { failed: false, result, blocked };
}

export function errorEvent(details: string, crashed = false): Terminal {
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
  const args = workerArgs(turn, autonomy, claudeSandbox);
  const input = turn.kind === "continue" ? turn.answer!.text : turn.job.prompt;
  // Headless agy ends the whole turn the moment an edit is refused, so tell it where it may edit.
  const where = turn.job.provider === "agy" && autonomy === "edit"
    ? `You can only edit files inside ${cwd}; edits anywhere else are refused and end your turn. Do all your work, builds and fixes there.\n` : "";
  const prompt = `${input}\n\n${needsInputInstruction}\nYour work is already on branch ${branch}. Commit there and do not push.\n${where}`;
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
  const agyText = new Map<number, string>();
  let lastProgress: string | undefined;
  let pendingProgress: string | undefined;
  let nextProgressAt = 0;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  const sendProgress = () => {
    progressTimer = undefined;
    const text = pendingProgress;
    pendingProgress = undefined;
    if (!text || text === lastProgress || signal.aborted) return;
    lastProgress = text;
    nextProgressAt = performance.now() + 1000;
    emit({ type: "progress", text });
  };
  const progress = (messages: string[]) => {
    for (const text of messages) {
      pendingProgress = text;
      if (progressTimer) continue;
      const delay = nextProgressAt - performance.now();
      if (delay <= 0) sendProgress();
      else progressTimer = setTimeout(sendProgress, Math.ceil(delay));
    }
  };
  lines.on("line", line => {
    if (signal.aborted) return;
    const event = parse(line);
    if (turn.job.provider === "agy") {
      const step = object(event.step_update);
      const final = object(event.result);
      setSession(string(event.conversation_id ?? step.conversation_id ?? final.conversation_id));
      if (event.event === "step_update" && step.step_type === "tool" && step.state === "ACTIVE") {
        const tool = object(step.tool_info);
        const text = toolLine(tool.name ?? step.tool_name, tool.parameters);
        if (text) progress([text]);
      }
      if (event.event === "step_update" && step.step_type === "agent_response" && typeof step.step_index === "number") {
        const index = step.step_index;
        const text = ((agyText.get(index) ?? "") + (typeof step.text_delta === "string" ? step.text_delta : "")).slice(0, 4096);
        if (step.state === "DONE") {
          agyText.delete(index);
          const message = shortText(text);
          if (message) progress([message]);
        } else {
          agyText.set(index, text);
        }
      }
      if (event.event === "result") {
        complete = true;
        const outcome = agyOutcome(final);
        failed = outcome.failed;
        result = outcome.result;
        if (outcome.failure) failure = outcome.failure;
        if (outcome.blocked) emit({ type: "blocked", text: outcome.blocked });
        usage(final.usage);
      }
      return;
    }
    if (turn.job.provider === "claude") {
      setSession(string(event.session_id));
      progress(claudeActivity(event));
      if (event.type === "result") {
        complete = true;
        failed = event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success");
        result = typeof event.result === "string" ? event.result : undefined;
        if (failed) failure = [result, ...(Array.isArray(event.errors) ? event.errors.filter(item => typeof item === "string") : [])].join(" ");
        if (Array.isArray(event.permission_denials) && event.permission_denials.length) {
          const tools = [...new Set(event.permission_denials.map(item => string(object(item).tool_name)).filter(Boolean))];
          emit({ type: "blocked", text: tools.length ? `Claude could not get permission to run ${tools.join(", ")}.` : "Claude could not get permission to run a tool." });
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
    progress(codexActivity(event));
    if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
      result = item.text;
    }
  });
  proc.stdin.end(turn.job.provider === "agy"
    ? JSON.stringify({ event: "user", message: { role: "user", content: prompt } }) + "\n"
    : prompt);
  const exit = await new Promise<number | null>(resolve => proc.once("close", resolve));
  if (signal.aborted) kill(true);
  clearTimeout(killTimer);
  clearTimeout(progressTimer);
  signal.removeEventListener("abort", abort);
  lines.close();
  if (signal.aborted) return { type: "error", code: "cancelled", message: "The turn was cancelled.", retryable: false };
  if (exit !== 0 || failed || !complete) return errorEvent(`${failure}\n${stderr}`, crashed || !complete && !failed);
  return terminal(result ?? "");
}
