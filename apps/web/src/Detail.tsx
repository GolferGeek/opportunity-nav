import { useEffect, useState } from "react";
import { ago, api, LOCAL_MODEL_PROVIDERS, NEEDS, PRIORITIES, PROVIDERS, providerName, runsOnText, type Need, type Priority, type TreeNode } from "./api.ts";

export function Detail({ node, path, onChanged, onOpenJob, onError, onSelect }: {
  node: TreeNode;
  path: string[];
  onChanged: () => void;
  onOpenJob: (id: string) => void;
  onError: (m: string) => void;
  onSelect: (id: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    setEditing(false);
    setStarting(false);
  }, [node.id]);
  const patch = async (body: object) => {
    try {
      await api("PATCH", `/api/tree/${node.id}`, body);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <header className="detail-head">
      <div className="crumbs muted">{path.slice(0, -1).join(" / ")}</div>
      <div className="title-row">
        <h1>{node.title}</h1>
        <span className="kind muted">{node.kind}</span>
        <span className="spacer" />
        {node.kind === "project" && (
          <label className="priority muted" title="Higher-priority projects sort first">
            Priority
            <select value={node.priority} onChange={(e) => void patch({ priority: e.target.value as Priority })}>
              {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        {node.kind !== "area" && <button className="primary" onClick={() => setStarting(!starting)}>Start a job</button>}
        <button onClick={() => setEditing(!editing)}>{editing ? "Done" : "Edit"}</button>
      </div>
      {!editing && (
        <div className="facts muted">
          {node.statusLine && <span>{node.statusLine}</span>}
          {node.repoRemote && <span>{node.repoRemote}</span>}
          {node.defaultProvider && <span>{providerName(node.defaultProvider)}{node.defaultModel ? ` · ${node.defaultModel}` : ""}{node.defaultLocation ? ` · ${node.defaultLocation}` : ""}</span>}
        </div>
      )}
      {!editing && node.notes && <p className="notes">{node.notes}</p>}
      {editing && <EditForm node={node} patch={patch} onArchived={() => onSelect(node.parentId)} />}
      {starting && <StartJob node={node} onStarted={(id) => { setStarting(false); onChanged(); onOpenJob(id); }} onError={onError} />}
      <RecentJobs nodeId={node.id} onOpenJob={onOpenJob} />
    </header>
  );
}

function EditForm({ node, patch, onArchived }: { node: TreeNode; patch: (b: object) => Promise<void>; onArchived: () => void }) {
  const [f, setF] = useState({
    title: node.title, notes: node.notes ?? "", repoRemote: node.repoRemote ?? "", statusLine: node.statusLine ?? "",
    defaultProvider: node.defaultProvider ?? "", defaultModel: node.defaultModel ?? "", defaultLocation: node.defaultLocation ?? "",
  });
  const [needs, setNeeds] = useState<Need[]>(node.defaultNeeds ?? []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const save = () =>
    patch({
      title: f.title, notes: f.notes || null, repoRemote: f.repoRemote || null, statusLine: f.statusLine || null,
      defaultProvider: f.defaultProvider || null, defaultModel: f.defaultModel || null, defaultLocation: f.defaultLocation || null,
      defaultNeeds: needs,
    });
  return (
    <form className="edit" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label>Name<input value={f.title} onChange={set("title")} /></label>
      <label>One-line status<input value={f.statusLine} onChange={set("statusLine")} placeholder="Shown on the dashboard" /></label>
      {node.kind !== "area" && <label>Git repo<input value={f.repoRemote} onChange={set("repoRemote")} placeholder="github.com/owner/repo" /></label>}
      <div className="three">
        <label>Default agent
          <select value={f.defaultProvider} onChange={set("defaultProvider")}>
            <option value="">None</option>
            {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>Default model<input value={f.defaultModel} onChange={set("defaultModel")} placeholder="Agent's default" /></label>
        <label>Runs
          <select value={f.defaultLocation} onChange={set("defaultLocation")}>
            <option value="">Agent's default</option>
            <option value="cloud">Cloud</option>
            <option value="local">Local</option>
          </select>
        </label>
      </div>
      {node.kind !== "area" && (
        <div className="needs-pick">Jobs here need <NeedsPicker value={needs} onChange={setNeeds} /></div>
      )}
      <label>Notes<textarea rows={3} value={f.notes} onChange={set("notes")} /></label>
      <div className="row-buttons">
        <button type="submit" className="primary">Save</button>
        <span className="spacer" />
        <button type="button" className="quietbtn" onClick={async () => { await patch({ archived: true }); onArchived(); }}>Archive</button>
      </div>
    </form>
  );
}

function StartJob({ node, onStarted, onError }: { node: TreeNode; onStarted: (id: string) => void; onError: (m: string) => void }) {
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState(node.defaultProvider ?? "claude");
  const [model, setModel] = useState(node.defaultModel ?? "");
  const [location, setLocation] = useState(node.defaultLocation ?? "");
  const [runner, setRunner] = useState<"direct" | "cloudroom" | "claude-cloud">("direct");
  const [needs, setNeeds] = useState<Need[]>(node.defaultNeeds ?? []);
  const localModels = LOCAL_MODEL_PROVIDERS.includes(provider);
  useEffect(() => { if (!localModels && location === "local") setLocation(""); }, [localModels, location]);
  const [busy, setBusy] = useState(false);
  // Machines that can hand jobs to Cloudroom, and which agents they can run there.
  const [cloudroom, setCloudroom] = useState<string[]>([]);
  // Whether an online machine has its Claude Code routine set up for this repo, for Claude in Claude's cloud.
  const [claudeCloud, setClaudeCloud] = useState(false);
  useEffect(() => {
    let live = true;
    setClaudeCloud(false);
    // The job runs in the node's project (an item's nearest project above it), as the server resolves it.
    void Promise.all([api<any[]>("GET", "/api/machines"), api<TreeNode[]>("GET", "/api/tree")]).then(([ms, tree]) => {
      if (!live) return;
      const byId = new Map(tree.map((n) => [n.id, n]));
      let project: TreeNode | undefined = byId.get(node.id) ?? node;
      while (project && project.kind !== "project") project = project.parentId ? byId.get(project.parentId) : undefined;
      const repo = project?.repoRemote ?? null;
      setCloudroom([...new Set(ms.filter((m) => m.online && m.cloudroom).flatMap((m) => m.cloudroom.providers as string[]))]);
      // Only a routine that covers the project's repo can run it (the server matches the same way).
      setClaudeCloud(ms.some((m) => m.online && m.claudeCloud?.ready && repo !== null && (m.claudeCloud.repos ?? []).includes(repo)));
    }).catch(() => {});
    return () => { live = false; };
  }, [node.id, node.repoRemote]);
  useEffect(() => {
    if (runner === "cloudroom" && !cloudroom.includes(provider) || runner === "claude-cloud" && (provider !== "claude" || !claudeCloud)) setRunner("direct");
  }, [provider, cloudroom, claudeCloud, runner]);
  const inCloud = runner !== "direct";
  const go = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      const j = await api("POST", "/api/jobs", { nodeId: node.id, prompt, provider, model: model || undefined,
        location: inCloud ? "cloud" : location || undefined, runner, needs });
      onStarted(j.id);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="start-job card" onSubmit={(e) => { e.preventDefault(); void go(); }}>
      <textarea autoFocus rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should the agent do?"
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void go(); }} />
      <div className="row-buttons">
        <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Agent">
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model (default)" aria-label="Model" />
        {!inCloud && (
          <select value={location} onChange={(e) => setLocation(e.target.value)} aria-label="Model location">
            <option value="">Default</option>
            <option value="cloud">Cloud model</option>
            {localModels && <option value="local">Local model</option>}
          </select>
        )}
        {(cloudroom.length > 0 || claudeCloud) && (
          <select value={runner} onChange={(e) => setRunner(e.target.value as typeof runner)} aria-label="Where it runs"
            title="A cloud runs it in its own sandbox, starting from the repo on GitHub, and pushes the work to a branch.">
            <option value="direct">On my machine</option>
            {cloudroom.length > 0 && <option value="cloudroom" disabled={!cloudroom.includes(provider)}>In Cloudroom's cloud{cloudroom.includes(provider) ? "" : " (not for this agent)"}</option>}
            {claudeCloud && <option value="claude-cloud" disabled={provider !== "claude"}>In Claude's cloud{provider === "claude" ? "" : " (Claude only)"}</option>}
          </select>
        )}
        {!inCloud && <span className="needs-pick muted" title="Only a machine that has these takes the job.">Needs <NeedsPicker value={needs} onChange={setNeeds} /></span>}
        <span className="spacer" />
        <button type="submit" className="primary" disabled={busy || !prompt.trim()}>Start</button>
      </div>
    </form>
  );
}

function RecentJobs({ nodeId, onOpenJob }: { nodeId: string; onOpenJob: (id: string) => void }) {
  const [jobs, setJobs] = useState<any[] | null>(null);
  useEffect(() => {
    let live = true;
    void api<any[]>("GET", `/api/jobs?scope=${nodeId}`).then((j) => live && setJobs(j)).catch(() => live && setJobs([]));
    return () => { live = false; };
  }, [nodeId]);
  if (!jobs || jobs.length === 0) return null;
  return (
    <div className="recent">
      <h4>Recent jobs</h4>
      <ul>
        {jobs.slice(0, 8).map((j) => (
          <li key={j.id}>
            <button className="link" onClick={() => onOpenJob(j.id)}>{j.title}</button>
            <span className="muted"> · {j.status} · {providerName(j.provider)}{j.runsOn ? ` · ${runsOnText(j.runsOn)}` : j.machine ? ` · ${j.machine}` : ""} · {ago(j.updatedAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Docker and test database checkboxes: what a machine must have to take the job. */
function NeedsPicker({ value, onChange }: { value: Need[]; onChange: (v: Need[]) => void }) {
  return (
    <>
      {NEEDS.map((n) => (
        <label key={n.id} className="check-now">
          <input type="checkbox" checked={value.includes(n.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, n.id] : value.filter((x) => x !== n.id))} />
          {n.name}
        </label>
      ))}
    </>
  );
}
