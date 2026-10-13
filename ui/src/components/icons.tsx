import type { ReactNode, SVGProps } from "react";

/* imagent icon language (design/brand): 24-unit grid · 2px padding · 1.5 stroke · butt caps, mitred
 * corners · 90°/45° lines, circles the only curves · one solid square "node" per icon — the logo's node.
 * Tiny controls (chevrons, close, check, play…) skip the node. The node takes `--icon-node`
 * (defaults to the icon's colour), so a brand moment can light it in the accent.
 * Optical sizing: below 24px the stroke is held at ~1.35 rendered px and the node at ≥2px. */

type P = SVGProps<SVGSVGElement> & { size?: number };
type Draw = (node: (x: number, y: number) => ReactNode) => ReactNode;

function weights(size: number) {
  return { stroke: Math.max(1.5, (1.35 * 24) / size), node: Math.max(2.5, (2 * 24) / size) };
}

function make(draw: Draw) {
  return function IconGlyph({ size = 16, children: _c, ...rest }: P) {
    const w = weights(size);
    const node = (x: number, y: number) => (
      <rect x={x - w.node / 2} y={y - w.node / 2} width={w.node} height={w.node} fill="var(--icon-node, currentColor)" stroke="none" />
    );
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w.stroke}
        strokeLinecap="butt" strokeLinejoin="miter" strokeMiterlimit={10} aria-hidden {...rest}>
        {draw(node)}
      </svg>
    );
  };
}

const d = (path: string) => <path d={path} />;

export const Icon = {
  // ── navigation ──
  overview: make((n) => <>{d("M3 20.25H21M6.75 17V11.5M11.75 17V6.5M16.75 17V13.5")}{n(16.75, 9.5)}</>),
  traces: make((n) => <>{d("M8.5 6H21M11 12H19M13.5 18H21")}{n(4.25, 6)}</>),
  blueprint: make((n) => <>{d("M9 3.5H15V8.5H9ZM3 15.5H9V20.5H3ZM15 15.5H21V20.5H15ZM12 8.5V12M6 15.5V12H18V15.5")}{n(12, 12)}</>),
  experiments: make((n) => <>{d("M9.25 3.75V9.25L4.25 18.75V20.25H19.75V18.75L14.75 9.25V3.75M7.5 3.75H16.5M6.4 15H17.6")}{n(12, 17.5)}</>),
  threads: make((n) => <>{d("M3.75 4.75H20.25V16H11L6.5 19.75V16H3.75Z")}{n(8.5, 10.4)}</>),
  settings: make((n) => <>{d("M3 6.5H8M12 6.5H21M3 17.5H14M18 17.5H21M8 4.5H12V8.5H8ZM14 15.5H18V19.5H14ZM3 12H21")}{n(6.5, 12)}</>),
  projects: make((n) => <>{d("M4 4H10.5V10.5H4ZM13.5 4H20V10.5H13.5ZM4 13.5H10.5V20H4ZM13.5 13.5H20V20H13.5Z")}{n(16.75, 16.75)}</>),
  key: make((n) => <>{d("M12.1 11.9L20.5 3.5M17.25 6.75L19.75 9.25")}<circle cx="8.25" cy="15.75" r="4.75" />{n(8.25, 15.75)}</>),

  // ── actions ──
  search: make((n) => <><circle cx="10.5" cy="10.5" r="6.75" />{d("M15.25 15.25L20.75 20.75")}{n(10.5, 10.5)}</>),
  refresh: make((n) => <>{d("M19.75 12A7.75 7.75 0 1 1 17.48 6.52M17.75 2.75V6.75H13.75")}{n(12, 12)}</>),
  copy: make((n) => <>{d("M8.25 8.25H20.25V20.25H8.25ZM15.75 8.25V3.75H3.75V15.75H8.25")}{n(14.25, 14.25)}</>),
  external: make((n) => <>{d("M13.5 3.75H20.25V10.5M20.25 3.75L11 13M17 14V20.25H3.75V7H10")}{n(20.25, 3.75)}</>),
  restart: make((n) => <>{d("M4.25 12A7.75 7.75 0 1 0 6.52 6.52M6.25 2.75V6.75H2.25")}{n(12, 12)}</>),
  plus: make(() => d("M12 4.5V19.5M4.5 12H19.5")),
  expand: make(() => d("M14 4H20V10M10 20H4V14M20 4L13.75 10.25M4 20L10.25 13.75")),
  play: make(() => d("M7 4.75V19.25L19 12Z")),
  pause: make(() => d("M8.25 5V19M15.75 5V19")),

  // ── controls (no node) ──
  chevronDown: make(() => d("M6 9.25L12 15.25L18 9.25")),
  chevronRight: make(() => d("M9.25 6L15.25 12L9.25 18")),
  chevronLeft: make(() => d("M14.75 6L8.75 12L14.75 18")),
  close: make(() => d("M5.5 5.5L18.5 18.5M18.5 5.5L5.5 18.5")),
  check: make(() => d("M4.5 12.5L9.75 17.75L19.5 6.75")),

  // ── status & meaning ──
  x: make(() => <><circle cx="12" cy="12" r="8.25" />{d("M9 9L15 15M15 9L9 15")}</>),
  warning: make((n) => <>{d("M12 3.75L21.25 20H2.75ZM12 9.5V14.25")}{n(12, 16.9)}</>),
  star: make(() => <path d="M12 3L14.4 9.6L21 12L14.4 14.4L12 21L9.6 14.4L3 12L9.6 9.6Z" fill="currentColor" stroke="none" />),
  clock: make((n) => <><circle cx="12" cy="12" r="8.25" />{d("M12 7.25V12H15.75")}{n(12, 12)}</>),
  sun: make((n) => <><circle cx="12" cy="12" r="4" />{d("M12 2.75V5.25M12 18.75V21.25M2.75 12H5.25M18.75 12H21.25M5.46 5.46L7.23 7.23M16.77 16.77L18.54 18.54M5.46 18.54L7.23 16.77M16.77 7.23L18.54 5.46")}{n(12, 12)}</>),
  moon: make((n) => <>{d("M19.75 14.25A8.25 8.25 0 1 1 9.75 4.25A6.25 6.25 0 0 0 19.75 14.25Z")}{n(17.25, 6.25)}</>),
  /** Replay step states — the node itself: running = solid, pending = hollow. */
  running: make(() => <rect x="7.5" y="7.5" width="9" height="9" fill="currentColor" stroke="none" />),
  pending: make(() => <rect x="8" y="8" width="8" height="8" />),
};

