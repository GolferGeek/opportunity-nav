import { access } from "node:fs/promises";
import { arch, hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { ClaimResponse, DEFAULT_HEARTBEAT_INTERVAL_SEC, DEFAULT_USAGE_INTERVAL_SEC, ExternalWorkReport,
  NODE, NodeHeartbeat, NodeHeartbeatResponse } from "@opnav/shared";
import type { ProviderCapability } from "@opnav/shared";
import { nodeApi } from "./api.ts";
import { capabilities, checkouts } from "./capabilities.ts";
import { handoffReport } from "./handoff.ts";
import { runTurn } from "./lease.ts";
import { localPath, system } from "./system.ts";
import type { System } from "./system.ts";
import { ollamaModels, runOllama } from "./ollama.ts";
import { runWorker } from "./worker.ts";
import type { Autonomy } from "./worker.ts";
import { createUsageCollector } from "./usage/index.ts";

const version = "0.1.0";

export interface StartNodeOptions {
  serverUrl: string;
  token: string;
  name?: string;
  autonomy?: Autonomy;
  checkoutRoots?: string[];
  checkoutDepth?: number;
  handoffDir?: string | false;
  claimIntervalMs?: number;
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
  let time = { heartbeatIntervalSec: DEFAULT_HEARTBEAT_INTERVAL_SEC, usageIntervalSec: DEFAULT_USAGE_INTERVAL_SEC };
  let registered = false;
  let providers: ProviderCapability[] = [];
  let activeJobId: string | undefined;
  let handoff: string | undefined;
  const handoffBriefs = new Map<string, string>();
  const configured = options.handoffDir === false ? undefined : localPath(sys, options.handoffDir ?? "~/Work/handoff");
  const roots = options.checkoutRoots ?? ["~/Projects", "~/projects"];
  const wait = (ms: number) => sleep(ms, undefined, { signal }).catch(() => {});
  async function loop(label: string, operation: () => Promise<number>, fallback: number) {
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
      await wait(interval);
    }
  }

  const tasks = [
    loop("send a heartbeat", async () => {
      handoff = configured && await access(configured).then(() => configured, () => undefined);
      const [detected, discovered, models] = await Promise.all([
        capabilities(sys), checkouts(sys, roots, options.checkoutDepth ?? 4), ollamaModels(sys, transport, signal),
      ]);
      if (models.length) detected.push({
        provider: "ollama", canRunJobs: true, signedIn: true, locations: ["local"], models,
      });
      const payload = NodeHeartbeat.parse({ hostname: hostname(), name: options.name, platform: sys.platform,
        arch: arch(), autonomy, helperVersion: version, providers: detected, checkouts: discovered,
        handoff: handoff ? { dir: handoff } : undefined, activeJobIds: activeJobId ? [activeJobId] : [] });
      time = NodeHeartbeatResponse.parse(await post(NODE.heartbeat, payload));
      providers = detected;
      registered = true;
      return time.heartbeatIntervalSec * 1000;
    }, 5000),
    loop("upload subscription usage", async () => {
      if (!registered) return 250;
      const { report: usage, retry } = await collect();
      if (usage.accounts.length) await post(NODE.usage, usage);
      return retry ? Math.min(time.usageIntervalSec * 1000, 60_000) : time.usageIntervalSec * 1000;
    }, 10_000),
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
      if (!available.size) return interval;
      const { turns } = ClaimResponse.parse(await post(NODE.claim, { providers: [...available.keys()], max: 1 }));
      const turn = turns[0];
      const provider = turn && available.get(turn.job.provider);
      if (turn && provider) {
        activeJobId = turn.job.id;
        try {
          await runTurn(post, turn, signal, report, async (lifetime, emit) => {
            if (!provider.locations.includes(turn.job.location)) {
              return { type: "error", code: "provider_error", message: "The worker does not support this location.", retryable: false };
            }
            return provider.provider === "ollama"
              ? runOllama(sys, transport, provider.models, turn, lifetime)
              : runWorker(sys, provider.cliPath!, turn, lifetime, emit, autonomy);
          });
        } finally {
          activeJobId = undefined;
        }
      }
      return interval;
    }, 5000),
  ];
  return { async stop() { controller.abort(); await Promise.all(tasks); } };
}

export async function readUsage(options: Pick<StartNodeOptions, "system" | "fetch"> = {}) {
  const collect = createUsageCollector({ sys: system(options.system), fetch: options.fetch ?? fetch });
  return (await collect()).report;
}
