import type { ReactNode } from "react";
import { Icon, KindIcon } from "./icons";

export { KindIcon };

/** Leading status glyph for list rows: quiet when fine, red when not. */
export function StatusMark({ errors, className = "" }: { errors: number; className?: string }) {
  return errors > 0
    ? <span className={`inline-flex text-critical ${className}`} title={`${errors} failed span${errors > 1 ? "s" : ""}`}><Icon.x size={14} /></span>
    : <span className={`inline-flex size-3.5 items-center justify-center ${className}`} title="OK"><span className="size-1.5 rounded-full bg-ink-3/50" /></span>;
}

/** Inline failure count for tables ("2 failed" in red, "—" otherwise). */
export function Failures({ n, of }: { n: number; of?: number }) {
  if (!n) return <span className="text-ink-3">—</span>;
  return <span className="text-critical">{n}{of ? <span className="text-ink-3"> / {of}</span> : null} failed</span>;
}

export function Section({ title, actions, children, className = "" }: {
  title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={className}>
      {(title || actions) && (
        <div className="mb-2 flex h-7 items-center justify-between gap-2">
          <h2 className="text-[12px] font-medium text-ink-2">{title}</h2>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/** Bordered container — used sparingly, for panels that need a frame (trees, details). */
export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-line bg-panel ${className}`}>{children}</div>;
}

export function Empty({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="px-6 py-16 text-center">
      <p className="text-ink-2">{title}</p>
      {hint && <p className="mx-auto mt-1 max-w-md text-ink-3">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-6 py-16 text-ink-3">
      <span className="size-3 animate-spin rounded-full border-[1.5px] border-line-strong border-t-ink-2" />
      {label}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="my-4 rounded-md border border-critical/30 px-3 py-2 text-critical">
      Couldn't load this view — {msg}
    </div>
  );
}

export function PageHeader({ title, meta, children }: { title: ReactNode; meta?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-4 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
      <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink">{title}</h1>
      {meta && <span className="num text-ink-3">{meta}</span>}
      {children && <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export const controlCls =
  "h-7 rounded-md border border-line bg-bg px-2 text-[12.5px] text-ink placeholder:text-ink-3 outline-none hover:border-line-strong focus:border-accent focus:ring-[3px] focus:ring-accent-soft";

export function Select({ value, onChange, options, placeholder, label }: {
  value: string; onChange: (v: string) => void; options: string[]; placeholder: string; label?: string;
}) {
  return (
    <select aria-label={label ?? placeholder} value={value} onChange={(e) => onChange(e.target.value)}
      className={`ghost ${controlCls} max-w-56 ${value ? "border-line-strong text-ink" : "text-ink-2"}`}>
      <option value="">{placeholder}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: { id: T; label: string }[];
}) {
  return (
    <div className="inline-flex h-7 items-center rounded-md bg-subtle p-0.5" role="tablist">
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={value === o.id} onClick={() => onChange(o.id)}
          className={`h-6 rounded-[5px] px-2.5 text-[12px] font-medium ${value === o.id ? "bg-bg text-ink shadow-[0_0_0_1px_var(--border)]" : "text-ink-3 hover:text-ink-2"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Button({ children, onClick, title, variant = "ghost", className = "" }: {
  children: ReactNode; onClick?: () => void; title?: string; variant?: "ghost" | "primary"; className?: string;
}) {
  const v = variant === "primary"
    ? "bg-ink text-bg hover:opacity-90 border-transparent"
    : "border-line bg-bg text-ink-2 hover:border-line-strong hover:text-ink";
  return (
    <button title={title} onClick={onClick} className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12.5px] font-medium ${v} ${className}`}>
      {children}
    </button>
  );
}

/** One horizontal strip of figures separated by hairlines — replaces tile grids. */
export function StatStrip({ items }: { items: { label: string; value: ReactNode; sub?: ReactNode; tone?: "critical" }[] }) {
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-line sm:grid-cols-3 lg:flex">
      {items.map((it, i) => (
        <div key={it.label} className={`min-w-0 flex-1 px-4 py-3 ${i ? "border-line lg:border-l" : ""} max-lg:border-b max-lg:border-r`}>
          <div className="text-[11.5px] text-ink-3">{it.label}</div>
          <div className={`num mt-1 text-[17px] font-semibold tracking-[-0.01em] ${it.tone === "critical" ? "text-critical" : "text-ink"}`}>{it.value}</div>
          {it.sub && <div className="num mt-0.5 truncate text-[11.5px] text-ink-3">{it.sub}</div>}
        </div>
      ))}
    </div>
  );
}

export function CopyId({ value, display, className = "text-[12px] text-ink-2" }: { value: string; display?: string; className?: string }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(value); }}
      className={`group inline-flex min-w-0 items-center gap-1 font-mono hover:text-ink ${className}`} title={`Copy ${value}`}>
      {display ?? value}
      <Icon.copy size={12} className="opacity-0 group-hover:opacity-60" />
    </button>
  );
}

/** Table header cell / row helpers so every list shares one rhythm. */
export const th = "sticky top-0 z-[1] h-8 bg-bg px-3 text-left text-[11.5px] font-medium text-ink-3 border-b border-line whitespace-nowrap";
export const td = "px-3 py-2 align-middle";
export function rowCls(active: boolean) {
  return `group cursor-pointer border-b border-line/70 ${active ? "bg-accent-soft/60 shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-hover"}`;
}
