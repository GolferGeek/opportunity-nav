import { useEffect, useMemo, useState } from "react";
import { signOut, token, usePoll, type TreeNode } from "./api.ts";
import { Nav } from "./Nav.tsx";
import { Happening, type Group } from "./Happening.tsx";
import { Dashboard, type Dash } from "./Dashboard.tsx";
import { Detail } from "./Detail.tsx";
import { JobPanel } from "./Job.tsx";
import { Settings } from "./Settings.tsx";
import { Ask } from "./Ask.tsx";

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
  const [job, setJob] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
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
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const byId = useMemo(() => new Map((tree.data ?? []).map((n) => [n.id, n])), [tree.data]);
  const node = selected ? byId.get(selected) : undefined;
  const path = useMemo(() => {
    const out: string[] = [];
    let cur = node;
    while (cur) { out.unshift(cur.title); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    return out;
  }, [node, byId]);
  const refresh = () => { void tree.reload(); void happening.reload(); void dash.reload(); };

  if (tree.error && /sign in/i.test(tree.error)) return <SignedOut expired />;

  return (
    <div className="app">
      <Nav tree={tree.data ?? []} selected={selected} onSelect={select} onChanged={refresh} onError={setToast} />
      <main>
        <div className="topbar">
          <Ask scope={node ? { id: node.id, path } : null} onDone={refresh} onError={setToast} />
          <button className="quietbtn" onClick={() => setSettings(true)}>Settings</button>
        </div>
        {node && <Detail node={node} path={path} onChanged={refresh} onOpenJob={setJob} onError={setToast} onSelect={select} />}
        <div className="panes">
          <Happening groups={happening.data} onChanged={refresh} onOpenJob={setJob} onSelect={select} onError={setToast} />
          <Dashboard dash={dash.data} onChanged={refresh} onSelect={select} onError={setToast} />
        </div>
      </main>
      {job && <JobPanel id={job} onClose={() => setJob(null)} onChanged={refresh} onError={setToast} />}
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
