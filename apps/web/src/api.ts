import { useCallback, useEffect, useRef, useState } from "react";

const TOKEN_KEY = "opnav.token";

/** A sign-in link is `/#signin=<token>`: keep the token, then clean the URL. */
export function takeSigninFromUrl() {
  const m = /#signin=([\w-]+)/.exec(location.hash);
  if (m) {
    try {
      localStorage.setItem(TOKEN_KEY, m[1]!);
    } catch {}
    history.replaceState(null, "", location.pathname + location.search);
  }
}

export function token(): string | null {
  try {
    return (window as any).opnavDesktop?.token ?? localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function signOut() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
  location.reload();
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const base = () => (window as any).opnavDesktop?.serverUrl ?? "";

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(base() + path, {
    method,
    headers: { authorization: `Bearer ${token()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, data.error ?? `Request failed (${r.status}).`);
  return data as T;
}

/** Fetch, then refresh every `everyMs` while the tab is visible. `reload()` refetches now. */
export function usePoll<T>(path: string | null, everyMs = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;
  const reload = useCallback(async () => {
    const p = pathRef.current;
    if (!p) return;
    try {
      const d = await api<T>("GET", p);
      if (pathRef.current === p) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    setData(null);
    void reload();
    const t = setInterval(() => document.visibilityState === "visible" && void reload(), everyMs);
    return () => clearInterval(t);
  }, [path, everyMs, reload]);
  return { data, error, reload };
}

export interface TreeNode {
  id: string;
  parentId: string | null;
  kind: "area" | "project" | "item";
  title: string;
  notes: string | null;
  position: number;
  favorite: boolean;
  favoritePosition: number | null;
  repoRemote: string | null;
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultLocation: "local" | "cloud" | null;
  statusLine: string | null;
}

export const PROVIDERS: { id: string; name: string }[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "agy", name: "Antigravity (agy)" },
  { id: "cursor", name: "Cursor" },
  { id: "grokbot", name: "Grok Bot" },
  { id: "grok", name: "Grok" },
  { id: "ollama", name: "Ollama" },
  { id: "mlx", name: "MLX" },
];
const OTHER_NAMES: Record<string, string> = { gemini: "Gemini CLI" };
export const providerName = (id: string) => PROVIDERS.find((p) => p.id === id)?.name ?? OTHER_NAMES[id] ?? id;

export function ago(d: string | Date | null | undefined): string {
  if (!d) return "";
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function until(d: string | Date | null | undefined): string {
  if (!d) return "";
  const s = Math.round((new Date(d).getTime() - Date.now()) / 1000);
  if (s <= 0) return "now";
  const days = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (days) return `${days}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
