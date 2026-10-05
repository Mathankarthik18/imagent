import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { api, getReadKey, setReadKey } from "../lib/api";
import { parseTime, timeAgo } from "../lib/format";
import { isTyping } from "../lib/keys";
import { useAppState, useLatest } from "../lib/state";
import { CommandPalette } from "./CommandPalette";
import { Icon } from "./icons";
import { RangePicker } from "./RangePicker";
import { controlCls } from "./ui";

const NAV = [
  { to: "/", label: "Overview", icon: Icon.overview, key: "o" },
  { to: "/traces", label: "Traces", icon: Icon.traces, key: "t" },
];

export function Layout() {
  const { project, setProject, refresh, autoRefresh, setAutoRefresh, theme, toggleTheme, range } = useAppState();
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api<string[]>("/api/projects") });
  const [keyOpen, setKeyOpen] = useState(false);
  const navigate = useNavigate();

  // "g" then o / t / h — quick page switching.
  useEffect(() => {
    let pending = 0;
    const on = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "g") {
        pending = Date.now();
        return;
      }
      if (Date.now() - pending < 1000) {
        const hit = NAV.find((n) => n.key === e.key);
        if (hit) navigate(hit.to);
        pending = 0;
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [navigate]);

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-[200px] shrink-0 flex-col border-r border-line bg-panel md:flex">
        <div className="flex h-12 items-center gap-2 px-4">
          <span className="grid size-5 place-items-center rounded-[5px] bg-ink text-bg">
            <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M4.5 12V4M11.5 12V4M4.5 8h7" /></svg>
          </span>
          <span className="text-[13.5px] font-semibold tracking-[-0.01em]">harness</span>
        </div>
        <nav className="flex flex-col gap-px px-2 pt-1">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === "/"}
              className={({ isActive }) =>
                `group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] ${isActive ? "bg-subtle font-medium text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"}`}>
              {({ isActive }) => (
                <>
                  <n.icon size={15} className={isActive ? "text-ink" : "text-ink-3"} />
                  {n.label}
                  <span className="ml-auto hidden font-mono text-[10.5px] text-ink-3 group-hover:inline">g {n.key}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-px p-2">
          <button onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
            className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-ink-2 hover:bg-hover hover:text-ink">
            <Icon.search size={15} className="text-ink-3" /> Jump to… <kbd className="ml-auto">⌘K</kbd>
          </button>
          <button onClick={() => setKeyOpen(true)} className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-ink-2 hover:bg-hover hover:text-ink">
            <Icon.key size={15} className="text-ink-3" /> Access key
            {getReadKey() && <Icon.check size={13} className="ml-auto text-good" />}
          </button>
          <button onClick={toggleTheme} className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-ink-2 hover:bg-hover hover:text-ink">
            {theme === "dark" ? <Icon.sun size={15} className="text-ink-3" /> : <Icon.moon size={15} className="text-ink-3" />}
            {theme === "dark" ? "Light theme" : "Dark theme"}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4 md:px-6">
          <nav className="flex gap-1 md:hidden">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === "/"}
                className={({ isActive }) => `rounded px-2 py-1 ${isActive ? "font-medium text-ink" : "text-ink-3"}`}>{n.label}</NavLink>
            ))}
          </nav>
          <select aria-label="Project" value={project} onChange={(e) => setProject(e.target.value)}
            className={`ghost ${controlCls} border-transparent bg-transparent font-medium hover:border-line`}>
            <option value="">All projects</option>
            {(projects.data ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <div className="ml-auto flex items-center gap-2">
            <LastData />
            <RangePicker />
            <button onClick={refresh} title="Refresh" className="inline-flex size-7 items-center justify-center rounded-md border border-line text-ink-2 hover:border-line-strong hover:text-ink">
              <Icon.refresh size={14} />
            </button>
            <button role="switch" aria-checked={autoRefresh} disabled={range.kind === "custom"} onClick={() => setAutoRefresh(!autoRefresh)}
              title={range.kind === "custom" ? "Live updates need a relative range" : "Refresh every 15 s"}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12.5px] disabled:opacity-40 ${autoRefresh ? "border-accent/40 text-accent" : "border-line text-ink-2 hover:border-line-strong"}`}>
              <span className={`size-1.5 rounded-full ${autoRefresh ? "animate-pulse bg-accent" : "bg-ink-3/60"}`} />
              Live
            </button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-auto px-4 py-5 md:px-6">
          <Outlet />
        </main>
      </div>

      <CommandPalette />
      {keyOpen && <KeyDialog onClose={() => setKeyOpen(false)} />}
    </div>
  );
}

/** "last trace 4m ago" — makes an empty window read as quiet, not broken. */
function LastData() {
  const latest = useLatest();
  if (latest.isError) {
    return <span className="hidden items-center gap-1.5 text-[12px] text-critical sm:inline-flex"><span className="size-1.5 rounded-full bg-critical" />server unreachable</span>;
  }
  const last = latest.data?.last_seen;
  if (!last) return null;
  const fresh = Date.now() - parseTime(last).getTime() < 5 * 60_000;
  return (
    <span className="hidden items-center gap-1.5 text-[12px] text-ink-3 sm:inline-flex" title={parseTime(last).toLocaleString()}>
      <span className={`size-1.5 rounded-full ${fresh ? "bg-good" : "bg-ink-3/60"}`} />
      last trace {timeAgo(last)}
    </span>
  );
}

function KeyDialog({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState(getReadKey());
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/20 p-4 dark:bg-black/50" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl border border-line bg-bg p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-semibold">Read access key</h2>
        <p className="mt-1 text-ink-3">Only needed when the server sets <code className="font-mono text-[12px]">HARNESS_READ_KEY</code>. Kept in this browser.</p>
        <input className={`${controlCls} mt-3 h-8 w-full`} type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        <div className="mt-4 flex justify-end gap-2">
          <button className="h-7 rounded-md px-3 text-ink-2 hover:bg-subtle" onClick={onClose}>Cancel</button>
          <button className="h-7 rounded-md bg-ink px-3 font-medium text-bg" onClick={() => { setReadKey(value.trim()); window.location.reload(); }}>Save</button>
        </div>
      </div>
    </div>
  );
}
