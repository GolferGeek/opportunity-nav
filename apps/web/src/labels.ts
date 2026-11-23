/**
 * The short project name a handoff shows: its path below the top area,
 * e.g. ["Coding", "Orchestrator AI", "Agents Only"] → "Orchestrator AI / Agents Only".
 * Null when there's no project, so nothing is shown.
 */
export function projectLabel(projectId: string | null | undefined, path: readonly string[] | null | undefined): string | null {
  if (!projectId || !path) return null;
  const names = path.map((p) => p.trim()).filter(Boolean);
  if (names.length === 0) return null;
  return (names.length > 1 ? names.slice(1) : names).join(" / ");
}
