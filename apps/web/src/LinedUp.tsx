import { useState } from "react";
import { ago, api, providerName, usePoll } from "./api.ts";

interface Next {
  id: string;
  title: string;
  app: string;
  provider: string;
  machine: string | null;
  held: boolean;
  ready: boolean;
  why: string | null;
  canRunOn: string[];
  backlog: boolean;
  resuming: boolean;
}
export interface Lined {
  running: { id: string; title: string; app: string; provider: string; machine: string | null; startedAt: string | null }[];
  next: Next[];
  total: { waiting: number; ready: number; held: number; running: number };
  perApp: { app: string; running: number; ready: number; waiting: number; held: number }[];
  perMachine: { name: string; takingJobs: boolean; slots: number; running: number; free: number; canTake: number }[];
  runningLow: { low: boolean; ready: number; slots: number; text: string };
}

/**
 * The backlog, quietly: one summary line and the next few in line. Everything
 * else is one click away ("Show all"), where items can be held, let go, moved
 * to the top of their app, or dropped.
 */
export function LinedUp({ onOpenJob, onError }: { onOpenJob: (id: string) => void; onError: (m: string) => void }) {
  const [all, setAll] = useState(false);
  const { data, reload } = usePoll<Lined>(all ? "/api/lined-up?all=1" : "/api/lined-up?next=3", 10_000);
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const { total, runningLow } = data;
  if (total.running === 0 && total.waiting === 0 && total.held === 0) return null;
  const act = async (action: string, input: unknown) => {
    setBusy(true);
    try {
      await api("POST", "/api/act", { action, input });
      await reload();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const update = (jobId: string, changes: object) => act("update_backlog_item", { jobId, changes });
  return (
    <div className="lined-up">
      <h4 className="row-head">
        <span>Lined up</span>
        <span className="spacer" />
        <button className="quietbtn" onClick={() => setAll(!all)}>{all ? "Show less" : `Show all (${total.waiting + total.held})`}</button>
      </h4>
      <div className="muted small">
        {total.running} running · {total.waiting} waiting{total.held ? ` · ${total.held} on hold` : ""}
      </div>
      {runningLow.low && <div className="low small">{runningLow.text}</div>}
      <ol className="next">
        {data.next.map((n) => (
          <li key={n.id} className={n.held ? "held" : n.ready ? "" : "blocked"}>
            <button className="link" onClick={() => onOpenJob(n.id)}>{n.title}</button>
            <div className="muted small">
              {n.app} · {providerName(n.provider)}{n.machine ? ` · ${n.machine}` : ""}
              {n.held ? " · on hold" : n.ready ? "" : n.why ? ` · ${n.why}` : ""}
            </div>
            {all && n.backlog && !n.resuming && (
              <div className="row-buttons small">
                <button className="quietbtn" disabled={busy} onClick={() => void update(n.id, { held: !n.held })}>{n.held ? "Let go" : "Hold"}</button>
                <button className="quietbtn" disabled={busy} onClick={() => void update(n.id, { top: true })}>Top of {n.app}</button>
                <button className="quietbtn" disabled={busy} onClick={() => void act("cancel_job", { jobId: n.id })}>Drop</button>
              </div>
            )}
          </li>
        ))}
      </ol>
      {all && (
        <>
          <div className="muted small">Left per app</div>
          <ul className="plain small">
            {data.perApp.map((a) => (
              <li key={a.app}>{a.app}: {a.running} running · {a.ready + a.waiting} waiting{a.held ? ` · ${a.held} on hold` : ""}</li>
            ))}
          </ul>
          <div className="muted small">Machines</div>
          <ul className="plain small">
            {data.perMachine.map((m) => (
              <li key={m.name}>{m.name}: {m.running} of {m.slots} running{m.takingJobs ? "" : " · not taking jobs"} · {m.canTake} ready it can take</li>
            ))}
          </ul>
          {data.running.length > 0 && <div className="muted small">Running: {data.running.map((r) => `${r.title} (${r.machine ?? "?"}, ${ago(r.startedAt)})`).join(" · ")}</div>}
        </>
      )}
    </div>
  );
}
