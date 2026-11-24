import { z } from "zod";
import { IsoTime, Location, MachineTool, ProviderId } from "./common.ts";

/**
 * A "node" is one machine running the helper (inside the desktop app, or as a
 * service on a headless box like the Studio). It authenticates every request
 * with `Authorization: Bearer <node token>`; tokens are created and revoked in
 * the app and scoped to the "node" role.
 */

export const ProviderCapability = z.object({
  provider: ProviderId,
  /** Absolute path of the CLI the node would run, if any. */
  cliPath: z.string().optional(),
  version: z.string().optional(),
  signedIn: z.boolean(),
  /** Can this node start jobs for the provider (not just read usage)? */
  canRunJobs: z.boolean(),
  locations: z.array(Location).default(["cloud"]),
  /** Model ids this node can run for the provider, when it can tell. */
  models: z.array(z.string()).default([]),
});
export type ProviderCapability = z.infer<typeof ProviderCapability>;

/** A local git checkout the node can run jobs in. */
export const Checkout = z.object({
  path: z.string(),
  /** Normalised remote, e.g. "github.com/GolferGeek/opportunity-nav". Used to map checkouts to projects. */
  remote: z.string().optional(),
  branch: z.string().optional(),
});
export type Checkout = z.infer<typeof Checkout>;

export const NodeHeartbeat = z.object({
  hostname: z.string(),
  /** Friendly name; defaults to hostname. */
  name: z.string().optional(),
  platform: z.enum(["darwin", "linux", "win32"]),
  arch: z.string(),
  helperVersion: z.string(),
  providers: z.array(ProviderCapability),
  checkouts: z.array(Checkout).default([]),
  /** Set when this node watches a handoff directory (Studio). */
  handoff: z.object({ dir: z.string() }).optional(),
  /**
   * How much a worker may do on this machine without asking, set by the machine's owner.
   * edit = edit files in the checkout and run sandboxed commands; full = no sandbox or prompts.
   */
  autonomy: z.enum(["edit", "full"]).default("edit"),
  /**
   * Set when this machine can hand jobs to Cloudroom's cloud (the Cloudroom app
   * is installed, running and signed in). Lists our provider ids it can run there.
   */
  cloudroom: z.object({ providers: z.array(ProviderId).default([]) }).optional(),
  /**
   * Whether this machine can run Claude jobs in Claude's cloud through a Claude Code
   * routine: ready once its owner has saved the routine's fire URL and token on it.
   * reason says why not ("not set up", ...). Omitted by older helpers.
   */
  claudeCloud: z.object({ ready: z.boolean(), reason: z.string().optional() }).optional(),
  /** What this machine has for jobs that need more than the agent and the repo (see MachineTool). */
  tools: z.array(MachineTool).default([]),
  /** Jobs this node currently holds leases on, so the server can expire the rest. */
  activeJobIds: z.array(z.string().uuid()).default([]),
  /**
   * How many jobs this helper runs at once. The server counts its running jobs
   * against this to know whether the machine has a free slot right now.
   */
  capacity: z.number().int().positive().default(1),
  /**
   * How many cloud jobs (runsInCloud) this helper runs at once, on top of
   * capacity: they wait on a cloud and don't take a local slot. Omitted by older
   * helpers, whose cloud jobs count against capacity.
   */
  cloudCapacity: z.number().int().nonnegative().optional(),
});
export type NodeHeartbeat = z.infer<typeof NodeHeartbeat>;

export const NodeHeartbeatResponse = z.object({
  nodeId: z.string().uuid(),
  serverTime: IsoTime,
  usageIntervalSec: z.number().int().positive(),
  heartbeatIntervalSec: z.number().int().positive(),
  /** The person pressed "Check now": read subscription usage right away. */
  checkUsageNow: z.boolean().default(false),
});
export type NodeHeartbeatResponse = z.infer<typeof NodeHeartbeatResponse>;