// Span kinds — built from the logo's three parts: the solid root node, the stem with the logo's
// elbow, and the hollow end node. Colour carries the kind.
const solid = (x: number, y: number, w: number, h = w) => <rect x={x} y={y} width={w} height={h} fill="var(--icon-node, currentColor)" stroke="none" />;
const glyph = (draw: Draw) => draw;
const KIND: Record<string, { draw: Draw; color: string; label: string }> = {
  // The mark, branching: a root node delegating to two pieces of work.
  agent: { label: "Agent", color: "text-[#cc4a1a] dark:text-[#ff8a63]", draw: glyph(() => <>
    {solid(3, 2.75, 5)}{d("M5.5 7.75V16.25A3 3 0 0 0 8.5 19.25H14.5M5.5 9.75A3 3 0 0 0 8.5 12.75H14.5")}
    <rect x="14.5" y="10.5" width="4.5" height="4.5" /><rect x="14.5" y="17" width="4.5" height="4.5" /></>) },
  // The logo's branch arriving from a parent, into a node of its own.
  subagent: { label: "Sub-agent", color: "text-[#4a3aa7] dark:text-[#b8b0f2]", draw: glyph(() => <>
    {d("M5 2.75V9.5A3 3 0 0 0 8 12.5H10.25M10.25 8.75H20.25V18.75H10.25Z")}{solid(13.25, 11.75, 4)}</>) },
  // The node speaking: a bubble with the root node and the line it is writing.
  llm: { label: "LLM", color: "text-[#0f8a5f] dark:text-[#4cc79a]", draw: glyph(() => <>
    {d("M3.25 4.25H20.75V16.25H11L6.75 20V16.25H3.25ZM11 10.25H17.25")}{solid(6.25, 8, 4.5)}</>) },
  // Connect to another system: the logo's branch running into a square with two prongs.
  tool: { label: "Tool", color: "text-[#2a62c4] dark:text-[#7aa7f0]", draw: glyph(() => <>
    {d("M3.75 3V8.5A3 3 0 0 0 6.75 11.5H9M9 7.5H16V16.5H9ZM16 9.75H20.5M16 14.25H20.5")}{solid(11.25, 10.75, 2.5)}</>) },
  // Framework plumbing (LangGraph nodes, middleware, built-in tools): two plates, a line through, the node between.
  framework: { label: "Framework", color: "text-ink-3", draw: glyph(() => <>
    {d("M3.75 4H20.25V8H3.75ZM3.75 16H20.25V20H3.75ZM3.75 12H9.5M14.5 12H20.25")}{solid(9.75, 9.75, 4.5)}</>) },
  retriever: { label: "Retriever", color: "text-[#a93a66] dark:text-[#ec8fb2]", draw: glyph((n) => <>{d("M3.75 5.5H11M3.75 10.5H8M3.75 15.5H7.5M18.75 18.75L21 21")}<circle cx="15" cy="15" r="4.25" />{n(15, 15)}</>) },
  embedding: { label: "Embedding", color: "text-[#a93a66] dark:text-[#ec8fb2]", draw: glyph((n) => <>{d("M4 4H9V9H4ZM15 4H20V9H15ZM4 15H9V20H4Z")}{n(17.5, 17.5)}</>) },
  span: { label: "Span", color: "text-ink-3", draw: glyph((n) => <>{d("M8.5 12H20.5")}{n(5, 12)}</>) },
};
// LangGraph plumbing is framework too.
KIND.node = { ...KIND.framework, label: "Node" };
KIND.chain = { ...KIND.framework, label: "Chain" };
const KIND_GLYPH = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [k, make(v.draw)]));

/** Tools that come with the agent framework (deepagents), not with the app. */
export const FRAMEWORK_TOOLS = new Set(["ls", "read_file", "write_file", "edit_file", "delete", "glob", "grep", "execute", "write_todos", "task"]);

/** The kind to draw for a span: built-in framework tools get the framework icon. */
export function kindOf(kind: string, name?: string): string {
  return kind === "tool" && name && FRAMEWORK_TOOLS.has(name) ? "framework" : kind;
}

export function KindIcon({ kind, name, size = 14, className = "" }: { kind: string; name?: string; size?: number; className?: string }) {
  const key = kindOf(kind, name);
  const k = KIND[key] ?? KIND.span;
  const Glyph = KIND_GLYPH[key] ?? KIND_GLYPH.span;
  return (
    <span className={`inline-flex shrink-0 ${k.color} ${className}`} title={k.label}>
      <Glyph size={size} />
    </span>
  );
}

export function kindLabel(kind: string) {
  return (KIND[kind] ?? KIND.span).label;
}
