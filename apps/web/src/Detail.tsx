import { useEffect, useMemo, useReducer, useState } from "react";
import { ago, api, LOCAL_MODEL_PROVIDERS, NEEDS, PRIORITIES, PROVIDERS, needsText, providerName, runsOnText, type Need, type Priority, type TreeNode } from "./api.ts";
import { keepWhere, whereOptions, whereToJob, type MachineLite } from "./where.ts";
import { OTHER_MODEL, modelChoice, modelOptions, type RecentJob } from "./models.ts";
import { autoOpen, itemPrompt } from "./attended.ts";
import { defaultLocationLabel, defaultModelLabel, formReducer, initialForm, jobBody, shown } from "./newJob.ts";

export function Detail({ node, project, path, unattended, attendedKnown, onChanged, onOpenJob, onError, onSelect }: {
  node: TreeNode;
  /** Its nearest project (itself, if it is one): whose defaults a new job starts from. */
  project: TreeNode | null;
  path: string[];
  /** An item nothing is working on: opening it opens the new-job form, ready to go. */
  unattended: boolean;
  /** Whether the list of what's being worked on has loaded yet. */
  attendedKnown: boolean;
  onChanged: () => void;
  onOpenJob: (id: string) => void;
  onError: (m: string) => void;
  onSelect: (id: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [starting, setStarting] = useState(false);
  // The node the form last opened by itself for, so closing it keeps it closed.
  const [autoOpened, setAutoOpened] = useState<string | null>(null);
  useEffect(() => {
    setEditing(false);
    setStarting(false);
  }, [node.id]);
  useEffect(() => {
    // Once per visit, once we know: an unattended item opens straight to the new-job form.
    const next = autoOpen(autoOpened, node.id, unattended, attendedKnown);
    if (next.seen !== autoOpened) setAutoOpened(next.seen);
    if (next.open) setStarting(true);
  }, [node.id, unattended, attendedKnown, autoOpened]);
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
        {unattended && <span className="unattended-tag muted" title="Nothing is working on it.">Unattended</span>}
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
      {starting && <StartJob key={node.id} node={node} project={project} prefill={unattended} onStarted={(id) => { setStarting(false); onChanged(); onOpenJob(id); }} onError={onError} />}
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

/**
 * The new-job form, the one place a job is picked and started. Opened for an
 * unattended item (`prefill`), it starts from the item's name and notes, so
 * picking where it runs, the agent and the model, then Start, is all it takes.
 * It starts from the nearest project's defaults and sends only what's changed
 * (see newJob.ts), so the server applies the project's agent, model and needs.
 */
function StartJob({ node, project, prefill, onStarted, onError }: {
  node: TreeNode; project: TreeNode | null; prefill?: boolean; onStarted: (id: string) => void; onError: (m: string) => void;
}) {
  const [form, dispatch] = useReducer(formReducer, undefined, () => initialForm(prefill ? itemPrompt(node) : ""));
  const v = shown(form, project);
  const { provider, needs, projectModel } = v;
  const localModels = LOCAL_MODEL_PROVIDERS.includes(provider);
  const [busy, setBusy] = useState(false);
  // The machines, and the user's recent jobs: the models each agent ran lately, for the model list.
  const [machines, setMachines] = useState<MachineLite[]>([]);
  const [recent, setRecent] = useState<RecentJob[]>([]);
  useEffect(() => {
    let live = true;
    void api<MachineLite[]>("GET", "/api/machines").then((ms) => live && setMachines(ms)).catch(() => {});
    void api<RecentJob[]>("GET", "/api/jobs").then((j) => live && setRecent(j)).catch(() => {});
    return () => { live = false; };
  }, []);
  // The project's repo is what Claude's cloud routines are matched on; an item has none of its own.
  const repo = project?.repoRemote ?? null;
  const whereOpts = useMemo(() => whereOptions(machines, provider, repo, needs, { agent: providerName, needs: needsText }),
    [machines, provider, repo, needs]);
  // A choice that stops fitting (another agent, a routine that no longer covers the repo) goes back to any machine.
  const chosen = keepWhere(form.where, whereOpts);
  useEffect(() => { if (chosen !== form.where) dispatch({ type: "where", value: chosen }); }, [chosen, form.where]);
  const { runner, machineId } = whereToJob(chosen);
  const inCloud = runner !== "direct";
  // The models to pick from: on the chosen machine, else on any machine (none count in a cloud).
  const pool = useMemo(() => (inCloud ? [] : machineId ? machines.filter((m) => m.id === machineId) : machines), [inCloud, machineId, machines]);
  const modelOpts = useMemo(() => runner === "claude-cloud"
    ? [{ value: "", label: "Routine model (set in Claude)" }]
    : modelOptions(provider, pool, recent, projectModel, defaultModelLabel(projectModel)),
    [provider, pool, recent, projectModel, runner]);
  // "Other…" shows a box to type any id; so does a model that isn't in the list.
  const modelPick = runner === "claude-cloud" ? "" : form.typing ? OTHER_MODEL : modelChoice(v.model, modelOpts);
  const go = async () => {
    if (!form.prompt.trim()) return;
    setBusy(true);
    try {
      const j = await api("POST", "/api/jobs", jobBody(node.id, form, project, whereOpts, (p) => LOCAL_MODEL_PROVIDERS.includes(p)));
      onStarted(j.id);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="start-job card" onSubmit={(e) => { e.preventDefault(); void go(); }}>
      <textarea autoFocus rows={4} value={form.prompt} onChange={(e) => dispatch({ type: "prompt", value: e.target.value })} placeholder="What should the agent do?"
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void go(); }} />
      <div className="row-buttons">
        <select value={provider} onChange={(e) => dispatch({ type: "provider", value: e.target.value })} aria-label="Agent">
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === project?.defaultProvider ? " (project default)" : ""}</option>)}
        </select>
        <select value={modelPick} onChange={(e) => dispatch({ type: "model", value: e.target.value })} aria-label="Model"
          title="Project default: the project's model. Default model: the agent picks. The list is what your machines have and what this agent ran lately.">
          {modelOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {modelPick === OTHER_MODEL && (
          <input autoFocus={form.typing} value={v.model} onChange={(e) => dispatch({ type: "typeModel", value: e.target.value })} placeholder="Model id" aria-label="Model id" />
        )}
        {/* Only Ollama and MLX can run their model on the machine itself; every other agent's model is in the cloud, so there's nothing to pick. */}
        {localModels && !inCloud && (
          <select value={v.location} onChange={(e) => dispatch({ type: "location", value: e.target.value as "" | "local" | "cloud" })} aria-label="Model location">
            <option value="">{defaultLocationLabel(project)}</option>
            <option value="local">Local model</option>
            <option value="cloud">Cloud model</option>
          </select>
        )}
        <select value={chosen} onChange={(e) => dispatch({ type: "where", value: e.target.value })} aria-label="Where it runs"
          title="Any machine: the first free one that can run it. A cloud runs it in its own sandbox, starting from the repo on GitHub, and pushes the work to a branch.">
          {whereOpts.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
        </select>
        {!inCloud && <span className="needs-pick muted" title="Only a machine that has these takes the job.">Needs <NeedsPicker value={needs} onChange={(n) => dispatch({ type: "needs", value: n })} /></span>}
        <span className="spacer" />
        <button type="submit" className="primary" disabled={busy || !form.prompt.trim()}>Start</button>
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
