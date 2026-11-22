import { z } from "zod";
import { IsoTime } from "./common.ts";

/**
 * Work the app didn't start but should show: handoff-watcher tasks on the
 * Studio, GitHub issues, Cursor cloud agents. Nodes upsert these; the server
 * maps them to projects by repo path or remote.
 */
export const ExternalWork = z.object({
  source: z.enum(["handoff", "github_issue", "cursor_agent"]),
  /** Unique within source, e.g. the handoff file name or "owner/repo#12". */
  externalId: z.string(),
  title: z.string(),
  status: z.enum(["queued", "running", "waiting", "succeeded", "failed", "cancelled", "open", "closed"]),
  /** Local repo path (handoff) or normalised remote (issues). */
  repo: z.string().optional(),
  url: z.string().url().optional(),
  /** Short plain-words summary, e.g. the DONE line. */
  summary: z.string().optional(),
  /** Questions for the person found in the report, one per item. */
  questions: z.array(z.string()).default([]),
  updatedAt: IsoTime,
});
export type ExternalWork = z.infer<typeof ExternalWork>;

export const ExternalWorkReport = z.object({
  items: z.array(ExternalWork),
  /** When true, items of these sources from this node not in `items` are marked gone. */
  complete: z.array(z.enum(["handoff", "github_issue", "cursor_agent"])).default([]),
});
export type ExternalWorkReport = z.infer<typeof ExternalWorkReport>;
