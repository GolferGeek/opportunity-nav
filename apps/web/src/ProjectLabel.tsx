import { projectLabel } from "./labels.ts";

/** A quiet link to the project a piece of work belongs to. Renders nothing without a project. */
export function ProjectLabel({ projectId, path, onSelect }: {
  projectId: string | null | undefined;
  path: readonly string[] | null | undefined;
  onSelect: (id: string) => void;
}) {
  const label = projectLabel(projectId, path);
  if (!label) return null;
  return (
    <button type="button" className="link project-label" title="Open this project"
      onClick={(e) => { e.stopPropagation(); onSelect(projectId!); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); }}>
      {label}
    </button>
  );
}
