import { z } from "zod";
import { IsoTime, Location, ProviderId, Runner } from "./common.ts";

/**
 * Job lifecycle (server-owned):
 *
 *   queued ──claim──▶ running ──needs_input──▶ waiting ──answer──▶ queued (continue) ──claim──▶ running …
 *                        │
 *                        ├──result──▶ succeeded
 *                        ├──error───▶ failed
 *                        └──lease expires──▶ queued (again, same turn) or failed after max attempts
 *   any non-final ──cancel──▶ cancelled
 *
 * One claim = one *turn*. A turn ends with `result`, `needs_input` or `error`.
 * After `needs_input` the node releases the worker; when the person answers,
 * the server queues a `continue` turn pinned to the same node and checkout,
 * carrying the provider session id so the node resumes it
 * (`claude --resume <id>`, `codex exec resume <id>`). For a Cloudroom job the
 * session id is the Cloudroom thread id (`thr_…`) and continuing is `room-cli thread tell`.
 */

export const JobStatus = z.enum([
  "queued",
  "running",
  "waiting", // a question is open for the person
  "succeeded",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobSpec = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string(),
  prompt: z.string(),
  provider: ProviderId,
  /** Exact model id; omitted = provider default. */
  model: z.string().optional(),
  location: Location,
  /** What runs it: the node directly, Cloudroom's cloud, or Claude's cloud through a routine. */
  runner: Runner.default("direct"),
  /** Optional reasoning effort hint, passed through when the provider supports one. */
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  /** Checkout to run in. Set by the server from the project's remote and the node's checkouts. */
  checkoutPath: z.string(),
  /**
   * The project's repo, as the server knows it (normalised, e.g. github.com/owner/repo).
   * The node runs the job only if the checkout's origin really is this repo, after any
   * insteadOf / pushInsteadOf rewrite, and a pushing job publishes only there.
   * Omitted by older servers: then a pushing job keeps its work on this machine.
   */
  remote: z.string().optional(),
  /** Pin to a node (always set for continue turns). */
  nodeId: z.string().uuid().optional(),
  /** Source issue, if the job came from one. */
  issueUrl: z.string().url().optional(),
  /**
   * Land the work on the branch the checkout was on, and push it. The node starts
   * the worktree from that branch on origin, and when the job succeeds pushes
   * there (fast-forward, rebasing if origin moved). If that can't be done it
   * pushes the job's own branch instead and says so in a progress event.
   * Omitted or false: commit on the job's branch and never push.
   */
  push: z.boolean().optional(),
});
export type JobSpec = z.infer<typeof JobSpec>;

export const ClaimRequest = z.object({
  /** Providers this node will take right now (free capacity). */
  providers: z.array(ProviderId),
  /** Providers this node will take right now as Cloudroom jobs (see NodeHeartbeat.cloudroom). */
  cloudroomProviders: z.array(ProviderId).default([]),
  /** This node will take Claude jobs for Claude's cloud right now (see NodeHeartbeat.claudeCloud). */
  claudeCloud: z.boolean().default(false),
  /**
   * Max turns to hand out in this call: local slots free. When cloudMax is set,
   * it's direct jobs only and may be 0; without it (older helpers) it covers every job.
   */
  max: z.number().int().nonnegative().default(1),
  /** Max cloud jobs (runsInCloud) to hand out in this call: cloud slots free (see NodeHeartbeat.cloudCapacity). */
  cloudMax: z.number().int().nonnegative().optional(),
}).refine((r) => r.providers.length + r.cloudroomProviders.length > 0 || r.claudeCloud, "Offer at least one agent, direct or in a cloud.")
  .refine((r) => r.max + (r.cloudMax ?? 0) > 0, "Offer at least one free slot.");
export type ClaimRequest = z.infer<typeof ClaimRequest>;

export const Turn = z.object({
  /** Unique per turn; used for idempotent event delivery and lease renewals. */
  turnId: z.string().uuid(),
  leaseId: z.string().uuid(),
  leaseExpiresAt: IsoTime,
  kind: z.enum(["start", "continue"]),
  job: JobSpec,
  /** Present for continue turns. */
  providerSessionId: z.string().optional(),
  /** Present for continue turns: the person's answer to resume with. */
  answer: z.object({ answerId: z.string().uuid(), questionId: z.string().uuid(), text: z.string() }).optional(),
});
export type Turn = z.infer<typeof Turn>;

export const ClaimResponse = z.object({ turns: z.array(Turn) });
export type ClaimResponse = z.infer<typeof ClaimResponse>;

export const LeaseRenewRequest = z.object({ leaseId: z.string().uuid() });
export const LeaseRenewResponse = z.object({
  leaseExpiresAt: IsoTime,
  /** True when the person cancelled: stop the worker and send a final error event with code "cancelled". */
  cancel: z.boolean(),
});

/** The question a turn ends with when it needs the person. */
export const NeedsInput = z.object({
  /** Plain words, one thought per line. */
  question: z.string().min(1),
  /** Optional quick answers shown as buttons. */
  options: z.array(z.string()).max(6).optional(),
  /** Why it's blocked, if different from the question. */
  context: z.string().optional(),
});
export type NeedsInput = z.infer<typeof NeedsInput>;

const EventBase = z.object({
  /** 0-based, strictly increasing within a turn. The server ignores seq it has seen (idempotent retries). */
  seq: z.number().int().nonnegative(),
  at: IsoTime,
});

export const JobEvent = z.discriminatedUnion("type", [
  /** Provider session id became known (send as soon as it is). */
  EventBase.extend({ type: z.literal("session"), providerSessionId: z.string() }),
  /** Short human-readable progress line ("Running tests"). Keep it plain. */
  EventBase.extend({ type: z.literal("progress"), text: z.string() }),
  /**
   * Tool approval the worker could not get. Logged on the job only: the agent
   * often finishes another way. It becomes part of the roadblock if the job fails.
   */
  EventBase.extend({ type: z.literal("blocked"), text: z.string() }),
  /** Token/cost accounting for the turn, if known. */
  EventBase.extend({
    type: z.literal("usage"),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  }),
  /** Terminal: the turn finished and needs the person. */
  EventBase.extend({ type: z.literal("needs_input"), needsInput: NeedsInput }),
  /** Terminal: the turn finished and the job is done. */
  EventBase.extend({ type: z.literal("result"), summary: z.string() }),
  /** Terminal: the turn failed. `retryable` lets the server requeue it. */
  EventBase.extend({
    type: z.literal("error"),
    code: z.enum(["cancelled", "auth_required", "rate_limited", "provider_error", "worker_crashed", "other"]),
    message: z.string(),
    retryable: z.boolean().default(false),
  }),
]);
export type JobEvent = z.infer<typeof JobEvent>;

export const JobEventsRequest = z.object({
  leaseId: z.string().uuid(),
  events: z.array(JobEvent).min(1),
});
export type JobEventsRequest = z.infer<typeof JobEventsRequest>;

export const TerminalEventTypes = ["needs_input", "result", "error"] as const;
