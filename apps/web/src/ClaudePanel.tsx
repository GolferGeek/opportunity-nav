import { useEffect, useRef, useState } from "react";
import { ago, api } from "./api.ts";

interface Msg { id: number; role: "user" | "assistant" | "tool" | "error"; text: string; at: string }
interface Thread { id: string; title: string; running: boolean; updatedAt: string }

const THREAD_KEY = "opnav.chat.thread";

/**
 * Talk to Claude about anything here: your tree, what's waiting, what you
 * want to do next, or how this app should look and work. It acts through the
 * app's own tools and saves each conversation.
 */
export function ClaudePanel({ scope, onClose, onChanged, pending, onPendingTaken }: {
  scope: { id: string; path: string[] } | null;
  onClose: () => void;
  onChanged: () => void;
  /** A message typed in the ⌘K bar, to send here. */
  pending: string | null;
  onPendingTaken: () => void;
}) {
  const [threadId, setThreadId] = useState<string | null>(() => {
    try { return localStorage.getItem(THREAD_KEY); } catch { return null; }
  });
  const [messages, setMessages] = useState<Msg[]>([]);
  const [running, setRunning] = useState(false);
  const [text, setText] = useState("");
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [showThreads, setShowThreads] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const lastId = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);

  const remember = (id: string | null) => {
    setThreadId(id);
    try { id ? localStorage.setItem(THREAD_KEY, id) : localStorage.removeItem(THREAD_KEY); } catch {}
  };

  // Load a thread from the start when it changes.
  useEffect(() => {
    lastId.current = 0;
    setMessages([]);
    setRunning(false);
    if (!threadId) return;
    api<any>("GET", `/api/chat/${threadId}`).then((t) => {
      setMessages(t.messages);
      lastId.current = t.messages.at(-1)?.id ?? 0;
      setRunning(t.running);
    }).catch(() => remember(null));
  }, [threadId]);

  // While Claude is answering, pull new messages every second.
  useEffect(() => {
    if (!threadId || !running) return;
    const t = setInterval(async () => {
      try {
        const th = await api<any>("GET", `/api/chat/${threadId}?after=${lastId.current}`);
        if (th.messages.length) {
          setMessages((m) => [...m, ...th.messages]);
          lastId.current = th.messages.at(-1).id;
          if (th.messages.some((m: Msg) => m.role === "tool")) onChanged();
        }
        if (!th.running) {
          setRunning(false);
          onChanged();
        }
      } catch {}
    }, 1000);
    return () => clearInterval(t);
  }, [threadId, running, onChanged]);

  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, running]);

  const sendText = async (body: string) => {
    if (!body.trim() || running) return;
    setError(null);
    const optimistic: Msg = { id: -Date.now(), role: "user", text: body.trim(), at: new Date().toISOString() };
    setMessages((m) => [...m, optimistic]);
    setText("");
    try {
      const r = await api<{ threadId: string }>("POST", "/api/chat", { threadId: threadId ?? undefined, text: body.trim(), scope });
      if (r.threadId !== threadId) {
        // New thread: adopt it, keep the optimistic message until the poll brings the real one.
        lastId.current = 0;
        setThreadId(r.threadId);
        try { localStorage.setItem(THREAD_KEY, r.threadId); } catch {}
      } else {
        // Skip our own message when polling (it's already shown).
        const th = await api<any>("GET", `/api/chat/${r.threadId}?after=${lastId.current}`);
        lastId.current = th.messages.at(-1)?.id ?? lastId.current;
      }
      setRunning(true);
    } catch (e) {
      setMessages((m) => m.filter((x) => x.id !== optimistic.id));
      setText(body);
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    if (pending) {
      onPendingTaken();
      void sendText(pending);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  useEffect(() => { input.current?.focus(); }, []);

  const openThreads = async () => {
    setShowThreads(!showThreads);
    if (!showThreads) setThreads(await api<Thread[]>("GET", "/api/chat").catch(() => []));
  };

  return (
    <aside className="claude" aria-label="Claude">
      <div className="claude-head">
        <strong>Claude</strong>
        <span className="muted small">{scope ? `about ${scope.path.at(-1)}` : "about everything"}</span>
        <span className="spacer" />
        <button className="quietbtn" onClick={() => void openThreads()} title="Earlier conversations">History</button>
        <button className="quietbtn" onClick={() => { remember(null); setShowThreads(false); input.current?.focus(); }} title="Start a new conversation">New</button>
        <button className="quietbtn" onClick={onClose} aria-label="Close">✕</button>
      </div>
      {showThreads && (
        <ul className="threads">
          {threads === null && <li className="muted">Loading…</li>}
          {threads?.length === 0 && <li className="muted">No conversations yet.</li>}
          {threads?.map((t) => (
            <li key={t.id}>
              <button className={`link ${t.id === threadId ? "on" : ""}`} onClick={() => { remember(t.id); setShowThreads(false); }}>{t.title}</button>
              <span className="muted small"> {ago(t.updatedAt)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="messages" ref={list}>
        {messages.length === 0 && !running && (
          <div className="muted hello">
            Ask about anything here, or tell it what you want.
            <ul>
              <li>“What's waiting on me?”</li>
              <li>“Add an item under Divinr: try the new ballot parser.”</li>
              <li>“Make the dashboard cards more compact.”</li>
            </ul>
            Changes to this app become a job you review before it ships.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>{m.role === "tool" ? `· ${m.text}` : m.text}</div>
        ))}
        {running && <div className="msg thinking muted">Working…</div>}
      </div>
      {error && <div className="claude-error">{error}</div>}
      <form className="claude-input" onSubmit={(e) => { e.preventDefault(); void sendText(text); }}>
        <textarea ref={input} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={running ? "Claude is answering…" : "Message Claude"}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendText(text); } }} />
        <div className="row-buttons">
          <span className="muted small">Enter to send · Shift+Enter for a new line</span>
          <span className="spacer" />
          {running
            ? <button type="button" onClick={() => threadId && void api("POST", `/api/chat/${threadId}/stop`)}>Stop</button>
            : <button type="submit" className="primary" disabled={!text.trim()}>Send</button>}
        </div>
      </form>
    </aside>
  );
}
