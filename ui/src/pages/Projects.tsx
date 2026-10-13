import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ConnectSteps, KeyReveal } from "../components/Connect";
import { Icon } from "../components/icons";
import { Empty, ErrorBox, PageHeader, Spinner, controlCls } from "../components/ui";
import { api, apiPost, type Project, type ProjectList, type ProjectWithKey } from "../lib/api";
import { fmtCost, fmtNum, timeAgo } from "../lib/format";
import { pp } from "../lib/project";

/** Home: every AI application being monitored, each with its blueprint, traces and experiments. */
export function Projects() {
  const list = useQuery({ queryKey: ["projects"], queryFn: () => api<ProjectList>("/api/projects"), refetchInterval: 30_000 });
  const [creating, setCreating] = useState<{ adopt?: string } | null>(null);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Projects" meta="One project per AI application — its blueprint, traces and experiments">
        <button onClick={() => setCreating({})} className="h-7 rounded-md bg-ink px-3 text-[12.5px] font-medium text-bg">New project</button>
      </PageHeader>
      {list.isError ? <ErrorBox error={list.error} /> : list.isPending ? <Spinner /> : (
        <>
          {list.data.projects.length === 0 ? (
            <Empty title="No projects yet" hint="Create a project, then point your app at it with the project key."
              action={<button onClick={() => setCreating({})} className="text-accent hover:underline">Create one</button>} />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {list.data.projects.map((p) => <ProjectCard key={p.id} p={p} />)}
            </div>
          )}
          {list.data.unclaimed.length > 0 && (
            <div className="mt-8">
              <div className="mb-2 text-[12.5px] font-medium">Data without a project</div>
              <p className="mb-2 text-[12px] text-ink-3">Apps sending with the server-wide key land under their service name. Make one a project to keep its history.</p>
              <div className="overflow-hidden rounded-lg border border-line">
                {list.data.unclaimed.map((u) => (
                  <div key={u.id} className="flex items-center gap-3 border-b border-line/70 px-3 py-2 last:border-0">
                    <span className="font-mono text-[12.5px]">{u.id}</span>
                    <span className="num text-[12px] text-ink-3">{fmtNum(u.runs_total)} runs{u.last_trace ? ` · last ${timeAgo(u.last_trace)}` : ""}</span>
                    <button onClick={() => setCreating({ adopt: u.id })} className="ml-auto text-[12.5px] text-accent hover:underline">Make it a project</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      {creating && <NewProject adopt={creating.adopt} onClose={() => setCreating(null)} />}
    </div>
  );
}

function ProjectCard({ p }: { p: Project }) {
  const live = p.last_trace && Date.now() - new Date(p.last_trace + (p.last_trace.endsWith("Z") ? "" : "Z")).getTime() < 3_600_000;
  return (
    <Link to={pp("/", p.id)} className="group flex flex-col rounded-xl border border-line bg-bg p-4 hover:border-line-strong">
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-subtle text-[13px] font-semibold text-ink-2">
          {p.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-semibold text-ink">{p.name}</div>
          <div className="truncate font-mono text-[11px] text-ink-3">{p.id}</div>
        </div>
        <Icon.chevronRight size={14} className="ml-auto text-ink-3 opacity-0 group-hover:opacity-100" />
      </div>
      {p.description && <p className="mt-2 line-clamp-2 text-[12.5px] text-ink-2">{p.description}</p>}
      <div className="num mt-3 grid grid-cols-3 gap-2 text-[11.5px]">
        <Fig label="Runs 24h" value={fmtNum(p.runs_24h ?? 0)} />
        <Fig label="Cost 24h" value={fmtCost(p.cost_24h ?? 0)} />
        <Fig label="Errors 24h" value={fmtNum(p.errors_24h ?? 0)} tone={(p.errors_24h ?? 0) > 0 ? "text-critical" : undefined} />
      </div>
      <div className="mt-3 flex items-center gap-1.5 border-t border-line/70 pt-2.5 text-[11.5px] text-ink-3">
        <span className={`size-1.5 rounded-full ${live ? "bg-good" : "bg-ink-3/40"}`} />
        {p.last_trace ? `Last trace ${timeAgo(p.last_trace)}` : "No traces yet"}
        {p.services && p.services.length > 0 && <span className="ml-auto truncate font-mono" title={p.services.join(", ")}>{p.services.join(", ")}</span>}
      </div>
    </Link>
  );
}

function Fig({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-ink-3">{label}</div>
      <div className={`text-[13px] font-semibold ${tone ?? "text-ink"}`}>{value}</div>
    </div>
  );
}

function NewProject({ onClose, adopt }: { onClose: () => void; adopt?: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(adopt ?? "");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () => apiPost<ProjectWithKey>("/api/projects", { name, description, adopt: adopt ?? null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
  const made = create.data;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/20 px-4 py-[8vh] dark:bg-black/50" onClick={onClose}>
      <div className="w-full max-w-xl rounded-xl border border-line bg-bg shadow-[0_24px_64px_-16px_rgb(0_0_0/0.35)]" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center border-b border-line px-5 py-3.5">
          <h2 className="text-[14px] font-semibold">{made ? `${made.name} is ready` : adopt ? "Make it a project" : "New project"}</h2>
          <button onClick={onClose} className="ml-auto text-ink-3 hover:text-ink"><Icon.close size={15} /></button>
        </header>
        {!made ? (
          <div className="space-y-4 px-5 py-5">
            {adopt && <p className="text-[12.5px] text-ink-3">Keeps everything already stored as <span className="font-mono text-ink">{adopt}</span>.</p>}
            <label className="block">
              <span className="mb-1.5 block text-[12.5px] font-medium">Name</span>
              <input autoFocus className={`${controlCls} w-full`} placeholder="e.g. Bosun" value={name} onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && name.trim() && create.mutate()} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12.5px] font-medium">Description <span className="font-normal text-ink-3">(optional)</span></span>
              <input className={`${controlCls} w-full`} placeholder="What this app does" value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            {create.isError && <p className="text-critical">{(create.error as Error).message}</p>}
          </div>
        ) : (
          <div className="space-y-4 px-5 py-5">
            <KeyReveal apiKey={made.key} />
            <ConnectSteps apiKey={made.key} />
          </div>
        )}
        <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          {!made ? (
            <>
              <button onClick={onClose} className="h-8 rounded-md px-3 text-ink-2 hover:bg-subtle">Cancel</button>
              <button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}
                className="h-8 rounded-md bg-ink px-3.5 font-medium text-bg disabled:opacity-40">{create.isPending ? "Creating…" : "Create project"}</button>
            </>
          ) : (
            <button onClick={() => navigate(pp("/", made.id))} className="h-8 rounded-md bg-ink px-3.5 font-medium text-bg">Open project</button>
          )}
        </footer>
      </div>
    </div>
  );
}
