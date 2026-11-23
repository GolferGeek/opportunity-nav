import { ago, api, needsText, providerName, usePoll } from "./api.ts";
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
            <span className={`dot ${job.status}`} /> {job.status} · {providerName(job.provider)}{job.model ? ` · ${job.model}` : ""} · {job.cloudroom ? "in Cloudroom's cloud" : job.claudeCloud ? "in Claude's cloud" : job.location}{job.machine ? ` · ${job.cloudroom || job.claudeCloud ? "handed over by" : "on"} ${job.machine}` : ""}
            {job.needs?.length ? ` · needs ${needsText(job.needs)}` : ""}
            {job.tokens && (job.tokens.input || job.tokens.output) ? ` · ${(job.tokens.input + job.tokens.output).toLocaleString()} tokens` : ""}
            {job.costUsd ? ` · $${job.costUsd.toFixed(2)}` : ""} · started by {job.createdBy} {ago(job.createdAt)}
          </div>
          {job.backlog && (
            <div className="muted small">
              In the backlog under {job.app ?? "its project"}{job.held ? ", on hold" : ""}.
              {job.after?.length ? ` Starts after ${job.after.join(", ")}.` : ""}
              {job.localModel ? " Uses the machine's local models." : ""}
              {job.branch ? <> Runs from <code>{job.branch}</code>.</> : ""}
            </div>
          )}
          {job.cloudroom && (
            <div className="muted small">
              Runs in a Cloudroom sandbox from the repo's default branch on GitHub. Its work is pushed to <code>{job.cloudroom.branch}</code>.
              {job.cloudroom.thread ? <> Open thread <code>{job.cloudroom.thread}</code> in the Cloudroom app to see everything.</> : ""}
            </div>
          )}
          {job.claudeCloud && (
            <div className="muted small">
              Runs in Claude's cloud through your Claude Code routine, from the checkout's branch on GitHub.
              Its work comes back on a <code>claude/opnav-…</code> branch.
              {job.claudeCloud.session ? <> See the session at <a href={`https://claude.ai/code/${encodeURIComponent(job.claudeCloud.session)}`} target="_blank" rel="noreferrer">claude.ai/code</a>.</> : ""}
            </div>
          )}
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
            empty={job.status === "queued" ? (job.backlog ? "Waiting its turn in the backlog." : "Waiting for a machine that has this repo and agent.") : "Nothing yet."} />
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
