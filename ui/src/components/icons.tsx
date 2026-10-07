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
  experiments: (p: P) => <Svg {...p}><path d="M6 2.5h4M6.5 2.5v4L3 12.6A.9.9 0 0 0 3.8 14h8.4a.9.9 0 0 0 .8-1.4L9.5 6.5v-4M4.6 10h6.8" /></Svg>,
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

// Span kinds: one glyph each (Lucide shapes, 24-unit grid), tinted lightly so the list stays calm.
const KIND: Record<string, { path: ReactNode; color: string; label: string }> = {
  agent: { label: "Agent", color: "text-[#2a78d6] dark:text-[#6da7ec]", path: <><path d="M12 8V4H8" /><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M2 14h2M20 14h2M15 13v2M9 13v2" /></> },
  node: { label: "Node", color: "text-ink-3", path: <rect x="4" y="4" width="16" height="16" rx="3" /> },
  chain: { label: "Chain", color: "text-ink-3", path: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></> },
  llm: { label: "LLM", color: "text-[#0f8a5f] dark:text-[#4cc79a]", path: <><path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.13a.5.5 0 0 1 .96 0l1.58 6.13a2 2 0 0 0 1.44 1.44l6.13 1.58a.5.5 0 0 1 0 .96l-6.13 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z" /><path d="M20 3v4M22 5h-4" /></> },
  tool: { label: "Tool", color: "text-[#c2541f] dark:text-[#ef9a6e]", path: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z" /> },
  retriever: { label: "Retriever", color: "text-[#a93a66] dark:text-[#ec8fb2]", path: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></> },
  embedding: { label: "Embedding", color: "text-[#a93a66] dark:text-[#ec8fb2]", path: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></> },
  span: { label: "Span", color: "text-ink-3", path: <circle cx="12" cy="12" r="4" /> },
};

export function KindIcon({ kind, size = 14, className = "" }: { kind: string; size?: number; className?: string }) {
  const k = KIND[kind] ?? KIND.span;
  return (
    <span className={`inline-flex shrink-0 ${k.color} ${className}`} title={k.label}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={size >= 16 ? 1.75 : 2}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden>{k.path}</svg>
    </span>
  );
}

export function kindLabel(kind: string) {
  return (KIND[kind] ?? KIND.span).label;
}
