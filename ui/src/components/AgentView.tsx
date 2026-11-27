import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiText } from "../lib/api";
import { pp } from "../lib/project";
import { Icon } from "./icons";
import { ErrorBox, Spinner } from "./ui";

type Kind = "trace" | "issue";
const NOUN: Record<Kind, string> = { trace: "run", issue: "issue" };

/** The link a coding agent should open: the same page with ?view=agent. */
export function agentViewUrl(kind: Kind, id: string): string {
  return `${window.location.origin}${pp(`/${kind}s/${id}`)}?view=agent`;
}

function prompt(kind: Kind, id: string): string {
  const url = agentViewUrl(kind, id);
  return kind === "trace"
    ? `Read this imagent run and fix the root cause in this repo. The whole run — request, final answer, failed steps with stack traces, every tool call, and the issue and diagnosis it belongs to — is on one page: ${url}`
    : `Read this imagent issue and fix it in this repo. The issue, its diagnosis and suggested fix, the affected runs, and the latest run in full are on one page: ${url}`;
}

async function copy(text: string, done: () => void) {
  try {
    await navigator.clipboard.writeText(text);
    done();
  } catch {
    window.prompt("Copy this:", text);
  }
}

/** The run or issue as one plain-text page, for a coding agent to read in one go. */
export function AgentViewPage({ kind, id }: { kind: Kind; id: string }) {
  const [copied, setCopied] = useState<"" | "all" | "prompt">("");
  const q = useQuery({
    queryKey: ["agent-view", kind, id],
    queryFn: () => apiText(`/api/${kind}s/${id}/agent-view?base=${encodeURIComponent(window.location.origin)}`),
  });
  const flash = (what: "all" | "prompt") => () => { setCopied(what); setTimeout(() => setCopied(""), 1500); };
  const btn = "inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2.5 text-[12.5px] text-ink-2 hover:border-line-strong hover:text-ink";
  return (
    <div className="mx-auto max-w-[1100px]">
      <nav className="mb-2 text-[12.5px] text-ink-3">
        <Link to={pp(`/${kind}s/${id}`)} className="hover:text-ink">← Back to the {NOUN[kind]}</Link>
      </nav>
      <div className="mb-4 flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-[17px] font-semibold text-ink">Agent view</h1>
          <p className="mt-1 max-w-[80ch] text-[12.5px] leading-5 text-ink-3">
            This {NOUN[kind]} as one plain-text page, made for AI coding agents such as Claude Code: everything that matters,
            readable in one go without clicking through steps. Give your agent this page's link, or copy the text.
          </p>
        </div>
        <div className="flex gap-2">
          <button className={btn} disabled={!q.data} onClick={() => q.data && copy(q.data, flash("all"))}>
            {copied === "all" ? <Icon.check size={12} /> : <Icon.copy size={12} />} {copied === "all" ? "Copied" : "Copy all text"}
          </button>
          <button className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink px-2.5 text-[12.5px] font-medium text-bg"
            onClick={() => copy(prompt(kind, id), flash("prompt"))}>
            {copied === "prompt" ? <Icon.check size={12} /> : <Icon.copy size={12} />} {copied === "prompt" ? "Copied" : "Copy prompt for coding agent"}
          </button>
        </div>
      </div>
      {q.isError ? <ErrorBox error={q.error} /> : !q.data ? <Spinner /> : (
        <pre data-agent-view className="whitespace-pre-wrap break-words rounded-lg border border-line bg-subtle/40 px-5 py-4 font-mono text-[12.5px] leading-5 text-ink">{q.data}</pre>
      )}
    </div>
  );
}

/** "For coding agent" on a run or issue page: copy a ready prompt, or open the agent view. */
export function AgentHandoff({ kind, id }: { kind: Kind; id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-stretch overflow-hidden rounded-md border border-line text-[12px]">
      <button onClick={() => copy(prompt(kind, id), () => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
        title={`Copy a prompt with a link that gives a coding agent (e.g. Claude Code) this whole ${NOUN[kind]} in one page`}
        className="inline-flex h-7 items-center gap-1.5 px-2.5 text-ink-2 hover:bg-subtle hover:text-ink">
        {copied ? <Icon.check size={12} /> : <Icon.copy size={12} />} {copied ? "Copied" : "For coding agent"}
      </button>
      <Link to={`${pp(`/${kind}s/${id}`)}?view=agent`} title="Open the agent view"
        className="inline-flex h-7 items-center border-l border-line px-2 text-ink-3 hover:bg-subtle hover:text-ink">
        <Icon.external size={11} />
      </Link>
    </span>
  );
}

/** Read by agents that land on the normal page (screen readers and page-text tools see it; people don't). */
export function AgentPointer({ kind, id }: { kind: Kind; id: string }) {
  return (
    <p className="sr-only">
      Note for AI coding agents: this page shows one step at a time. The whole {NOUN[kind]} — every step, failed steps with
      inputs, outputs and stack traces, tool calls, and the issue diagnosis — is on one plain-text page: {agentViewUrl(kind, id)}
    </p>
  );
}
