import { memo, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm, remarkBreaks];
const components = {
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

/** Message text rendered as Markdown (GFM tables, lists, code; raw HTML is never rendered). */
export const Markdown = memo(function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown remarkPlugins={plugins} components={components}>{text}</ReactMarkdown>
    </div>
  );
});

/** Markdown that collapses past `maxHeight` px with a "Show all" toggle. */
export function CollapsibleMarkdown({ text, maxHeight = 420 }: { text: string; maxHeight?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setOverflows(el.scrollHeight > maxHeight + 24);
  }, [text, maxHeight]);
  const clipped = overflows && !expanded;
  return (
    <div>
      <div ref={ref} className="relative overflow-hidden" style={clipped ? { maxHeight } : undefined}>
        <Markdown text={text} />
        {clipped && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[var(--bg)] to-transparent" />}
      </div>
      {overflows && (
        <button className="mt-1 text-[12px] text-ink-3 hover:text-ink" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show less" : `Show all · ${text.length.toLocaleString()} chars`}
        </button>
      )}
    </div>
  );
}
