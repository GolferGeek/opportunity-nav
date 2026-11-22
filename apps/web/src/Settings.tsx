import { useState } from "react";
import { ago, api, providerName, usePoll } from "./api.ts";

export function Settings({ onClose, onError }: { onClose: () => void; onError: (m: string) => void }) {
  const machines = usePoll<any[]>("/api/machines", 10_000);
  const tokens = usePoll<any[]>("/api/tokens", 60_000);
  const [created, setCreated] = useState<{ role: string; token: string } | null>(null);
  const [label, setLabel] = useState("");
  const make = async (role: "node" | "agent") => {
    if (!label.trim()) return onError("Give it a name first, like “Mac Studio” or “Grok Bot”.");
    try {
      const t = await api("POST", "/api/tokens", { role, label: label.trim() });
      setCreated({ role, token: t.token });
      setLabel("");
      void tokens.reload();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const server = (window as any).opnavDesktop?.serverUrl ?? location.origin;
  return (
    <aside className="drawer wide" role="dialog" aria-label="Settings">
      <div className="drawer-head"><h2>Settings</h2><span className="spacer" /><button onClick={onClose} aria-label="Close">✕</button></div>

      <h4>Machines</h4>
      {machines.data?.length === 0 && <p className="muted">No machines yet. Connect one below.</p>}
      <ul className="machines">
        {machines.data?.map((m) => (
          <li key={m.id} className="card">
            <div><span className={`dot ${m.online ? "running" : "offline"}`} /> <strong>{m.name}</strong> <span className="muted">{m.platform} · seen {ago(m.lastSeenAt)}</span></div>
            <div className="muted">
              {m.providers.filter((p: any) => p.signedIn).map((p: any) => providerName(p.provider)).join(", ") || "No agents signed in"}
              {m.checkouts.length ? ` · ${m.checkouts.length} repos` : ""}{m.handoff ? " · handoff watcher" : ""}
              {m.autonomy === "full" ? " · workers run without a sandbox" : ""}
            </div>
          </li>
        ))}
      </ul>

      <h4>Connect a machine or an agent</h4>
      <div className="row-buttons">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name, e.g. Mac Studio or Grok Bot" />
        <button onClick={() => void make("node")}>Machine token</button>
        <button onClick={() => void make("agent")}>Agent token</button>
      </div>
      {created && (
        <div className="card token-shown">
          <p><strong>Copy this now.</strong> It won't be shown again.</p>
          <code className="token">{created.token}</code>
          {created.role === "node" ? (
            <p className="muted">On that machine:<br /><code>OPNAV_SERVER_URL={server} OPNAV_NODE_TOKEN=… npx opnav-node</code><br />or paste it into the desktop app.</p>
          ) : (
            <p className="muted">Give the agent:<br />A2A card: <code>{server}/.well-known/agent-card.json</code><br />MCP: <code>{server}/mcp</code><br />Header: <code>Authorization: Bearer …</code></p>
          )}
          <button onClick={() => setCreated(null)}>Done</button>
        </div>
      )}

      <h4>Tokens</h4>
      <ul className="tokens">
        {tokens.data?.filter((t) => !t.revoked_at).map((t) => (
          <li key={t.id}>
            <span>{t.label}</span> <span className="muted">{t.role} · {t.last_used_at ? `used ${ago(t.last_used_at)}` : "never used"}</span>
            <button className="quietbtn" onClick={async () => { await api("DELETE", `/api/tokens/${t.id}`); void tokens.reload(); }}>Revoke</button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
