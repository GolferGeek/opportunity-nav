import { useState } from "react";
import { ago, api, providerName, until } from "./api.ts";

export interface Dash {
  totalMonthlyUsd: number;
  subscriptions: {
    id: string;
    provider: string;
    label: string | null;
    plan: string | null;
    status: string;
    message: string | null;
    fetchedAt: string | null;
    monthlyCostUsd: number | null;
    windows: { id: string; label: string; unit: string; used: number; limit: number | null; percent: number | null; resetsAt: string | null; hasReset: boolean; kind: string }[];
  }[];
  projects: { id: string; path: string[]; line: string; active: number; questions: number; roadblocks: number }[];
}

const STATUS_TEXT: Record<string, string> = {
  stale: "Not current",
  auth_required: "Sign in again",
  unavailable: "No limits to show",
  error: "Couldn't check",
};

export function Dashboard({ dash, onChanged, onSelect, onError }: { dash: Dash | null; onChanged: () => void; onSelect: (id: string) => void; onError: (m: string) => void }) {
  if (!dash) return <section className="pane"><h2>Dashboard</h2><p className="muted">Loading…</p></section>;
  return (
    <section className="pane">
      <h2>Dashboard</h2>
      <h4>Subscriptions {dash.totalMonthlyUsd > 0 && <span className="muted"> · ${dash.totalMonthlyUsd.toFixed(0)}/month</span>}</h4>
      {dash.subscriptions.length === 0 && (
        <p className="muted">No subscriptions yet.<br />Connect a machine in Settings and its agents appear here.</p>
      )}
      <div className="subs">
        {dash.subscriptions.map((s) => (
          <div key={s.id} className={`card sub status-${s.status}`}>
            <div className="sub-head">
              <strong>{providerName(s.provider)}</strong>
              <span className="muted">{[s.plan, s.label].filter(Boolean).join(" · ")}</span>
              <Cost id={s.id} value={s.monthlyCostUsd} onChanged={onChanged} onError={onError} />
            </div>
            {s.status !== "ok" && (
              <div className="sub-status" title={s.message ?? undefined}>
                {STATUS_TEXT[s.status] ?? s.status}{s.message ? `: ${s.message}` : ""}
              </div>
            )}
            {s.windows.map((w) => {
              const pct = w.percent == null ? null : Math.min(100, Math.max(0, w.percent));
              return (
                <div key={w.id} className="meter" title={`${pct == null ? `${w.used} ${w.unit}` : `${pct.toFixed(1)}% used`}${s.fetchedAt ? ` · checked ${ago(s.fetchedAt)}` : ""}`}>
                  <span className="mlabel">{w.label}</span>
                  <span className="bar"><span className={`fill ${pct != null && pct >= 90 ? "hot" : pct != null && pct >= 70 ? "warm" : ""}`} style={{ width: `${pct ?? 0}%` }} /></span>
                  <span className="mval">{pct == null ? `${w.used}${w.limit ? ` / ${w.limit}` : ""}` : `${Math.round(pct)}%`}</span>
                  <span className="mreset muted">{w.hasReset ? "reset" : w.resetsAt ? `resets ${until(w.resetsAt)}` : ""}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <h4>Projects</h4>
      {dash.projects.length === 0 && <p className="muted">No projects yet.</p>}
      <ul className="project-lines">
        {dash.projects.map((p) => (
          <li key={p.id}>
            <button className="link" onClick={() => onSelect(p.id)}>{p.path.at(-1)}</button>
            <span className={`muted ${p.questions || p.roadblocks ? "needs" : ""}`}>{p.line}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Cost({ id, value, onChanged, onError }: { id: string; value: number | null; onChanged: () => void; onError: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value?.toString() ?? "");
  if (!editing)
    return (
      <button className="cost quietbtn" title="Monthly cost" onClick={() => setEditing(true)}>
        {value != null ? `$${value}/mo` : "Add cost"}
      </button>
    );
  const save = async () => {
    setEditing(false);
    const n = v.trim() === "" ? null : Number(v);
    if (n !== null && !Number.isFinite(n)) return;
    try {
      await api("PATCH", `/api/subscriptions/${id}`, { monthlyCostUsd: n });
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <input className="cost-input" autoFocus inputMode="decimal" value={v} placeholder="$/month" onChange={(e) => setV(e.target.value)}
      onBlur={() => void save()} onKeyDown={(e) => e.key === "Enter" && void save()} />
  );
}
