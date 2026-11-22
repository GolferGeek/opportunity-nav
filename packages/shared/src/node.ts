import { z } from "zod";
import { IsoTime, Location, ProviderId } from "./common.ts";

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
  /** Jobs this node currently holds leases on, so the server can expire the rest. */
  activeJobIds: z.array(z.string().uuid()).default([]),
});
export type NodeHeartbeat = z.infer<typeof NodeHeartbeat>;

export const NodeHeartbeatResponse = z.object({
  nodeId: z.string().uuid(),
  serverTime: IsoTime,
  usageIntervalSec: z.number().int().positive(),
  heartbeatIntervalSec: z.number().int().positive(),
});
export type NodeHeartbeatResponse = z.infer<typeof NodeHeartbeatResponse>;
