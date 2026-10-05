import { useEffect, useRef, useState } from "react";
import { RANGES, useAppState } from "../lib/state";
import { Icon } from "./icons";
import { controlCls } from "./ui";

function toLocalInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function RangePicker() {
  const { range, setRange, rangeLabel, window: win, timeMode, toggleTimeMode } = useAppState();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(() => toLocalInput(win.start));
  const [to, setTo] = useState(() => toLocalInput(win.end));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setFrom(toLocalInput(win.start));
    setTo(toLocalInput(win.end));
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const valid = from && to && new Date(from) < new Date(to);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-[12.5px] text-ink-2 hover:border-line-strong hover:text-ink">
        <Icon.clock size={13} />
        <span className="max-w-64 truncate">{rangeLabel}</span>
        <Icon.chevronDown size={13} className="text-ink-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-50 w-72 rounded-lg border border-line bg-bg p-1 shadow-[0_12px_32px_-8px_rgb(0_0_0/0.2)]">
          {RANGES.map((r) => {
            const active = range.kind === "preset" && range.id === r.id;
            return (
              <button key={r.id} onClick={() => { setRange({ kind: "preset", id: r.id }); setOpen(false); }}
                className={`flex h-8 w-full items-center justify-between rounded-md px-2.5 text-left ${active ? "bg-subtle text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"}`}>
                {r.label}
                <span className="font-mono text-[11px] text-ink-3">{r.short}</span>
              </button>
            );
          })}
          <div className="my-1 border-t border-line" />
          <div className="space-y-1.5 px-2.5 py-2">
            <div className="text-[11.5px] text-ink-3">Custom range</div>
            <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className={`${controlCls} w-full`} aria-label="From" />
            <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className={`${controlCls} w-full`} aria-label="To" />
            <button disabled={!valid}
              onClick={() => { setRange({ kind: "custom", start: new Date(from).toISOString(), end: new Date(to).toISOString() }); setOpen(false); }}
              className="h-7 w-full rounded-md bg-ink text-[12.5px] font-medium text-bg disabled:opacity-40">
              Apply
            </button>
          </div>
          <div className="my-1 border-t border-line" />
          <button onClick={toggleTimeMode} className="flex h-8 w-full items-center justify-between rounded-md px-2.5 text-ink-2 hover:bg-hover hover:text-ink">
            Show times as
            <span className="text-ink">{timeMode === "relative" ? "relative" : "absolute"}</span>
          </button>
        </div>
      )}
    </div>
  );
}
