import { useEffect, useRef, useState } from "react";

/** One line for "add this", "I didn't like this", "do it this way". Sends to the Claude panel. ⌘K focuses it. */
export function Ask({ scope, onSend }: { scope: { id: string; path: string[] } | null; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
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
  return (
    <form className="ask" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onSend(text.trim()); setText(""); } }}>
      <input ref={input} value={text} onChange={(e) => setText(e.target.value)}
        placeholder={scope ? `Tell Claude what to do with ${scope.path.at(-1)}  (⌘K)` : "Tell Claude what to do  (⌘K)"} />
    </form>
  );
}
