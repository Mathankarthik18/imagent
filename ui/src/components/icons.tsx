import type { ReactNode, SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      {children}
    </svg>
  );
}

export const Icon = {
  overview: (p: P) => <Svg {...p}><path d="M2.5 13.5h11M4.5 11V7M8 11V3.5M11.5 11V8.5" /></Svg>,
  traces: (p: P) => <Svg {...p}><path d="M2.5 4h11M5 8h8.5M7.5 12h6" /></Svg>,
  threads: (p: P) => <Svg {...p}><path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" /></Svg>,
  search: (p: P) => <Svg {...p}><circle cx="7" cy="7" r="4.25" /><path d="m10.25 10.25 3 3" /></Svg>,
  refresh: (p: P) => <Svg {...p}><path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.5v3h-3" /></Svg>,
  chevronDown: (p: P) => <Svg {...p}><path d="M4.5 6.5 8 10l3.5-3.5" /></Svg>,
  chevronRight: (p: P) => <Svg {...p}><path d="M6.5 4.5 10 8l-3.5 3.5" /></Svg>,
  close: (p: P) => <Svg {...p}><path d="m4 4 8 8M12 4l-8 8" /></Svg>,
  external: (p: P) => <Svg {...p}><path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5v3a.5.5 0 0 1-.5.5H3.5a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5h3" /></Svg>,
  sun: (p: P) => <Svg {...p}><circle cx="8" cy="8" r="2.75" /><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1" /></Svg>,
  moon: (p: P) => <Svg {...p}><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z" /></Svg>,
  key: (p: P) => <Svg {...p}><circle cx="5.5" cy="10.5" r="2.75" /><path d="m7.5 8.5 5.5-5.5M11 5l1.5 1.5" /></Svg>,
  clock: (p: P) => <Svg {...p}><circle cx="8" cy="8" r="5.75" /><path d="M8 5v3l2 1.5" /></Svg>,
  copy: (p: P) => <Svg {...p}><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></Svg>,
  x: (p: P) => <Svg {...p}><circle cx="8" cy="8" r="5.75" /><path d="m6 6 4 4M10 6l-4 4" /></Svg>,
  check: (p: P) => <Svg {...p}><path d="m3.5 8.5 3 3 6-7" /></Svg>,
};

// Span kinds: one glyph each, tinted lightly so the list stays calm.
const KIND: Record<string, { path: ReactNode; color: string; label: string }> = {
  agent: { label: "Agent", color: "text-[#2a78d6] dark:text-[#6da7ec]", path: <path d="M8 1.75 13.5 4.9v6.2L8 14.25 2.5 11.1V4.9z" /> },
  node: { label: "Node", color: "text-ink-3", path: <rect x="3" y="3" width="10" height="10" rx="2" /> },
  chain: { label: "Chain", color: "text-ink-3", path: <path d="M6.5 9.5l3-3M5.2 7.6 4 8.8a2.4 2.4 0 0 0 3.4 3.4l1.2-1.2M10.8 8.4 12 7.2a2.4 2.4 0 0 0-3.4-3.4L7.4 5" /> },
  llm: { label: "LLM", color: "text-[#0f8a5f] dark:text-[#4cc79a]", path: <path d="M8 2.25 9.45 6.55 13.75 8 9.45 9.45 8 13.75 6.55 9.45 2.25 8l4.3-1.45z" /> },
  tool: { label: "Tool", color: "text-[#c2541f] dark:text-[#ef9a6e]", path: <path d="M10.4 2.6a3 3 0 0 0-3.7 3.9L2.9 10.3a1.3 1.3 0 0 0 1.8 1.8l3.8-3.8a3 3 0 0 0 3.9-3.7l-1.7 1.7-1.5-.3-.3-1.5z" /> },
  retriever: { label: "Retriever", color: "text-[#a93a66] dark:text-[#ec8fb2]", path: <><circle cx="7" cy="7" r="3.75" /><path d="m9.75 9.75 3.5 3.5" /></> },
  embedding: { label: "Embedding", color: "text-[#a93a66] dark:text-[#ec8fb2]", path: <path d="M3 8h10M8 3v10" /> },
  span: { label: "Span", color: "text-ink-3", path: <circle cx="8" cy="8" r="3" /> },
};

export function KindIcon({ kind, size = 14, className = "" }: { kind: string; size?: number; className?: string }) {
  const k = KIND[kind] ?? KIND.span;
  return (
    <span className={`inline-flex shrink-0 ${k.color} ${className}`} title={k.label}>
      <Svg size={size}>{k.path}</Svg>
    </span>
  );
}

export function kindLabel(kind: string) {
  return (KIND[kind] ?? KIND.span).label;
}
