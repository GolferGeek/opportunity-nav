import { ago, api, providerName, until, usePoll } from "./api.ts";
import { CheckNow } from "./Dashboard.tsx";
import { readingNote } from "./labels.ts";

export function SubscriptionPanel({ id, onClose, onChanged, onError }: { id: string; onClose: () => void; onChanged: () => void; onError: (m: string) => void }) {
  const { data: s, reload } = usePoll<any>(`/api/subscriptions/${id}`, 15_000);
  const limits = (s?.windows ?? []).filter((w: any) => w.unit !== "tokens");
  const tokens = (s?.windows ?? []).filter((w: any) => w.unit === "tokens");
  return (
    <aside className="drawer" role="dialog" aria-label="Subscription">
      <div className="drawer-head">
        <h2>{s ? providerName(s.provider) : "Subscription"}</h2>
        <span className="spacer" />
        <button onClick={onClose} aria-label="Close">✕</button>
      </div>
      {!s ? <p className="muted">Loading…</p> : (
        <>
          <div className="facts muted">
            {[s.plan, s.label].filter(Boolean).join(" · ") || "Plan unknown"}
            {s.machine ? ` · read by ${s.machine}` : ""}
            <span className="spacer" />
            <CheckNow newest={s.fetchedAt} onChanged={() => { reload(); onChanged(); }} onError={onError} />
          </div>
          {readingNote(s) && <p className="sub-status">{readingNote(s)}</p>}
          <h4>Limits</h4>
          {limits.length === 0 && <p className="muted">No limits reported.</p>}
          <table className="limits">
            <tbody>
              {limits.map((w: any) => (
                <tr key={w.id}>
                  <td>{w.label}{w.model ? <span className="muted"> · {w.model}</span> : null}</td>
                  <td className="num">{w.unit === "percent" ? `${w.used.toFixed(1)}%` : w.unit === "usd" ? `$${w.used.toFixed(2)}${w.limit ? ` of $${w.limit.toFixed(2)}` : ""}` : `${w.used}${w.limit ? ` / ${w.limit}` : ""} ${w.unit}`}</td>
                  <td className="muted">{w.resetsAt ? `resets in ${until(w.resetsAt)} (${new Date(w.resetsAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })})` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {tokens.length > 0 && (
            <>
              <h4>Tokens by day</h4>
              <table className="limits"><tbody>
                {tokens.map((w: any) => <tr key={w.id}><td>{w.label}</td><td className="num">{Math.round(w.used).toLocaleString()}</td><td /></tr>)}
              </tbody></table>
            </>
          )}
          <h4>Cost</h4>
          <p className="muted">{s.monthlyCostUsd != null ? `$${s.monthlyCostUsd} a month.` : "No cost entered."} Set it from the dashboard card.</p>
          <div className="row-buttons">
            <button className="quietbtn" onClick={async () => {
              try { await api("PATCH", `/api/subscriptions/${id}`, { hidden: true }); onChanged(); onClose(); } catch (e) { onError((e as Error).message); }
            }}>Hide from the dashboard</button>
          </div>
        </>
      )}
    </aside>
  );
}
