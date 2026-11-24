/**
 * The new-job form's one "Where it runs" choice: any machine (the default),
 * one machine by name, Claude's cloud or Cloudroom's cloud. Pure, so it's tested.
 */

/** "any", "machine:<id>", "claude-cloud" or "cloudroom". */
export type Where = string;
export const ANY_MACHINE: Where = "any";

export type WhereOption = { value: Where; label: string; disabled?: boolean };

/** The parts of GET /api/machines this reads. */
export type MachineLite = {
  id: string;
  name: string;
  online?: boolean;
  takingJobs?: boolean;
  providers?: { provider: string; signedIn?: boolean; canRunJobs?: boolean }[];
  cloudroom?: { providers?: string[] } | null;
  claudeCloud?: { ready?: boolean; repos?: string[] } | null;
};

const shortName = (name: string) => name.replace(/\.local$/i, "");

/** Whether this machine has the agent signed in and able to run jobs. */
export const runsAgent = (m: MachineLite, provider: string) =>
  (m.providers ?? []).some((p) => p.provider === provider && p.signedIn && p.canRunJobs);

/**
 * The choices for this agent and repo. A machine is listed when it's online and
 * taking jobs; it's greyed out when it can't run this agent. Claude's cloud shows
 * only when an online machine's routine covers the project's repo (an item has no
 * repo of its own, so it's the project's), and Cloudroom only when an online
 * machine has it; each is greyed out for an agent it can't run.
 */
export function whereOptions(machines: MachineLite[], provider: string, repo: string | null, providerLabel: (p: string) => string): WhereOption[] {
  const online = machines.filter((m) => m.online);
  const opts: WhereOption[] = [{ value: ANY_MACHINE, label: "Any machine" }];
  for (const m of online.filter((m) => m.takingJobs !== false)) {
    const can = runsAgent(m, provider);
    opts.push({ value: `machine:${m.id}`, label: `On ${shortName(m.name)}${can ? "" : ` (no ${providerLabel(provider)})`}`, disabled: !can });
  }
  if (claudeCloudCovers(online, repo)) {
    opts.push({ value: "claude-cloud", label: `In Claude's cloud${provider === "claude" ? "" : " (Claude only)"}`, disabled: provider !== "claude" });
  }
  const cloudroom = cloudroomProviders(online);
  if (cloudroom.length > 0) {
    const can = cloudroom.includes(provider);
    opts.push({ value: "cloudroom", label: `In Cloudroom's cloud${can ? "" : " (not for this agent)"}`, disabled: !can });
  }
  return opts;
}

/** Only a routine that covers the project's repo can run it (the server matches the same way). */
export const claudeCloudCovers = (online: MachineLite[], repo: string | null) =>
  repo !== null && online.some((m) => m.claudeCloud?.ready && (m.claudeCloud.repos ?? []).includes(repo));

export const cloudroomProviders = (online: MachineLite[]) =>
  [...new Set(online.filter((m) => m.cloudroom).flatMap((m) => m.cloudroom?.providers ?? []))];

/** The chosen value if it's still offered and enabled, else any machine (so a stale choice never sticks). */
export function keepWhere(where: Where, opts: WhereOption[]): Where {
  return opts.some((o) => o.value === where && !o.disabled) ? where : ANY_MACHINE;
}

/** What the choice sends with the new job: the runner, and a machine to pin it to. */
export function whereToJob(where: Where): { runner: "direct" | "cloudroom" | "claude-cloud"; machineId?: string } {
  if (where === "claude-cloud" || where === "cloudroom") return { runner: where };
  if (where.startsWith("machine:")) return { runner: "direct", machineId: where.slice("machine:".length) };
  return { runner: "direct" };
}
