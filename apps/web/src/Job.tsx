import { ago, api, providerName, usePoll } from "./api.ts";
import { Activity } from "./External.tsx";

export function JobPanel({ id, onClose, onChanged, onError }: { id: string; onClose: () => void; onChanged: () => void; onError: (m: string) => void }) {
  const { data: job, reload } = usePoll<any>(`/api/jobs/${id}`, 3000);
  const live = job && ["queued", "running", "waiting"].includes(job.status);
  return (
    <aside className="drawer" role="dialog" aria-label="Job">
      <div className="drawer-head">
        <h2>{job?.title ?? "Job"}</h2>
        <span className="spacer" />
        {live && (
          <button onClick={async () => {
            try { await api("POST", `/api/jobs/${id}/cancel`); await reload(); onChanged(); } catch (e) { onError((e as Error).message); }
          }}>Stop</button>
        )}
        <button onClick={onClose} aria-label="Close">✕</button>
      </div>
      {!job ? <p className="muted">Loading…</p> : (
        <>
          <div className="facts muted">
            <span className={`dot ${job.status}`} /> {job.status} · {providerName(job.provider)}{job.model ? ` · ${job.model}` : ""} · {job.location}
            {job.tokens && (job.tokens.input || job.tokens.output) ? ` · ${(job.tokens.input + job.tokens.output).toLocaleString()} tokens` : ""}
            {job.costUsd ? ` · $${job.costUsd.toFixed(2)}` : ""} · started by {job.createdBy} {ago(job.createdAt)}
          </div>
          {job.summary && (<><h4>{job.status === "failed" ? "What went wrong" : "Result"}</h4><pre className="prompt">{job.summary}</pre></>)}
          {job.questions.length > 0 && (
            <>
              <h4>Questions</h4>
              {job.questions.map((q: any) => (
                <div key={q.id} className="qa"><div>{q.body}</div><div className="muted">{q.answer ? `You: ${q.answer}` : q.status}</div></div>
              ))}
            </>
          )}
          <h4>{live ? "What it's doing" : "What it did"}</h4>
          <Activity live={!!live}
            lines={job.events.filter((e: any) => e.type !== "usage").map((e: any) => ({ at: e.at, text: describe(e) }))}
            empty={job.status === "queued" ? "Waiting for a machine that has this repo and agent." : "Nothing yet."} />
          <h4>Asked</h4>
          <pre className="prompt">{job.prompt}</pre>
        </>
      )}
    </aside>
  );
}

function describe(e: any): string {
  switch (e.type) {
    case "session": return "Session started";
    case "progress": return e.text;
    case "blocked": return `Blocked: ${e.text}`;
    case "needs_input": return `Asked you: ${e.needsInput.question}`;
    case "result": return "Finished";
    case "error": return `Stopped: ${e.message}`;
    default: return e.type;
  }
}
