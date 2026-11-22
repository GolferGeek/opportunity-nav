import { useEffect, useRef } from "react";
import { ago, usePoll } from "./api.ts";

const SOURCE: Record<string, string> = { handoff: "Handoff task", github_issue: "Issue", cursor_agent: "Cloud agent" };

/** Live view of work the app didn't start (a handoff task, an issue, a cloud agent). */
export function ExternalPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: w, error } = usePoll<any>(`/api/external/${id}`, 3000);
  const live = w && ["queued", "running", "waiting"].includes(w.status);
  const activity: { at?: string; text: string }[] = w?.detail?.activity ?? [];
  return (
    <aside className="drawer" role="dialog" aria-label="Work">
      <div className="drawer-head">
        <h2>{w?.title ?? "Work"}</h2>
        <span className="spacer" />
        <button onClick={onClose} aria-label="Close">✕</button>
      </div>
      {error && <p className="muted">{error}</p>}
      {!w ? !error && <p className="muted">Loading…</p> : (
        <>
          <div className="facts muted">
            <span className={`dot ${w.status}`} /> {SOURCE[w.source] ?? w.source} · {w.status}
            {w.machine ? ` · ${w.machine}` : ""}{w.startedAt ? ` · started ${ago(w.startedAt)}` : ""} · updated {ago(w.updatedAt)}
            {w.url && <a href={w.url} target="_blank" rel="noreferrer">Open</a>}
          </div>
          {w.repo && <div className="muted small">{w.repo}</div>}
          {w.summary && (<><h4>Summary</h4><p className="plain">{w.summary}</p></>)}
          {w.questions.length > 0 && (
            <>
              <h4>Questions</h4>
              {w.questions.map((q: any) => (
                <div key={q.id} className="qa"><div>{q.body}</div><div className="muted">{q.answer ? `You: ${q.answer}` : q.status}</div></div>
              ))}
            </>
          )}
          <h4>{live ? "What it's doing" : "What it did"}</h4>
          <Activity lines={activity} live={!!live} empty={live ? "No activity reported yet." : "No activity was recorded."} />
          {w.detail?.brief && (<><h4>Asked</h4><pre className="prompt">{w.detail.brief}</pre></>)}
          {w.detail?.report && (<><h4>Report</h4><pre className="prompt">{w.detail.report}</pre></>)}
        </>
      )}
    </aside>
  );
}

/** A log that stays pinned to the newest line while you're at the bottom. */
export function Activity({ lines, live, empty }: { lines: { at?: string; text: string }[]; live: boolean; empty: string }) {
  const box = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  if (lines.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ol className={`activity ${live ? "live" : ""}`} ref={box}
      onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
      {lines.map((l, i) => (
        <li key={i}>{l.at && <span className="muted">{new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>} {l.text}</li>
      ))}
    </ol>
  );
}
