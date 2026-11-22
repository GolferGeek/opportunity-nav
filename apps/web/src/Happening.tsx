import { useState } from "react";
import { ago, api, providerName } from "./api.ts";

export interface Item {
  kind: "question" | "roadblock" | "job" | "external";
  id: string;
  title: string;
  detail: string | null;
  status: string;
  at: string;
  startedAt?: string | null;
  jobId?: string | null;
  externalId?: string | null;
  options?: string[] | null;
  provider?: string;
  model?: string | null;
  machine?: string | null;
  url?: string | null;
  source?: string;
}
export interface Group {
  projectId: string | null;
  path: string[];
  items: Item[];
}

export function Happening({ groups, onChanged, onOpenJob, onOpenExternal, onSelect, onError }: {
  groups: Group[] | null;
  onChanged: () => void;
  onOpenJob: (id: string) => void;
  onOpenExternal: (id: string) => void;
  onSelect: (id: string) => void;
  onError: (m: string) => void;
}) {
  if (!groups) return <section className="pane"><h2>What's happening</h2><p className="muted">Loading…</p></section>;
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <section className="pane">
      <h2>What's happening {count > 0 && <span className="count">{count}</span>}</h2>
      {count === 0 && <p className="muted quiet">Nothing needs you right now.</p>}
      {groups.map((g) => (
        <div key={g.projectId ?? "none"} className="group">
          <h4>
            {g.projectId ? <button className="link" onClick={() => onSelect(g.projectId!)}>{g.path.join(" / ")}</button> : g.path.join(" / ")}
          </h4>
          {g.items.map((it) => (
            <Card key={`${it.kind}-${it.id}`} it={it} onChanged={onChanged} onOpenJob={onOpenJob} onOpenExternal={onOpenExternal} onError={onError} />
          ))}
        </div>
      ))}
    </section>
  );
}

function Card({ it, onChanged, onOpenJob, onOpenExternal, onError }: { it: Item; onChanged: () => void; onOpenJob: (id: string) => void; onOpenExternal: (id: string) => void; onError: (m: string) => void }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const send = (text: string) => text.trim() && run(() => api("POST", `/api/questions/${it.id}/answer`, { answer: text.trim() }));

  if (it.kind === "question")
    return (
      <div className="card question">
        <div className="tag">Question for you</div>
        <div className="body">{it.title}</div>
        {it.detail && <div className="detail">{it.detail}</div>}
        {it.options && it.options.length > 0 && (
          <div className="options">
            {it.options.map((o) => (
              <button key={o} disabled={busy} onClick={() => void send(o)}>{o}</button>
            ))}
          </div>
        )}
        <form className="answer" onSubmit={(e) => { e.preventDefault(); void send(answer); }}>
          <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer" rows={2}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(answer); }} />
          <div className="row-buttons">
            <button type="submit" className="primary" disabled={busy || !answer.trim()}>Answer</button>
            {it.jobId && <button type="button" onClick={() => onOpenJob(it.jobId!)}>See the job</button>}
            {it.externalId && <button type="button" onClick={() => onOpenExternal(it.externalId!)}>See the work</button>}
            <button type="button" className="quietbtn" disabled={busy} onClick={() => void run(() => api("POST", `/api/questions/${it.id}/dismiss`))}>Dismiss</button>
          </div>
        </form>
      </div>
    );

  if (it.kind === "roadblock")
    return (
      <div className="card roadblock">
        <div className="tag">Roadblock</div>
        <div className="body">{it.title}</div>
        {it.detail && <div className="detail">{it.detail}</div>}
        <div className="row-buttons">
          {it.jobId && <button onClick={() => onOpenJob(it.jobId!)}>See the job</button>}
          <button disabled={busy} onClick={() => void run(() => api("POST", `/api/roadblocks/${it.id}/clear`))}>Cleared</button>
        </div>
      </div>
    );

  if (it.kind === "job")
    return (
      <button className="card job clickable" onClick={() => onOpenJob(it.id)}>
        <div className="tag">
          <span className={`dot ${it.status}`} /> {it.status === "queued" ? "Waiting for a machine" : "Working"} · {providerName(it.provider ?? "")}
          {it.model ? ` · ${it.model}` : ""}{it.machine ? ` · ${it.machine}` : ""}
        </div>
        <div className="body">{it.title}</div>
        {it.detail && <div className="detail">{it.detail}</div>}
      </button>
    );

  return (
    <button className="card external clickable" onClick={() => onOpenExternal(it.id)}>
      <div className="tag">
        <span className={`dot ${it.status}`} /> {it.source === "handoff" ? "Handoff" : it.source === "github_issue" ? "Issue" : "Cloud agent"} · {it.status}
        {it.machine ? ` · ${it.machine}` : ""}
        {it.status === "running" && it.startedAt ? ` · started ${ago(it.startedAt)} · updated ${ago(it.at)}` : ` · ${ago(it.at)}`}
      </div>
      <div className="body">{it.title}</div>
      {it.detail && <div className="detail clip">{it.detail}</div>}
    </button>
  );
}
