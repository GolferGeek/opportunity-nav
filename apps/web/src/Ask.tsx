import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";

/** One box for "add this", "I didn't like this", "do it this way", about whatever is selected. ⌘K / Ctrl-K focuses it. */
export function Ask({ scope, onDone, onError }: { scope: { id: string; path: string[] } | null; onDone: () => void; onError: (m: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);
  const go = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setReply(null);
    try {
      const r = await api("POST", "/api/ask", { text: text.trim(), scope });
      setReply(r.reply);
      setText("");
      onDone();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="ask" onSubmit={(e) => { e.preventDefault(); void go(); }}>
      <input ref={input} value={text} onChange={(e) => setText(e.target.value)} disabled={busy}
        placeholder={busy ? "Working on it…" : scope ? `Tell it what to do with ${scope.path.at(-1)}  (⌘K)` : "Tell it what to do  (⌘K)"} />
      {reply && <div className="ask-reply" onClick={() => setReply(null)}>{reply}</div>}
    </form>
  );
}
