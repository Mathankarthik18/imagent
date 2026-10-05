import { useInfiniteQuery } from "@tanstack/react-query";
import { api, type Page, type RunningRun, type ThreadGroup } from "../lib/api";
import { useListKeys } from "../lib/keys";
import { EmptyWindow } from "./EmptyWindow";
import { ThreadList } from "./ThreadList";
import { ErrorBox, Spinner } from "./ui";

const PAGE = 50;
type Params = Record<string, string | number | undefined>;

/** Traces grouped by thread — one row per thread; opening is the caller's job. */
export function ThreadGroups({ params, sort, filtered, onClear, onOpen, keysEnabled = true, running }: {
  params: Params; sort: string; filtered: boolean; onClear: () => void;
  onOpen: (g: ThreadGroup) => void; keysEnabled?: boolean; running?: Map<string, RunningRun>;
}) {
  const groups = useInfiniteQuery({
    queryKey: ["traces-by-thread", params, sort],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api<Page<ThreadGroup>>("/api/traces/by-thread", { ...params, sort, limit: PAGE, offset: pageParam }),
    getNextPageParam: (last, pages) => (last.has_more ? pages.length * PAGE : undefined),
  });
  const items = groups.data?.pages.flatMap((p) => p.items) ?? [];
  const [active, setActive] = useListKeys(items.length, (i) => onOpen(items[i]), keysEnabled);

  if (groups.isError) return <ErrorBox error={groups.error} />;
  if (groups.isPending) return <Spinner />;
  if (items.length === 0) return <EmptyWindow what="traces" filtered={filtered} onClear={onClear} />;
  return (
    <>
      <ThreadList items={items} active={active} running={running} onOpen={(g, i) => { setActive(i); onOpen(g); }} />
      {groups.hasNextPage && (
        <button className="w-full py-3 text-center text-ink-2 hover:text-ink" onClick={() => groups.fetchNextPage()}>
          {groups.isFetchingNextPage ? "Loading…" : "Load more threads"}
        </button>
      )}
    </>
  );
}
