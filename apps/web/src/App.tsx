import { useCallback, useEffect, useMemo, useState } from "react";
import { signOut, token, usePoll, type TreeNode } from "./api.ts";
import { Nav } from "./Nav.tsx";
import { Happening, type Group } from "./Happening.tsx";
import { Dashboard, type Dash } from "./Dashboard.tsx";
import { Detail } from "./Detail.tsx";
import { nearestProject } from "./newJob.ts";
import { JobPanel } from "./Job.tsx";
import { Settings } from "./Settings.tsx";
import { Ask } from "./Ask.tsx";
import { ExternalPanel } from "./External.tsx";
import { SubscriptionPanel } from "./Subscription.tsx";
import { ClaudePanel } from "./ClaudePanel.tsx";
import { isUnattended } from "./attended.ts";

export function App() {
  if (!token()) return <SignedOut />;
  return <Home />;
}

function readSelection(): string | null {
  const m = /^#\/n\/([0-9a-f-]{36})/.exec(location.hash);
  return m ? m[1]! : null;
}

function Home() {
  const tree = usePoll<TreeNode[]>("/api/tree", 15_000);
  const [selected, setSelected] = useState<string | null>(readSelection);
  const happening = usePoll<Group[]>(selected ? `/api/happening?scope=${selected}` : "/api/happening", 5000);
  const dash = usePoll<Dash>("/api/dashboard", 15_000);
  // The tree nodes something is working on; every other item is unattended.
  const attendedPoll = usePoll<string[]>("/api/attended", 15_000);
  const attended = useMemo(() => (attendedPoll.data ? new Set(attendedPoll.data) : null), [attendedPoll.data]);
  const [job, setJobState] = useState<string | null>(null);
  const [external, setExternalState] = useState<string | null>(null);
  const [sub, setSubState] = useState<string | null>(null);
  // One drawer at a time.
  const setJob = (id: string | null) => { setJobState(id); if (id) { setExternalState(null); setSubState(null); } };
  const setExternal = (id: string | null) => { setExternalState(id); if (id) { setJobState(null); setSubState(null); } };
  const setSub = (id: string | null) => { setSubState(id); if (id) { setJobState(null); setExternalState(null); } };
  const [settings, setSettings] = useState(false);
  const [claude, setClaudeState] = useState<boolean>(() => { try { return localStorage.getItem("opnav.claude") === "1"; } catch { return false; } });
  const setClaude = (open: boolean) => { setClaudeState(open); try { localStorage.setItem("opnav.claude", open ? "1" : "0"); } catch {} };
  const [pendingAsk, setPendingAsk] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const onHash = () => setSelected(readSelection());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const select = (id: string | null) => {
    location.hash = id ? `/n/${id}` : "";
    setSelected(id);
  };
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") { e.preventDefault(); setClaudeState((o) => { try { localStorage.setItem("opnav.claude", o ? "0" : "1"); } catch {} return !o; }); }
      if (e.key === "Escape") { setJobState(null); setExternalState(null); setSubState(null); setSettings(false); } };
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const byId = useMemo(() => new Map((tree.data ?? []).map((n) => [n.id, n])), [tree.data]);
  const node = selected ? byId.get(selected) : undefined;
  const pathOf = useCallback((id: string) => {
    const out: string[] = [];
    let cur = byId.get(id);
    while (cur) { out.unshift(cur.title); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    return out;
  }, [byId]);
  const path = useMemo(() => (node ? pathOf(node.id) : []), [node, pathOf]);
  const refresh = useCallback(() => { void tree.reload(); void happening.reload(); void dash.reload(); void attendedPoll.reload(); },
    [tree.reload, happening.reload, dash.reload, attendedPoll.reload]);

  if (tree.error && /sign in/i.test(tree.error)) return <SignedOut expired />;

  return (
    <div className={`app ${claude ? "with-claude" : ""}`}>
      <Nav tree={tree.data ?? []} attended={attended} selected={selected} onSelect={select} onChanged={refresh} onError={setToast} />
      <main>
        <div className="topbar">
          <Ask scope={node ? { id: node.id, path } : null} onSend={(t) => { setClaude(true); setPendingAsk(t); }} />
          <button className={claude ? "on-toggle" : ""} onClick={() => setClaude(!claude)} title="Talk to Claude (⌘J)">Claude</button>
          <button className="quietbtn" onClick={() => setSettings(true)}>Settings</button>
        </div>
        {node && <Detail node={node} project={nearestProject(byId, node)} path={path} unattended={isUnattended(node, attended)} attendedKnown={attended != null} onChanged={refresh} onOpenJob={setJob} onError={setToast} onSelect={select} />}
        <div className="panes">
          <Happening groups={happening.data} onChanged={refresh} onOpenJob={setJob} onOpenExternal={setExternal} onSelect={select} onError={setToast} />
          <Dashboard dash={dash.data} onChanged={refresh} onSelect={select} onOpenSub={setSub} onOpenJob={setJob} onError={setToast} />
        </div>
      </main>
      {claude && <ClaudePanel scope={node ? { id: node.id, path } : null} onClose={() => setClaude(false)} onChanged={refresh}
        pending={pendingAsk} onPendingTaken={() => setPendingAsk(null)} />}
      {job && <JobPanel id={job} onClose={() => setJob(null)} onChanged={refresh} onError={setToast} />}
      {external && <ExternalPanel id={external} onClose={() => setExternal(null)} pathOf={pathOf} onSelect={select} />}
      {sub && <SubscriptionPanel id={sub} onClose={() => setSub(null)} onChanged={refresh} onError={setToast} />}
      {settings && <Settings onClose={() => setSettings(false)} onError={setToast} />}
      {toast && <div className="toast" role="status" onClick={() => setToast(null)}>{toast}</div>}
    </div>
  );
}

function SignedOut({ expired }: { expired?: boolean }) {
  return (
    <div className="signed-out">
      <h1>Opportunity Nav</h1>
      <p>{expired ? "Your sign-in has expired or was revoked." : "Not signed in."}</p>
      <p className="muted">On the server, run <code>npm run admin -w @opnav/server -- signin</code> and open the link it prints.</p>
      {expired && <button onClick={signOut}>Clear and start over</button>}
    </div>
  );
}
