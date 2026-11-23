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

const agentNames: Partial<Record<string, string>> = { claude: "Claude", codex: "Codex", agy: "Antigravity" };

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
 * Why a finished turn's work must not be pushed, or undefined when it may be.
 * Only a whole answer lands: a commit that failed, a cancel that came late, an empty
 * reply or a question block that didn't parse all mean the work may be half done.
 */
export function pushHold(summary: string, committed: boolean, signal: AbortSignal): string | undefined {
  if (signal.aborted) return "the job was cancelled.";
  if (!committed) return "the changes left in the worktree couldn't be committed.";
  if (!summary.trim()) return "the agent finished without a final answer.";
  if (/```[ \t]*opnav-needs-input/i.test(summary)) return "the agent's answer has a question block that couldn't be read.";
  return undefined;
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

const claudeSubtypes: Partial<Record<string, string>> = {
  error_max_turns: "Claude reached its turn limit before finishing.",
  error_max_budget_usd: "Claude reached its spending limit for this turn.",
  error_during_execution: "Claude hit an error while working.",
};

/** Claude's final result: whether it failed, and why in plain words. */
export function claudeOutcome(event: Record<string, unknown>): { failed: boolean; result?: string; failure?: string; reason?: string; blocked?: string } {
  const subtype = string(event.subtype);
  const failed = event.is_error === true || (subtype !== undefined && subtype !== "success");
  const result = typeof event.result === "string" ? event.result : undefined;
  const tools = Array.isArray(event.permission_denials)
    ? [...new Set(event.permission_denials.map(item => string(object(item).tool_name)).filter(Boolean))] : [];
  const blocked = Array.isArray(event.permission_denials) && event.permission_denials.length
    ? tools.length ? `Claude could not get permission to run ${tools.join(", ")}.` : "Claude could not get permission to run a tool."
    : undefined;
  if (!failed) return { failed, result, blocked };
  const errors = Array.isArray(event.errors) ? event.errors.filter(item => typeof item === "string") : [];
  const failure = [result, ...errors].filter(Boolean).join(" ");
  const reason = shortText(failure) ?? blocked ?? (subtype && claudeSubtypes[subtype]) ?? "Claude stopped with an error.";
  return { failed, result, failure, reason, blocked };
}

/** Codex sometimes wraps the API's error as JSON inside the message; pull out the readable part. */
export function codexReason(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const inner = parse(message.slice(message.indexOf("{")));
  const nested = message.includes("{") ? string(object(inner.error).message) ?? string(inner.message) ?? string(inner.detail) : undefined;
  return shortText(nested ?? message);
}

/** The last stderr line worth showing: the last one that mentions an error, else the last nonempty one. */
export function stderrReason(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return shortText(lines.findLast(line => /error|fail|denied|refused|not found|invalid/i.test(line)) ?? lines.at(-1));
}

/** `reason` is a plain sentence saying why the worker failed, shown instead of the generic message. */
export function errorEvent(details: string, crashed = false, reason?: string): Terminal {
  if (/unauthorized|not logged in|authentication|auth required|invalid api key|please log in/i.test(details)) {
    return { type: "error", code: "auth_required", message: "Sign in to the worker and try again.", retryable: false };
  }
  if (/rate limit|usage limit|hit your limit|\b429\b/i.test(details)) {
    return { type: "error", code: "rate_limited", message: "The worker reached its usage limit.", retryable: true };
  }
  return { type: "error", code: crashed ? "worker_crashed" : "provider_error",
    message: reason ?? (crashed ? "The worker stopped before finishing." : "The worker reported an error."), retryable: false };
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
    const outcome = await runInWorktree(sys, binary, turn, signal, emit, autonomy, worktree.path, worktree.branch);
    let committed = false;
    if (outcome.type !== "error" || outcome.code !== "cancelled") {
      const agent = agentNames[turn.job.provider] ?? "The agent";
      const title = turn.job.title.split("\n")[0]!.trim().slice(0, 72) || "Job work";
      committed = await worktree.commit(`${title}\n\n${agent} left these changes uncommitted (job ${turn.job.id.slice(0, 8)}); Opportunity Nav committed them.`)
        .then(sha => {
          if (sha) emit({ type: "progress", text: `Committed the changes ${agent} left, as ${sha}.` });
          return true;
        }, () => {
          emit({ type: "progress", text: `Could not commit the changes ${agent} left. They are still in the worktree.` });
          return false;
        });
    }
    // A pushing job lands its work only when it's done, not when it stops to ask.
    if (turn.job.push && outcome.type === "result") {
      const held = pushHold(outcome.summary, committed, signal);
      emit({ type: "progress", text: held ? `Not pushed: ${held} The work is on branch ${worktree.branch} on this machine.`
        : await worktree.push(signal) });
    }
    return outcome;
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
  const landing = turn.job.push ? " Opportunity Nav pushes it for you when you finish." : "";
  const prompt = `${input}\n\n${needsInputInstruction}\nYour work is already on branch ${branch}. Commit there and do not push.${landing}\nIf Git can't write its files from your sandbox, leave your changes in place: whatever you leave is committed for you when your turn ends.\n${where}`;
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
  let reason: string | undefined;
  let crashed = false;
  let startError: string | undefined;
  let complete = false;
  const agent = agentNames[turn.job.provider] ?? "The agent";
  proc.on("error", (error: NodeJS.ErrnoException) => {
    crashed = true;
    startError ??= `${agent} could not start${error.code ? ` (${error.code})` : ""}.`;
  });
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
        if (outcome.failed) reason = outcome.blocked ?? shortText(outcome.failure);
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
        const outcome = claudeOutcome(event);
        failed = outcome.failed;
        result = outcome.result;
        if (outcome.failure !== undefined) failure = outcome.failure;
        if (outcome.reason) reason = outcome.reason;
        if (outcome.blocked) emit({ type: "blocked", text: outcome.blocked });
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
      reason = codexReason(failure) ?? "Codex stopped with an error.";
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
  const [exit, exitSignal] = await new Promise<[number | null, NodeJS.Signals | null]>(resolve =>
    proc.once("close", (code, name) => resolve([code, name])));
  if (signal.aborted) kill(true);
  clearTimeout(killTimer);
  clearTimeout(progressTimer);
  signal.removeEventListener("abort", abort);
  lines.close();
  if (signal.aborted) return { type: "error", code: "cancelled", message: "The turn was cancelled.", retryable: false };
  if (exit !== 0 || failed || !complete) {
    // No reason from the stream: say how the process ended, with stderr's last useful line.
    const detail = stderrReason(stderr) ?? codexReason(failure);
    const ended = exitSignal ? `${agent} was stopped (${exitSignal})` : exit !== 0 && exit !== null ? `${agent} exited with code ${exit}`
      : `${agent} stopped before finishing`;
    reason ??= startError ?? (detail ? `${ended}: ${detail}` : `${ended}.`);
    return errorEvent(`${failure}\n${stderr}`, crashed || !complete && !failed, reason);
  }
  return terminal(result ?? "");
}
