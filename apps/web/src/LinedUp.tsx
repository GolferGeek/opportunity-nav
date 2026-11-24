import { useState } from "react";
import { ago, api, providerName, runsOnText, usePoll, type RunsOn } from "./api.ts";
import { queueCounts, queueLow, queueNote } from "./labels.ts";

interface Next {
  id: string;
  title: string;
  app: string;
  provider: string;
  machine: string | null;
  runsOn?: RunsOn;
  held: boolean;
  ready: boolean;
  why: string | null;
  canRunOn: string[];
  backlog: boolean;
  resuming: boolean;
}
export interface Lined {
  running: { id: string; title: string; app: string; provider: string; machine: string | null; runsOn?: RunsOn; startedAt: string | null }[];
  next: Next[];
  total: { waiting: number; ready: number; held: number; running: number };
  perApp: { app: string; running: number; ready: number; waiting: number; held: number }[];
  perMachine: { name: string; takingJobs: boolean; slots: number; running: number; free: number; cloudSlots: number | null; cloudRunning: number; canTake: number }[];
  runningLow: { low: boolean; ready: number; slots: number; text: string };
}

/**
 * The backlog, quietly, titled "Waiting to start" so it reads as the queue,
 * not as a second running list (running jobs show under What's happening).
 * One line saying what it is, one of counts, and the next few in line. Everything
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
  // With only running jobs there's no queue to show or act on: just the counts line.
  const queued = total.waiting + total.held;
  const open = all && queued > 0;
  const note = queueNote(total);
  return (
    <div className="lined-up">
      <h4 className="row-head">
        <span>Waiting to start</span>
        <span className="spacer" />
        {queued > 0 && <button className="quietbtn" onClick={() => setAll(!all)}>{all ? "Show less" : `Show all (${queued})`}</button>}
      </h4>
      {note && <div className="muted small">{note}</div>}
      <div className="muted small">{queueCounts(total)}</div>
      {queueLow(runningLow) && <div className="low small">{queueLow(runningLow)}</div>}
      <ol className="next">
        {data.next.map((n) => (
          <li key={n.id} className={n.held ? "held" : n.ready ? "" : "blocked"}>
            <button className="link" onClick={() => onOpenJob(n.id)}>{n.title}</button>
            <div className="muted small">
              {n.app} · {providerName(n.provider)}{n.runsOn ? ` · ${runsOnText(n.runsOn)}` : n.machine ? ` · ${n.machine}` : ""}
              {n.held ? " · on hold" : n.ready ? "" : n.why ? ` · ${n.why}` : ""}
            </div>
            {open && n.backlog && !n.resuming && (
              <div className="row-buttons small">
                <button className="quietbtn" disabled={busy} onClick={() => void update(n.id, { held: !n.held })}>{n.held ? "Let go" : "Hold"}</button>
                <button className="quietbtn" disabled={busy} onClick={() => void update(n.id, { top: true })}>Top of {n.app}</button>
                <button className="quietbtn" disabled={busy} onClick={() => void act("cancel_job", { jobId: n.id })}>Drop</button>
              </div>
            )}
          </li>
        ))}
      </ol>
      {open && (
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
              <li key={m.name}>{m.name}: {m.cloudSlots == null ? `${m.running} of ${m.slots} running` : `local ${m.running} of ${m.slots} · cloud ${m.cloudRunning} of ${m.cloudSlots}`}{m.takingJobs ? "" : " · not taking jobs"} · {m.canTake} ready it can take</li>
            ))}
          </ul>
          {data.running.length > 0 && <div className="muted small">Running: {data.running.map((r) => `${r.title} (${r.runsOn ? runsOnText(r.runsOn) : r.machine ?? "?"}, ${ago(r.startedAt)})`).join(" · ")}</div>}
        </>
      )}
    </div>
  );
}
