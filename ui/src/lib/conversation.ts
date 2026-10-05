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
  return { text: typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v, null, 1), isMessage: false };
}
