import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useHotkey } from "../lib/keys";
import { useAppState } from "../lib/state";
import { Icon } from "./icons";

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** ⌘K: jump to a page, open a trace/thread by id, or search traces. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const { toggleTheme, toggleTimeMode, refresh } = useAppState();
  const input = useRef<HTMLInputElement>(null);

  useHotkey("k", (e) => { e.preventDefault(); setOpen((o) => !o); }, { meta: true });
  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
    }
  }, [open]);

  const commands = useMemo<Cmd[]>(() => {
    const go = (path: string) => () => { navigate(path); setOpen(false); };
    const term = q.trim();
    const dynamic: Cmd[] = [];
    if (term) {
      if (/^[0-9a-f]{32}$/i.test(term)) dynamic.push({ id: "trace", label: `Open trace ${term.slice(0, 12)}…`, run: go(`/traces/${term.toLowerCase()}`) });
      dynamic.push({ id: "thread", label: `Open thread “${term}”`, run: go(`/threads/${encodeURIComponent(term)}`) });
      dynamic.push({ id: "search", label: `Search traces for “${term}”`, hint: "full-text", run: go(`/traces?q=${encodeURIComponent(term)}`) });
    }
    const fixed: Cmd[] = [
      { id: "overview", label: "Go to Overview", hint: "g o", run: go("/") },
      { id: "traces", label: "Go to Traces", hint: "g t", run: go("/traces") },
      { id: "all-runs", label: "All runs (flat list)", run: go("/traces?view=list") },
      { id: "failures", label: "Show failed runs", run: go("/traces?view=list&status=error") },
      { id: "refresh", label: "Refresh data", run: () => { refresh(); setOpen(false); } },
      { id: "time", label: "Toggle relative / absolute times", run: () => { toggleTimeMode(); setOpen(false); } },
      { id: "theme", label: "Toggle light / dark", run: () => { toggleTheme(); setOpen(false); } },
    ];
    const lower = term.toLowerCase();
    return [...dynamic, ...fixed.filter((c) => !term || c.label.toLowerCase().includes(lower))];
  }, [q, navigate, refresh, toggleTheme, toggleTimeMode]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/20 px-4 pt-[14vh] dark:bg-black/50" onClick={() => setOpen(false)}>
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-line bg-bg shadow-[0_24px_64px_-16px_rgb(0_0_0/0.35)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Icon.search size={15} className="text-ink-3" />
          <input ref={input} autoFocus value={q} placeholder="Jump to, or paste a trace / thread id…"
            onChange={(e) => { setQ(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, commands.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              if (e.key === "Enter") commands[active]?.run();
              if (e.key === "Escape") setOpen(false);
            }}
            className="h-11 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-3" />
          <kbd>esc</kbd>
        </div>
        <ul className="max-h-80 overflow-auto p-1">
          {commands.map((c, i) => (
            <li key={c.id}>
              <button onMouseEnter={() => setActive(i)} onClick={c.run}
                className={`flex h-9 w-full items-center justify-between rounded-md px-3 text-left ${i === active ? "bg-subtle text-ink" : "text-ink-2"}`}>
                {c.label}
                {c.hint && <span className="font-mono text-[11px] text-ink-3">{c.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
