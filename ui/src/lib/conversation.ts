/** Pull the human-readable turn (what came in, what went out) out of a trace's
 *  root input/output payloads, which may be LangGraph state, a message list,
 *  a single message, plain function kwargs or free text. */

type Msg = { role?: string; type?: string; content?: unknown };

function parse(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function isMsg(v: unknown): v is Msg {
  return !!v && typeof v === "object" && !Array.isArray(v) && "content" in v && ("role" in v || "type" in v);
}

function messagesOf(v: unknown): Msg[] | null {
  if (Array.isArray(v) && v.length && v.every(isMsg)) return v as Msg[];
  if (isMsg(v)) return [v];
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.messages)) return messagesOf(o.messages);
  }
  return null;
}

export function contentText(c: unknown): string {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "")).filter(Boolean).join("\n");
  }
  return JSON.stringify(c);
}

const role = (m: Msg) => (m.role ?? m.type ?? "").toLowerCase();

export interface Turn {
  text: string;
  /** shown instead of text when the answer can't be shown (e.g. it was cut off before it was recorded) */
  note?: string;
  /** true when we found a real chat message, false when falling back to raw kwargs/JSON */
  isMessage: boolean;
}

export function turnInput(raw: string): Turn {
  const v = parse(raw);
  const msgs = messagesOf(v);
  if (msgs) {
    const user = [...msgs].reverse().find((m) => ["user", "human"].includes(role(m)));
    const pick = user ?? msgs[msgs.length - 1];
    return { text: contentText(pick.content), isMessage: true };
  }
  return { text: typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v, null, 1), isMessage: false };
}

export function turnOutput(raw: string): Turn {
  const v = parse(raw);
  const msgs = messagesOf(v);
  if (msgs) {
    const ai = [...msgs].reverse().find((m) => ["assistant", "ai"].includes(role(m)) && contentText(m.content));
    const pick = ai ?? msgs[msgs.length - 1];
    return { text: contentText(pick.content), isMessage: true };
  }
  // A long run's state is trimmed (start …[truncated N chars]… end), so it isn't valid JSON —
  // but its final answer, the last assistant message, survives at the end.
  const last = typeof v === "string" ? lastAssistantText(v) : "";
  if (last) return { text: last, isMessage: true };
  if (typeof v === "string" && /^\s*\{\s*"messages"\s*:/.test(v) && /…\[truncated \d+ chars\]\s*$/.test(v)) {
    // Older SDKs kept only the START of a long output, so the final answer was never recorded.
    return { text: "", isMessage: true,
             note: "Final answer not recorded — this run's output was cut off before the end (an older imagent SDK kept only the start). Open the run to see its steps." };
  }
  return { text: typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v, null, 1), isMessage: false };
}

/** The last assistant message with text in a (possibly truncated) serialized message list. */
export function lastAssistantText(raw: string): string {
  const re = /"(?:role|type)"\s*:\s*"(?:assistant|ai|AIMessage)"/g;
  const hits: number[] = [];
  for (let m = re.exec(raw); m; m = re.exec(raw)) hits.push(m.index);
  for (let i = hits.length - 1; i >= 0; i--) {
    const start = raw.lastIndexOf("{", hits[i]);
    const end = start < 0 ? -1 : objectEnd(raw, start);
    if (end < 0) continue;
    try {
      const msg = JSON.parse(raw.slice(start, end + 1)) as Msg;
      const text = contentText(msg.content).trim();
      if (text) return text;
    } catch {
      /* not a whole object (cut by the truncation) — try the one before */
    }
  }
  return "";
}

/** Index of the brace closing the object that opens at `start` (strings respected), or -1. */
function objectEnd(s: string, start: number): number {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}
