import { useState } from "react";
import { CollapsibleMarkdown } from "./Markdown";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function parsePayload(raw: string): { json: Json | undefined; text: string } {
  if (!raw) return { json: undefined, text: "" };
  try {
    return { json: JSON.parse(raw) as Json, text: raw };
  } catch {
    return { json: undefined, text: raw };
  }
}

interface ChatMessage {
  role: string;
  content: Json;
  name?: string;
  tool_calls?: { id?: string; name?: string; args?: Json }[];
  tool_call_id?: string;
  status?: string;
}

function isMessage(v: Json): v is Json & ChatMessage {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as Record<string, Json>).role === "string" && "content" in v;
}

/** Find a chat transcript inside a payload: a message list, a single message, or {messages: [...]}. */
function asMessages(v: Json | undefined): ChatMessage[] | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v) && v.length > 0 && v.every(isMessage)) return v as unknown as ChatMessage[];
  if (isMessage(v)) return [v as unknown as ChatMessage];
  if (typeof v === "object" && !Array.isArray(v) && Array.isArray(v.messages)) return asMessages(v.messages);
  return null;
}

const ROLE_STYLE: Record<string, string> = {
  system: "text-ink-3",
  user: "text-[#2a78d6] dark:text-[#6da7ec]",
  assistant: "text-[#0f8a5f] dark:text-[#4cc79a]",
  tool: "text-[#c2541f] dark:text-[#ef9a6e]",
};

function ContentView({ content }: { content: Json }) {
  if (typeof content === "string") return <Text text={content} />;
  if (Array.isArray(content)) {
    return (
      <div className="flex flex-col gap-2">
        {content.map((block, i) => {
          if (block && typeof block === "object" && !Array.isArray(block)) {
            if (block.type === "text" && typeof block.text === "string") return <Text key={i} text={block.text} />;
            if (block.type === "thinking" && typeof block.thinking === "string") {
              return <div key={i} className="italic text-ink-3"><Text text={block.thinking} /></div>;
            }
          }
          return <JsonTree key={i} value={block} />;
        })}
      </div>
    );
  }
  return <JsonTree value={content} />;
}

function Text({ text }: { text: string }) {
  return <CollapsibleMarkdown text={text} />;
}

function MessageList({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="divide-y divide-line/70 rounded-md border border-line">
      {messages.map((m, i) => (
        <div key={i} className="px-3 py-2.5">
          <div className="mb-1 flex items-center gap-2 text-[11.5px]">
            <span className={`font-medium capitalize ${ROLE_STYLE[m.role] ?? ROLE_STYLE.system}`}>{m.role}</span>
            {m.name && <span className="font-mono text-ink-3">{m.name}</span>}
            {m.tool_call_id && <span className="font-mono text-ink-3">↳ {m.tool_call_id}</span>}
            {m.status === "error" && <span className="text-critical">error</span>}
          </div>
          {!(m.content === "" && m.tool_calls?.length) && <ContentView content={m.content} />}
          {m.tool_calls?.map((tc, j) => (
            <div key={j} className="mt-2 rounded-md bg-subtle px-2.5 py-2">
              <div className="mb-1 font-mono text-[12px] text-[#c2541f] dark:text-[#ef9a6e]">
                {tc.name}<span className="text-ink-3">()</span> <span className="text-ink-3">{tc.id}</span>
              </div>
              <JsonTree value={tc.args ?? null} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function PayloadView({ raw, empty = "Not captured" }: { raw: string; empty?: string }) {
  const [mode, setMode] = useState<"pretty" | "raw">("pretty");
  const { json, text } = parsePayload(raw);
  if (!raw) return <p className="text-ink-3">{empty}</p>;
  const messages = asMessages(json);
  return (
    <div>
      <div className="-mt-7 mb-2 flex justify-end gap-3 text-[11.5px] text-ink-3">
        <button onClick={() => setMode(mode === "pretty" ? "raw" : "pretty")} className="hover:text-ink">{mode === "pretty" ? "Raw JSON" : "Formatted"}</button>
        <button className="hover:text-ink" onClick={() => navigator.clipboard?.writeText(text)}>Copy</button>
      </div>
      {mode === "raw" ? (
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-subtle p-3 font-mono text-[12px] leading-[1.55] text-ink-2">
          {json !== undefined ? JSON.stringify(json, null, 2) : text}
        </pre>
      ) : messages ? <MessageList messages={messages} />
        : json !== undefined && typeof json === "string" ? <Text text={json} />
        : json !== undefined ? <JsonTree value={json} defaultOpen={2} />
        : <Text text={text} />}
    </div>
  );
}

export function JsonTree({ value, defaultOpen = 1, depth = 0, name }: { value: Json; defaultOpen?: number; depth?: number; name?: string }) {
  const [open, setOpen] = useState(depth < defaultOpen);
  const label = name !== undefined ? <span className="text-ink-3">{name}: </span> : null;

  if (value === null || typeof value !== "object") {
    const cls = typeof value === "string" ? "text-ink" : typeof value === "number" ? "text-[#1c5cab] dark:text-[#86b6ef]" : "text-ink-3";
    const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
    return (
      <div className="font-mono text-[12px] leading-5">
        {label}<span className={`${cls} whitespace-pre-wrap break-words`}>{shown}</span>
      </div>
    );
  }
  const entries: [string, Json][] = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  const [ob, cb] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) return <div className="font-mono text-[12px]">{label}{ob}{cb}</div>;
  return (
    <div className="font-mono text-[12px] leading-5">
      <button className="text-left hover:text-ink" onClick={() => setOpen((o) => !o)}>
        <span className="inline-block w-3 text-ink-3">{open ? "▾" : "▸"}</span>
        {label}{ob}{!open && <span className="text-ink-3"> {entries.length} {Array.isArray(value) ? "items" : "keys"} {cb}</span>}
      </button>
      {open && (
        <>
          <div className="ml-3 border-l border-line pl-2">
            {entries.map(([k, v]) => <JsonTree key={k} name={Array.isArray(value) ? undefined : k} value={v} depth={depth + 1} defaultOpen={defaultOpen} />)}
          </div>
          <div>{cb}</div>
        </>
      )}
    </div>
  );
}
