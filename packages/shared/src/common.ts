import { z } from "zod";

/** Every kind of worker or subscription the app knows how to talk to. New providers add an id here and an adapter in apps/node. */
export const ProviderId = z.enum([
  "claude",
  "codex",
  "gemini",
  "agy",
  "cursor",
  "grokbot",
  "grok",
  "ollama",
  "mlx",
]);
export type ProviderId = z.infer<typeof ProviderId>;

/** Where a job's model runs. */
export const Location = z.enum(["local", "cloud"]);
export type Location = z.infer<typeof Location>;

/**
 * What runs a job's agent. direct = the node starts the provider's CLI itself
 * in a worktree on that machine. cloudroom = the node hands the job to
 * Cloudroom (cloudroom.dev), which runs the same CLI in its own cloud sandbox
 * on the person's own subscription, starting from the repo's GitHub default
 * branch and pushing the work to a branch.
 */
export const Runner = z.enum(["direct", "cloudroom"]);
export type Runner = z.infer<typeof Runner>;

export const Id = z.string().uuid();
export const IsoTime = z.string().datetime({ offset: true });

/** Plain-words status for anything that may fail to refresh. A failed poll never reads as zero use. */
export const CollectionStatus = z.enum([
  "ok", // fresh answer
  "stale", // last good answer kept; see message for why
  "auth_required", // a person must sign in again
  "unavailable", // provider exposes no usage for this plan (e.g. API key)
  "error", // never had a good answer; see message
]);
export type CollectionStatus = z.infer<typeof CollectionStatus>;
