import { useEffect, useRef, useState } from "react";
import { ago, api, providerName, until } from "./api.ts";
import { readingClass, readingNote } from "./labels.ts";

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
    /** False when the last check failed, it needs a sign-in, or it's over 30 minutes old. */
    current: boolean;
    monthlyCostUsd: number | null;
    windows: { id: string; label: string; unit: string; used: number; limit: number | null; percent: number | null; resetsAt: string | null; hasReset: boolean; kind: string }[];
  }[];
  projects: { id: string; path: string[]; priority: string; line: string; active: number; questions: number; roadblocks: number }[];
}

export function Dashboard({ dash, onChanged, onSelect, onOpenSub, onError }: { dash: Dash | null; onChanged: () => void; onSelect: (id: string) => void; onOpenSub: (id: string) => void; onError: (m: string) => void }) {
  if (!dash) return <section className="pane"><h2>Dashboard</h2><p className="muted">Loading…</p></section>;
  return (
    <section className="pane">
      <h2>Dashboard</h2>
      <h4 className="row-head">
        <span>Subscriptions {dash.totalMonthlyUsd > 0 && <span className="muted"> · ${dash.totalMonthlyUsd.toFixed(0)}/month</span>}</span>
        <span className="spacer" />
        <CheckNow newest={newestCheck(dash.subscriptions)} onChanged={onChanged} onError={onError} />
      </h4>
      {dash.subscriptions.length === 0 && (
        <p className="muted">No subscriptions yet.<br />Connect a machine in Settings and its agents appear here.</p>
      )}
      <div className="subs">
        {dash.subscriptions.map((s) => (
          <div key={s.id} className={`card sub clickable ${readingClass(s)}`} role="button" tabIndex={0}
            onClick={(e) => { if (!(e.target as HTMLElement).closest(".cost, .cost-input")) onOpenSub(s.id); }}
            onKeyDown={(e) => e.key === "Enter" && onOpenSub(s.id)}>
            <div className="sub-head">
              <strong>{providerName(s.provider)}</strong>
              <span className="muted">{[s.plan, s.label].filter(Boolean).join(" · ")}</span>
              <Cost id={s.id} value={s.monthlyCostUsd} onChanged={onChanged} onError={onError} />
            </div>
            {readingNote(s) && <div className="sub-status" title={s.message ?? undefined}>{readingNote(s)}</div>}
            {s.windows.filter((w) => w.unit !== "tokens").map((w) => {
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

/** The most recent time any subscription was read. */
export function newestCheck(subs: { fetchedAt: string | null }[]): string | null {
  return subs.reduce<string | null>((a, s) => (s.fetchedAt && (!a || s.fetchedAt > a) ? s.fetchedAt : a), null);
}

/**
 * Usage is read every 5 minutes. "Check now" asks every online machine to read
 * it at its next heartbeat (within about 30 seconds) and refreshes until it lands.
 */
export function CheckNow({ newest, onChanged, onError }: { newest: string | null; onChanged: () => void; onError: (m: string) => void }) {
  const [since, setSince] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);
  const stop = () => { clearInterval(timer.current); timer.current = undefined; setSince(null); };
  useEffect(() => { if (since && newest && newest > since) stop(); }, [newest, since]);
  useEffect(() => () => clearInterval(timer.current), []);
  const go = async () => {
    try {
      const r = await api<{ machines: number; requestedAt: string }>("POST", "/api/usage/check");
      if (r.machines === 0) return onError("No machine is online to check usage.");
      setSince(r.requestedAt);
      const started = Date.now();
      clearInterval(timer.current);
      timer.current = setInterval(() => {
        if (Date.now() - started > 90_000) stop();
        else onChanged();
      }, 3000);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <span className="check-now muted small">
      {newest ? `checked ${ago(newest)} · ` : ""}
      <button type="button" className="quietbtn" disabled={!!since} onClick={(e) => { e.stopPropagation(); void go(); }}
        title="Usage is read every 5 minutes. This reads it now.">{since ? "Checking…" : "Check now"}</button>
    </span>
  );
}
