import { useEffect, useMemo, useState } from "react";
import { api, type TreeNode } from "./api.ts";
import { isUnattended } from "./attended.ts";

interface Props {
  tree: TreeNode[];
  /** The nodes something is working on (null while loading). */
  attended: ReadonlySet<string> | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => void;
  onError: (msg: string) => void;
}

const KIND_FOR_CHILD: Record<TreeNode["kind"] | "root", TreeNode["kind"]> = { root: "area", area: "project", project: "item", item: "item" };

export function Nav({ tree, attended, selected, onSelect, onChanged, onError }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("opnav.collapsed") ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const [adding, setAdding] = useState<string | "root" | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const kids = useMemo(() => {
    const m = new Map<string | null, TreeNode[]>();
    for (const n of tree) m.set(n.parentId, [...(m.get(n.parentId) ?? []), n]);
    return m;
  }, [tree]);
  const savedFavorites = useMemo(() => tree.filter((n) => n.favorite).sort((a, b) => (a.favoritePosition ?? 0) - (b.favoritePosition ?? 0)), [tree]);
  // While a drag is saving, show the new order so the row doesn't jump back.
  const [draftOrder, setDraftOrder] = useState<string[] | null>(null);
  useEffect(() => setDraftOrder(null), [tree]);
  const favorites = draftOrder
    ? draftOrder.map((id) => savedFavorites.find((f) => f.id === id)).filter((f): f is TreeNode => !!f)
    : savedFavorites;
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);
  const dropFavorite = () => {
    const from = dragging;
    const at = dropAt;
    setDragging(null);
    setDropAt(null);
    if (!from || !at || at.id === from) return;
    const rest = favorites.filter((f) => f.id !== from);
    const i = rest.findIndex((f) => f.id === at.id) + (at.after ? 1 : 0);
    const order = [...rest.slice(0, i).map((f) => f.id), from, ...rest.slice(i).map((f) => f.id)];
    if (order.join() === favorites.map((f) => f.id).join()) return;
    setDraftOrder(order);
    // The draft clears when the reloaded tree arrives, or at once if saving fails.
    api("PATCH", `/api/tree/${from}`, { favoriteBeforeId: rest[i]?.id ?? null }).then(onChanged, (e: Error) => {
      setDraftOrder(null);
      onError(e.message);
    });
  };

  const toggle = (id: string) => {
    const next = new Set(collapsed);
    next.has(id) ? next.delete(id) : next.add(id);
    setCollapsed(next);
    try {
      localStorage.setItem("opnav.collapsed", JSON.stringify([...next]));
    } catch {}
  };
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  // Siblings sort by priority first, so ↑/↓ move within the same priority.
  const move = (n: TreeNode, dir: -1 | 1) => {
    const same = (kids.get(n.parentId) ?? []).filter((s) => s.priority === n.priority);
    const i = same.findIndex((s) => s.id === n.id);
    if (dir === -1 && same[i - 1]) void act(() => api("PATCH", `/api/tree/${n.id}`, { beforeId: same[i - 1]!.id }));
    if (dir === 1 && same[i + 1]) void act(() => api("PATCH", `/api/tree/${same[i + 1]!.id}`, { beforeId: n.id }));
  };

  const row = (n: TreeNode, depth: number): React.ReactNode => {
    const children = kids.get(n.id) ?? [];
    const open = !collapsed.has(n.id);
    return (
      <li key={n.id}>
        <div className={`row ${selected === n.id ? "sel" : ""} kind-${n.kind}`} style={{ paddingLeft: 8 + depth * 14 }}>
          <button className="twisty" onClick={() => toggle(n.id)} aria-label={open ? "Collapse" : "Expand"} style={{ visibility: children.length ? "visible" : "hidden" }}>
            {open ? "▾" : "▸"}
          </button>
          {renaming === n.id ? (
            <InlineInput
              initial={n.title}
              onDone={(title) => {
                setRenaming(null);
                if (title && title !== n.title) void act(() => api("PATCH", `/api/tree/${n.id}`, { title }));
              }}
            />
          ) : (
            <button className="title" onClick={() => onSelect(n.id)} onDoubleClick={() => setRenaming(n.id)} title={n.statusLine ?? undefined}>
              {n.title}
            </button>
          )}
          {isUnattended(n, attended) && (
            <span className="unattended" title="Unattended: nothing is working on it. Click it to start a job." aria-label="Unattended">○</span>
          )}
          <span className="row-actions">
            <button title="Add inside" onClick={() => setAdding(n.id)}>+</button>
            <button title="Move up" onClick={() => move(n, -1)}>↑</button>
            <button title="Move down" onClick={() => move(n, 1)}>↓</button>
            <button title={n.favorite ? "Remove from favorites" : "Add to favorites"} className={n.favorite ? "on" : ""}
              onClick={() => void act(() => api("PATCH", `/api/tree/${n.id}`, { favorite: !n.favorite }))}>
              {n.favorite ? "★" : "☆"}
            </button>
          </span>
        </div>
        {adding === n.id && <AddRow depth={depth + 1} kind={KIND_FOR_CHILD[n.kind]} parentId={n.id} onDone={() => setAdding(null)} act={act} />}
        {open && children.length > 0 && <ul>{children.map((c) => row(c, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <nav className="nav">
      <button className={`home ${selected === null ? "sel" : ""}`} onClick={() => onSelect(null)}>
        Everything
      </button>
      {favorites.length > 0 && (
        <section>
          <h3>Favorites</h3>
          <ul>
            {favorites.map((f) => (
              <li key={f.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", f.id); // Firefox won't start a drag without data
                  setDragging(f.id);
                }}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const r = e.currentTarget.getBoundingClientRect();
                  const after = e.clientY > r.top + r.height / 2;
                  if (dropAt?.id !== f.id || dropAt.after !== after) setDropAt({ id: f.id, after });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  dropFavorite();
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setDropAt(null);
                }}
                className={`fav ${dragging === f.id ? "dragging" : ""} ${dropAt?.id === f.id && dragging !== f.id ? (dropAt.after ? "drop-after" : "drop-before") : ""}`}>
                <div className={`row ${selected === f.id ? "sel" : ""}`} style={{ paddingLeft: 8 }} title="Drag to reorder">
                  {/* Not a <button>: Firefox won't start a drag from inside one. */}
                  <span className="title" role="button" tabIndex={0} onClick={() => onSelect(f.id)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(f.id); } }}>
                    ★ {f.title}
                  </span>
                  <span className="grip" aria-hidden>⋮⋮</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h3>
          Tree <button className="add-root" title="Add an area" onClick={() => setAdding("root")}>+</button>
        </h3>
        {tree.length === 0 && adding !== "root" && <p className="empty">Nothing here yet.<br />Add your first area with +.</p>}
        <ul>
          {adding === "root" && <AddRow depth={0} kind="area" parentId={null} onDone={() => setAdding(null)} act={act} />}
          {(kids.get(null) ?? []).map((n) => row(n, 0))}
        </ul>
      </section>
    </nav>
  );
}

function AddRow({ depth, kind, parentId, onDone, act }: { depth: number; kind: TreeNode["kind"]; parentId: string | null; onDone: () => void; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [k, setK] = useState(kind);
  return (
    <li>
      <div className="row adding" style={{ paddingLeft: 8 + depth * 14 }}>
        <select value={k} onChange={(e) => setK(e.target.value as TreeNode["kind"])} aria-label="Kind">
          <option value="area">Area</option>
          <option value="project">Project</option>
          <option value="item">Item</option>
        </select>
        <InlineInput
          initial=""
          placeholder={`New ${k}`}
          onDone={(title) => {
            onDone();
            if (title) void act(() => api("POST", "/api/tree", { parentId, kind: k, title }));
          }}
        />
      </div>
    </li>
  );
}

function InlineInput({ initial, placeholder, onDone }: { initial: string; placeholder?: string; onDone: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <input
      autoFocus
      className="inline"
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onDone(v.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(v.trim());
        if (e.key === "Escape") onDone("");
      }}
    />
  );
}
