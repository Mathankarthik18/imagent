import { useState } from "react";
import { Icon } from "./icons";

function Copyable({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="group relative">
      {label && <div className="mb-1 text-[12px] text-ink-3">{label}</div>}
      <pre className="overflow-x-auto rounded-md border border-line bg-panel px-3 py-2 pr-16 font-mono text-[12px] leading-[1.6] text-ink">{text}</pre>
      <button onClick={() => navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); })}
        className="absolute right-2 top-[calc(100%-2.1rem)] inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-ink-3 hover:bg-subtle hover:text-ink">
        {done ? <Icon.check size={12} /> : <Icon.copy size={12} />} {done ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** How to point an app at a project: install, one key, one line. */
export function ConnectSteps({ apiKey }: { apiKey?: string }) {
  const endpoint = window.location.origin;
  const env = `IMAGENT_API_KEY=${apiKey ?? "<project key>"}` + (endpoint === "http://localhost:8300" ? "" : `\nIMAGENT_ENDPOINT=${endpoint}`);
  return (
    <div className="space-y-3">
      <Copyable label="1 · Install into your app's virtualenv (not the system Python)"
        text={"pip install -e ~/imagent-monitor/sdk\n# uv-made venv without pip:\nuv pip install -p .venv/bin/python -e ~/imagent-monitor/sdk"} />
      <Copyable label="2 · Add to your .env" text={env} />
      <Copyable label="3 · Add at app startup" text={"import imagent\nimagent.init()"} />
      <p className="text-[12px] text-ink-3">That's it. Works with LangChain / LangGraph / deepagents, the OpenAI Agents SDK, LlamaIndex, CrewAI, and plain OpenAI / Anthropic SDK calls — every run is traced, and each agent's blueprint appears on its first run.</p>
    </div>
  );
}

/** The one-time key reveal shown after creating a project or rotating its key. */
export function KeyReveal({ apiKey }: { apiKey: string }) {
  return (
    <div className="rounded-lg border border-[#b4620b]/30 bg-[#b4620b]/[0.06] px-3 py-2.5">
      <div className="text-[12.5px] font-medium text-ink">Project API key — copy it now</div>
      <p className="mb-2 text-[12px] text-ink-3">It's stored hashed and won't be shown again. Lost it? Rotate the key in Settings.</p>
      <Copyable text={apiKey} />
    </div>
  );
}
