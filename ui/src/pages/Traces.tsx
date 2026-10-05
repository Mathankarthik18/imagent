import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { EmptyWindow } from "../components/EmptyWindow";
import { RunningStrip } from "../components/Live";
import { Icon } from "../components/icons";
import { ThreadPeek, TracePeek } from "../components/Peek";
import { ThreadGroups } from "../components/ThreadGroups";
import { TraceTable } from "../components/TraceTable";
import { controlCls, ErrorBox, PageHeader, Segmented, Select, Spinner } from "../components/ui";
import { api, NO_THREAD, THREAD_SORTS, type Facets, type Page, type ThreadGroup, type TraceSummary } from "../lib/api";
import { useHotkey, useListKeys } from "../lib/keys";
import { useRunning } from "../lib/live";
import { useBaseParams } from "../lib/state";

const PAGE = 50;
const FILTER_KEYS = ["q", "status", "model", "agent", "tag", "name", "user_id", "thread_id"] as const;

export function Traces() {
  const base = useBaseParams();
  const [params, setParams] = useSearchParams();
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ""])) as Record<(typeof FILTER_KEYS)[number], string>;
  // Threads first: one row per conversation; "All runs" shows every run flat.
  const view = params.get("view") === "list" ? "list" : "thread";
  const peekThread = params.get("thread");
  const sort = params.get("sort") ?? "recent";
  const peek = params.get("peek");
  const [search, setSearch] = useState(filters.q);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => setSearch(filters.q), [filters.q]);
  useHotkey("/", (e) => { e.preventDefault(); searchRef.current?.focus(); });

  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const openPeek = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("peek", id);
    setParams(next);
  };
  const closePeek = () => set({ peek: "" });
  const openThread = (g: ThreadGroup) => {
    const next = new URLSearchParams(params);
    if (g.thread_id) next.set("thread", g.thread_id);
    else {
      next.set("view", "list");
      next.set("thread_id", NO_THREAD);
    }
    setParams(next);
  };

  const live = useRunning();
  const facets = useQuery({ queryKey: ["facets", base], queryFn: () => api<Facets>("/api/facets", base) });
  const traces = useInfiniteQuery({
    enabled: view === "list",
    queryKey: ["traces", base, filters],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api<Page<TraceSummary>>("/api/traces", { ...base, ...filters, limit: PAGE, offset: pageParam }),
    getNextPageParam: (last, pages) => (last.has_more ? pages.length * PAGE : undefined),
  });
  const items = traces.data?.pages.flatMap((p) => p.items) ?? [];
  const [active, setActive] = useListKeys(items.length, (i) => openPeek(items[i].trace_id), view === "list" && !peek && !peekThread);
  const filtered = FILTER_KEYS.some((k) => filters[k]);
  const clearFilters = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, ""])));
  const count = traces.data ? `${items.length}${traces.hasNextPage ? "+" : ""}` : undefined;

  return (
    <>
      <PageHeader title="Traces" meta={view === "list" ? count : undefined}>
        {view === "thread" && (
          <select aria-label="Sort threads" value={sort} onChange={(e) => set({ sort: e.target.value === "recent" ? "" : e.target.value })}
            className={`ghost ${controlCls} text-ink-2`}>
            {THREAD_SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        )}
        <Segmented value={view} onChange={(v) => set({ view: v === "thread" ? "" : v })}
          options={[{ id: "thread", label: "By thread" }, { id: "list", label: "All runs" }]} />
      </PageHeader>

      <RunningStrip onOpen={(r) => openPeek(r.trace_id)} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <form onSubmit={(e) => { e.preventDefault(); set({ q: search.trim() }); searchRef.current?.blur(); }} className="relative">
          <Icon.search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3" />
          <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search inputs, outputs, ids"
            onKeyDown={(e) => e.key === "Escape" && (e.currentTarget.blur(), setSearch(filters.q))}
            className={`${controlCls} w-72 pl-7 pr-7`} />
          {!search && <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">/</kbd>}
        </form>
        <Select value={filters.status} onChange={(v) => set({ status: v })} options={["error"]} placeholder="Status" label="Status" />
        <Select value={filters.name} onChange={(v) => set({ name: v })} options={facets.data?.root_names ?? []} placeholder="Entry point" />
        <Select value={filters.agent} onChange={(v) => set({ agent: v })} options={facets.data?.agents ?? []} placeholder="Agent" />
        <Select value={filters.model} onChange={(v) => set({ model: v })} options={facets.data?.models ?? []} placeholder="Model" />
        {(facets.data?.tags.length ?? 0) > 0 && <Select value={filters.tag} onChange={(v) => set({ tag: v })} options={facets.data?.tags ?? []} placeholder="Tag" />}
        {filters.thread_id && (
          <button onClick={() => set({ thread_id: "" })}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong px-2 text-[12.5px] text-ink">
            {filters.thread_id === NO_THREAD ? "Without a thread" : `Thread ${filters.thread_id.slice(0, 12)}`}
            <Icon.close size={12} className="text-ink-3" />
          </button>
        )}
        {filtered && <button className="text-[12.5px] text-ink-3 hover:text-ink" onClick={clearFilters}>Clear</button>}
        {view === "list" && items.length > 0 && (
          <span className="ml-auto hidden text-[11.5px] text-ink-3 lg:inline"><kbd>j</kbd> <kbd>k</kbd> move · <kbd>↵</kbd> open</span>
        )}
      </div>

      {view === "thread" ? (
        <ThreadGroups params={{ ...base, ...filters }} sort={sort} filtered={filtered} onClear={clearFilters}
          onOpen={openThread} keysEnabled={!peek && !peekThread} running={live.byThread} />
      ) : traces.isError ? <ErrorBox error={traces.error} /> : traces.isPending ? <Spinner /> : items.length === 0 ? (
        <EmptyWindow what="traces" filtered={filtered} onClear={clearFilters} />
      ) : (
        <>
          <TraceTable items={items} active={active} running={live.byTrace} onOpen={(t, i) => { setActive(i); openPeek(t.trace_id); }} />
          {traces.hasNextPage && (
            <button className="w-full py-3 text-center text-ink-2 hover:text-ink" disabled={traces.isFetchingNextPage} onClick={() => traces.fetchNextPage()}>
              {traces.isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}

      {peekThread && !peek && (
        <ThreadPeek threadId={peekThread} project={base.project} onClose={() => set({ thread: "" })}
          onOpenTrace={(id) => set({ thread: "", peek: id })} />
      )}
      {peek && <TracePeek traceId={peek} onClose={closePeek} />}
    </>
  );
}
