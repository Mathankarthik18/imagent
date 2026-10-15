import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { controlCls } from "./ui";

/** A model to offer: from this project's traces ("used") or the price catalog. */
export interface ModelOption { id: string; group: "used" | "catalog"; note?: string }

const MAX_USED = 8;
const MAX_CATALOG = 40;

/** Searchable model combobox: your project's models first, then the catalog with prices.
 *  Typing any id still works (Enter keeps what you typed). */
export function ModelPicker({ value, onChange, options, placeholder = "Search or type a model id", autoFocus, className = "" }: {
  value: string; onChange: (v: string) => void; options: ModelOption[]; placeholder?: string; autoFocus?: boolean; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const q = value.trim().toLowerCase();
  const results = useMemo(() => {
    const match = (o: ModelOption) => !q || o.id.toLowerCase().includes(q);
    const used = options.filter((o) => o.group === "used" && match(o)).slice(0, MAX_USED);
    const seen = new Set(used.map((o) => o.id));
    const catalog = options.filter((o) => o.group === "catalog" && !seen.has(o.id) && match(o)).slice(0, MAX_CATALOG);
    return [...used, ...catalog];
  }, [options, q]);
  const choose = (id: string) => { onChange(id); setOpen(false); };

  return (
    <div ref={box} className={`relative ${className}`}
      onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <input autoFocus={autoFocus} className={`${controlCls} h-8 w-full font-mono text-[12.5px]`} value={value} placeholder={placeholder}
        role="combobox" aria-expanded={open} aria-autocomplete="list"
        onFocus={() => setOpen(true)}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, results.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Enter") { e.preventDefault(); if (open && results[active] && q !== results[active].id.toLowerCase()) choose(results[active].id); else setOpen(false); }
          else if (e.key === "Escape") setOpen(false);
        }} />
      {open && results.length > 0 && (
        <div role="listbox" className="absolute right-0 top-9 z-30 max-h-72 w-full min-w-[420px] overflow-auto rounded-lg border border-line bg-bg py-1 shadow-[0_12px_32px_-8px_rgb(0_0_0/0.3)]">
          {results.map((o, i) => (
            <div key={`${o.group}:${o.id}`}>
              {(i === 0 || results[i - 1].group !== o.group) && (
                <div className="px-3 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-ink-3">
                  {o.group === "used" ? "Used in this project" : "All models"}
                </div>
              )}
              <button type="button" role="option" aria-selected={i === active} tabIndex={-1}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o.id)}
                className={`flex w-full items-center gap-3 px-3 py-1 text-left ${i === active ? "bg-hover" : ""}`}>
                <span className="truncate font-mono text-[12px] text-ink">{o.id}</span>
                {o.note && <span className="num ml-auto shrink-0 text-[11px] text-ink-3">{o.note}</span>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Models to offer in a project: the ones its traces use (most used first), then the price catalog. */
export function useModelOptions(project: string, extra: string[] = []): ModelOption[] {
  const q = useQuery({ queryKey: ["models", project], staleTime: 300_000,
    queryFn: () => api<{ used: { model: string; calls: number }[]; catalog: { id: string; input: number; output: number }[] }>("/api/models", { project }) });
  const extraKey = extra.join("|");
  return useMemo(() => {
    const seen = new Set<string>();
    const out: ModelOption[] = [];
    for (const u of q.data?.used ?? []) { seen.add(u.model); out.push({ id: u.model, group: "used", note: `${u.calls.toLocaleString()} calls` }); }
    for (const m of extra) if (m && !seen.has(m)) { seen.add(m); out.push({ id: m, group: "used" }); }
    const price = (n: number) => (n < 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(n < 10 ? 1 : 0)}`);
    for (const c of q.data?.catalog ?? []) out.push({ id: c.id, group: "catalog", note: `${price(c.input)} / ${price(c.output)} per 1M` });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, extraKey]);
}
