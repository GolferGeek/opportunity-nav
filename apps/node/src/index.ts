import { access } from "node:fs/promises";
import { arch, hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { ClaimResponse, DEFAULT_HEARTBEAT_INTERVAL_SEC, DEFAULT_USAGE_INTERVAL_SEC, ExternalWorkReport,
  NODE, NodeHeartbeat, NodeHeartbeatResponse } from "@opnav/shared";
import type { ProviderCapability } from "@opnav/shared";
import { nodeApi } from "./api.ts";
import { capabilities, checkouts, machineTools } from "./capabilities.ts";
import { claudeCloudDetector, runClaudeCloud } from "./claudecloud.ts";
import { cloudroomDetector, runCloudroom } from "./cloudroom.ts";
import { handoffReport } from "./handoff.ts";
import { runTurn } from "./lease.ts";
import { localPath, system } from "./system.ts";
import type { System } from "./system.ts";
import { ollamaModels, runOllama } from "./ollama.ts";
import { runWorker } from "./worker.ts";
import type { Autonomy } from "./worker.ts";
import { createUsageCollector } from "./usage/index.ts";
import { helperVersion } from "./version.ts";

export interface StartNodeOptions {
  serverUrl: string;
  token: string;
  name?: string;
  autonomy?: Autonomy;
  checkoutRoots?: string[];
  checkoutDepth?: number;
  handoffDir?: string | false;
  claimIntervalMs?: number;
  /** Jobs this helper runs at once, each in its own worktree. Default OPNAV_CAPACITY, else 3. */
  capacity?: number;
  externalIntervalMs?: number;
  onStatus?: (message: string) => void;
  fetch?: typeof fetch;
  system?: Partial<System>;
}

export function startNode(options: StartNodeOptions): { stop(): Promise<void> } {
  if (!options.token.trim()) throw new Error("Set a node token.");
  const sys = system(options.system);
  const autonomy = (options.autonomy ?? sys.env.OPNAV_WORKER_AUTONOMY) === "full" ? "full" : "edit";
  const controller = new AbortController();
  const { signal } = controller;
  const transport = options.fetch ?? fetch;
  function report(message: string) {
    try {
      options.onStatus?.(message);
    } catch {
      // A status listener must not stop the helper.
    }
  }
  const post = nodeApi(options.serverUrl, options.token, transport, signal, () => {
    if (!signal.aborted) report("The node token was revoked.");
    controller.abort();
  });
  const collect = createUsageCollector({ sys, fetch: transport, signal });
  const detectCloudroom = cloudroomDetector(sys);
  const detectClaudeCloud = claudeCloudDetector(sys);
  const version = helperVersion(sys);
  let time = { heartbeatIntervalSec: DEFAULT_HEARTBEAT_INTERVAL_SEC, usageIntervalSec: DEFAULT_USAGE_INTERVAL_SEC };
  let registered = false;
  // "Check now" from the dashboard wakes the usage loop early.
  let usageWake = new AbortController();
  let providers: ProviderCapability[] = [];
  const capacity = jobCapacity(options.capacity ?? sys.env.OPNAV_CAPACITY);
  // The turns running now, by job. Each has its own lease, worktree, events and cancel; nothing else is shared.
  const running = new Map<string, Promise<void>>();
  let handoff: string | undefined;
  const handoffBriefs = new Map<string, string>();
  const configured = options.handoffDir === false ? undefined : localPath(sys, options.handoffDir ?? "~/Work/handoff");
  const roots = options.checkoutRoots ?? ["~/Projects", "~/projects"];
  const wait = (ms: number) => sleep(ms, undefined, { signal }).catch(() => {});
  async function loop(label: string, operation: () => Promise<number>, fallback: number, wake?: () => AbortSignal) {
    let failed = false;
    while (!signal.aborted) {
      let interval = fallback;
      try {
        interval = await operation();
        failed = false;
      } catch {
        if (!signal.aborted && !failed) report(`Could not ${label}. Retrying.`);
        failed = true;
      }
      if (wake) {
        const early = wake();
        await sleep(interval, undefined, { signal: AbortSignal.any([signal, early]) }).catch(() => {});
        if (early.aborted) usageWake = new AbortController();
      } else {
        await wait(interval);
      }
    }
  }

  const tasks = [
    loop("send a heartbeat", async () => {
      handoff = configured && await access(configured).then(() => configured, () => undefined);
      const [detected, discovered, models, cloudroom, tools, claudeCloud] = await Promise.all([
        capabilities(sys), checkouts(sys, roots, options.checkoutDepth ?? 4), ollamaModels(sys, transport, signal), detectCloudroom(),
        machineTools(sys), detectClaudeCloud(),
      ]);
      if (models.length) detected.push({
        provider: "ollama", canRunJobs: true, signedIn: true, locations: ["local"], models,
      });
      const payload = NodeHeartbeat.parse({ hostname: hostname(), name: options.name, platform: sys.platform,
        arch: arch(), autonomy, helperVersion: await version, providers: detected, checkouts: discovered,
        cloudroom: cloudroom && { providers: cloudroom.providers }, tools,
        claudeCloud: claudeCloud.ready ? { ready: true } : { ready: false, reason: claudeCloud.reason },
        handoff: handoff ? { dir: handoff } : undefined, activeJobIds: [...running.keys()], capacity });
      const answer = NodeHeartbeatResponse.parse(await post(NODE.heartbeat, payload));
      time = answer;
      if (answer.checkUsageNow) usageWake.abort();
      providers = detected;
      registered = true;
      return time.heartbeatIntervalSec * 1000;
    }, 5000),
    loop("upload subscription usage", async () => {
      if (!registered) return 250;
      const { report: usage, retry } = await collect();
      if (usage.accounts.length) await post(NODE.usage, usage);
      return retry ? Math.min(time.usageIntervalSec * 1000, 60_000) : time.usageIntervalSec * 1000;
    }, 10_000, () => usageWake.signal),
    loop("upload handoff work", async () => {
      if (!registered) return 250;
      if (!handoff) return options.externalIntervalMs ?? 60_000;
      const external = ExternalWorkReport.parse(await handoffReport(sys, handoff, handoffBriefs));
      await post(NODE.external, external);
      return options.externalIntervalMs ?? (external.items.some(item => item.status === "running") ? 10_000 : 60_000);
    }, 5000),
    loop("claim work", async () => {
      const interval = options.claimIntervalMs ?? 3000;
      if (!registered) return 250;
      const available = new Map(providers.filter(p => p.canRunJobs && p.signedIn).map(p => [p.provider, p]));
      const cloudroom = await detectCloudroom();
      const cloudroomProviders = cloudroom?.providers ?? [];
      // Claude's cloud needs only the routine file: the runner doesn't use the Claude CLI.
      const claudeCloud = await detectClaudeCloud();
      if (!available.size && !cloudroomProviders.length && !claudeCloud.ready) return interval;
      const free = capacity - running.size;
      if (free <= 0) return interval;
      const { turns } = ClaimResponse.parse(await post(NODE.claim, {
        providers: [...available.keys()], cloudroomProviders, claudeCloud: claudeCloud.ready, max: free,
      }));
      for (const turn of turns) {
        if (running.has(turn.job.id) || running.size >= capacity) continue;
        const provider = available.get(turn.job.provider);
        const cloud = turn.job.runner === "cloudroom";
        const routine = turn.job.runner === "claude-cloud" && claudeCloud.ready ? claudeCloud.config : undefined;
        // A turn this machine can't run is left alone; its lease runs out and it goes back in the queue.
        if (!(turn.job.runner === "claude-cloud" ? routine : cloud ? cloudroom?.providers.includes(turn.job.provider) : provider)) continue;
        const run = runTurn(post, turn, signal, report, async (lifetime, emit) => {
          if (routine) return runClaudeCloud(sys, routine, turn, lifetime, emit, { fetch: transport });
          if (cloud) return runCloudroom(sys, cloudroom!.binary, turn, lifetime, emit,
            { email: cloudroom!.email, defaultModel: cloudroom!.models[turn.job.provider] });
          if (!provider!.locations.includes(turn.job.location)) {
            return { type: "error", code: "provider_error", message: "The worker does not support this location.", retryable: false };
          }
          return provider!.provider === "ollama"
            ? runOllama(sys, transport, provider!.models, turn, lifetime)
            : runWorker(sys, provider!.cliPath!, turn, lifetime, emit, autonomy);
        }).catch(() => {
          if (!signal.aborted) report("A job stopped unexpectedly.");
        }).finally(() => running.delete(turn.job.id));
        running.set(turn.job.id, run);
      }
      return interval;
    }, 5000),
  ];
  return { async stop() {
    controller.abort();
    await Promise.all(tasks);
    await Promise.all(running.values());
  } };
}

export const DEFAULT_CAPACITY = 3;
const MAX_CAPACITY = 16;

/** How many jobs to run at once: a whole number from 1 to 16, else the default. */
export function jobCapacity(value: number | string | undefined): number {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_CAPACITY) : DEFAULT_CAPACITY;
}

export async function readUsage(options: Pick<StartNodeOptions, "system" | "fetch"> = {}) {
  const collect = createUsageCollector({ sys: system(options.system), fetch: options.fetch ?? fetch });
  return (await collect()).report;
}
