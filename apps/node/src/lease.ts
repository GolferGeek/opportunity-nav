import { setTimeout as sleep } from "node:timers/promises";
import { LeaseRenewResponse, NODE, TerminalEventTypes } from "@opnav/shared";
import type { JobEvent, Turn } from "@opnav/shared";
import { ApiError } from "./api.ts";
import type { Post } from "./api.ts";
import { object } from "./system.ts";
import type { EventContent, Terminal } from "./worker.ts";

const terminalTypes = new Set<string>(TerminalEventTypes);

export async function runTurn(post: Post, turn: Turn, signal: AbortSignal,
  report: (message: string) => void, run: (signal: AbortSignal, emit: (event: EventContent) => void) => Promise<Terminal>) {
  const lease = new AbortController();
  const worker = new AbortController();
  const lifetime = AbortSignal.any([signal, lease.signal]);
  const workerLifetime = AbortSignal.any([lifetime, worker.signal]);
  const jobs = turn.job.id;
  let deadline = Date.parse(turn.leaseExpiresAt);
  let expiry: ReturnType<typeof setTimeout>;
  let cancelled = false;
  let seq = 0;
  const queue: JobEvent[] = [];
  const delay = (ms: number) => sleep(ms, undefined, { signal: lifetime }).catch(() => {});
  const expire = () => lease.abort();
  function scheduleExpiry() {
    clearTimeout(expiry);
    expiry = setTimeout(expire, Math.max(0, deadline - Date.now()));
  }
  function emit(event: EventContent) {
    if (!lifetime.aborted) queue.push({ ...event, seq: seq++, at: new Date().toISOString() });
  }
  function lost(error: unknown) {
    if (error instanceof ApiError && [401, 404, 409].includes(error.status)) expire();
  }

  if (deadline <= Date.now() || signal.aborted) return;
  scheduleExpiry();
  const renew = (async () => {
    let interval = Math.max(100, (deadline - Date.now()) / 3);
    while (!lifetime.aborted) {
      await delay(interval);
      if (lifetime.aborted) return;
      try {
        const updated = LeaseRenewResponse.parse(await post(NODE.lease(jobs), { leaseId: turn.leaseId }, lifetime));
        if (lifetime.aborted) return;
        deadline = Date.parse(updated.leaseExpiresAt);
        if (deadline <= Date.now() && !updated.cancel) return expire();
        if (updated.cancel) {
          cancelled = true;
          worker.abort();
          // Allow one final delivery even if the cancellation response used the old expiry.
          deadline = Math.max(deadline, Date.now() + 5000);
          scheduleExpiry();
          return;
        }
        scheduleExpiry();
        interval = Math.max(100, (deadline - Date.now()) / 3);
      } catch (error) {
        lost(error);
        interval = 500;
      }
    }
  })();
  const work = run(workerLifetime, emit).catch((): EventContent => ({
    type: "error", code: "worker_crashed", message: "The worker could not start.", retryable: false,
  })).then(emit);
  let retry = 250;
  let pending: JobEvent[] = [];
  try {
    while (!lifetime.aborted) {
      if (!queue.length) {
        await delay(100);
        continue;
      }
      if (cancelled && !pending.length) {
        const index = queue.findIndex(event => terminalTypes.has(event.type));
        const previous = queue[index];
        if (previous) queue[index] = { type: "error", code: "cancelled", message: "The turn was cancelled.",
          retryable: false, seq: previous.seq, at: previous.at };
      }
      if (!pending.length) pending = queue.slice(0, 50);
      const events = pending;
      try {
        const ack = object(await post(NODE.events(jobs), { leaseId: turn.leaseId, events }, lifetime)).lastSeq;
        if (typeof ack !== "number" || !Number.isSafeInteger(ack) || ack < events[0]!.seq) {
          throw new Error("Events were not acknowledged");
        }
        const delivered = events.filter(event => event.seq <= ack);
        if (delivered.some(event => terminalTypes.has(event.type))) return;
        queue.splice(0, delivered.length);
        pending = events.slice(delivered.length);
        retry = 250;
      } catch (error) {
        lost(error);
        if (lifetime.aborted) break;
        await delay(retry);
        retry = Math.min(retry * 2, 5000);
      }
    }
    if (!signal.aborted) report("The worker lease ended before the turn could be delivered.");
  } finally {
    expire();
    clearTimeout(expiry!);
    await Promise.all([renew, work]);
  }
}
