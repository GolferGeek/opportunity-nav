import { useEffect, useMemo, useState } from "react";
import { ago, api, LOCAL_MODEL_PROVIDERS, NEEDS, PRIORITIES, PROVIDERS, needsText, providerName, runsOnText, type Need, type Priority, type TreeNode } from "./api.ts";
import { ANY_MACHINE, keepWhere, whereOptions, whereToJob, type MachineLite, type Where } from "./where.ts";
import { OTHER_MODEL, modelChoice, modelOptions, type RecentJob } from "./models.ts";

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
  // One "Where it runs" choice: any machine (the default), one machine, or a cloud.
  const [where, setWhere] = useState<Where>(ANY_MACHINE);
  const [needs, setNeeds] = useState<Need[]>(node.defaultNeeds ?? []);
  const localModels = LOCAL_MODEL_PROVIDERS.includes(provider);
  useEffect(() => { if (!localModels && location === "local") setLocation(""); }, [localModels, location]);
  const [busy, setBusy] = useState(false);
  // The machines, and the repo of the node's project (what Claude's cloud routines are matched on).
  const [machines, setMachines] = useState<MachineLite[]>([]);
  const [repo, setRepo] = useState<string | null>(null);
  // The user's recent jobs: the models each agent ran lately, for the model list.
  const [recent, setRecent] = useState<RecentJob[]>([]);
  useEffect(() => {
    let live = true;
    void api<RecentJob[]>("GET", "/api/jobs").then((j) => live && setRecent(j)).catch(() => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    let live = true;
    setRepo(null);
    // The job runs in the node's project (an item's nearest project above it), as the server resolves it.
    void Promise.all([api<MachineLite[]>("GET", "/api/machines"), api<TreeNode[]>("GET", "/api/tree")]).then(([ms, tree]) => {
      if (!live) return;
      const byId = new Map(tree.map((n) => [n.id, n]));
      let project: TreeNode | undefined = byId.get(node.id) ?? node;
      while (project && project.kind !== "project") project = project.parentId ? byId.get(project.parentId) : undefined;
      setMachines(ms);
      setRepo(project?.repoRemote ?? null);
    }).catch(() => {});
    return () => { live = false; };
  }, [node.id, node.repoRemote]);
  const whereOpts = useMemo(() => whereOptions(machines, provider, repo, needs, { agent: providerName, needs: needsText }),
    [machines, provider, repo, needs]);
  // A choice that stops fitting (another agent, a routine that no longer covers the repo) goes back to any machine.
  const chosen = keepWhere(where, whereOpts);
  useEffect(() => { if (chosen !== where) setWhere(chosen); }, [chosen, where]);
  const { runner, machineId } = whereToJob(chosen);
  const inCloud = runner !== "direct";
  // The models to pick from: on the chosen machine, else on any machine (none count in a cloud).
  const pool = useMemo(() => (inCloud ? [] : machineId ? machines.filter((m) => m.id === machineId) : machines), [inCloud, machineId, machines]);
  const projectModel = provider === node.defaultProvider ? node.defaultModel : null;
  const modelOpts = useMemo(() => modelOptions(provider, pool, recent, projectModel), [provider, pool, recent, projectModel]);
  // "Other…" shows a box to type any id; so does a model that isn't in the list.
  const [typing, setTyping] = useState(false);
  const modelPick = typing ? OTHER_MODEL : modelChoice(model, modelOpts);
  const pickProvider = (p: string) => {
    setProvider(p);
    // A model id belongs to one agent: a new agent starts at its default (or the project's model for it).
    setModel(p === node.defaultProvider ? node.defaultModel ?? "" : "");
    setTyping(false);
  };
  const pickModel = (v: string) => {
    setTyping(v === OTHER_MODEL);
    setModel(v === OTHER_MODEL ? "" : v);
  };
  const go = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      const j = await api("POST", "/api/jobs", { nodeId: node.id, prompt, provider, model: model.trim() || undefined,
        location: inCloud ? "cloud" : location || undefined, runner, machineId, needs });
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
        <select value={provider} onChange={(e) => pickProvider(e.target.value)} aria-label="Agent">
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={modelPick} onChange={(e) => pickModel(e.target.value)} aria-label="Model"
          title="Default model: the agent picks. The list is what your machines have and what this agent ran lately.">
          {modelOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {modelPick === OTHER_MODEL && (
          <input autoFocus={typing} value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model id" aria-label="Model id" />
        )}
        {/* Only Ollama and MLX can run their model on the machine itself; every other agent's model is in the cloud, so there's nothing to pick. */}
        {localModels && !inCloud && (
          <select value={location} onChange={(e) => setLocation(e.target.value)} aria-label="Model location">
            <option value="">Model: default</option>
            <option value="local">Local model</option>
            <option value="cloud">Cloud model</option>
          </select>
        )}
        <select value={chosen} onChange={(e) => setWhere(e.target.value)} aria-label="Where it runs"
          title="Any machine: the first free one that can run it. A cloud runs it in its own sandbox, starting from the repo on GitHub, and pushes the work to a branch.">
          {whereOpts.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
        </select>
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
