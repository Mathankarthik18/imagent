import { useRef, type ReactNode } from "react";
import { useStoredSize } from "../lib/keys";

/** Two panes with a draggable divider; the left width (as %) is remembered per `id`.
 *  Below the lg breakpoint the panes simply stack. */
export function Split({ id, left, right, initial = 52, min = 28, max = 75, height }: {
  id: string; left: ReactNode; right: ReactNode; initial?: number; min?: number; max?: number;
  /** CSS height for both panes on large screens (e.g. "calc(100vh - 160px)"); panes scroll inside. */
  height?: string;
}) {
  const [pct, setPct] = useStoredSize(`harness.split.${id}`, initial);
  const box = useRef<HTMLDivElement>(null);

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = box.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const p = ((ev.clientX - rect.left) / rect.width) * 100;
      setPct(Math.min(max, Math.max(min, p)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={box} className="flex min-h-0 flex-col gap-4 lg:h-[var(--pane-h)] lg:flex-row lg:gap-0"
      style={{ "--split": `${pct}%`, "--pane-h": height ?? "auto" } as React.CSSProperties}>
      <div className="min-h-0 min-w-0 max-lg:h-[70vh] lg:w-[var(--split)] lg:shrink-0">{left}</div>
      <div role="separator" aria-orientation="vertical" aria-label="Resize panes" onPointerDown={startDrag}
        onDoubleClick={() => setPct(initial)}
        className="group relative hidden w-3 shrink-0 cursor-col-resize lg:block" title="Drag to resize · double-click to reset">
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent group-hover:bg-accent/60" />
      </div>
      <div className="min-h-0 min-w-0 flex-1 max-lg:h-[80vh]">{right}</div>
    </div>
  );
}
