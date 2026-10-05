import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useStoredSize } from "../lib/keys";
import { Icon } from "./icons";

/** Right-side peek panel over a list. Esc closes; the left edge drags to resize. */
export function Drawer({ title, href, onClose, children }: {
  title: ReactNode; href?: string; onClose: () => void; children: ReactNode;
}) {
  const [width, setWidth] = useStoredSize("harness.drawer.width", Math.round(window.innerWidth * 0.62));

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => setWidth(Math.min(window.innerWidth - 120, Math.max(420, window.innerWidth - ev.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/10 dark:bg-black/40" onClick={onClose} aria-hidden />
      <aside role="dialog" aria-modal="true"
        className="fixed inset-y-0 right-0 z-40 flex max-w-full flex-col border-l border-line bg-bg shadow-[-12px_0_32px_-12px_rgb(0_0_0/0.18)]"
        style={{ width: Math.min(width, window.innerWidth) }}>
        <div onPointerDown={startDrag} className="absolute inset-y-0 -left-1 w-2 cursor-col-resize hover:bg-accent/30" title="Drag to resize" />
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
          <div className="min-w-0 flex-1 truncate font-medium">{title}</div>
          {href && (
            <Link to={href} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] text-ink-2 hover:bg-subtle hover:text-ink">
              Open page <Icon.external size={13} />
            </Link>
          )}
          <button onClick={onClose} className="inline-flex size-7 items-center justify-center rounded-md text-ink-3 hover:bg-subtle hover:text-ink" title="Close (Esc)">
            <Icon.close size={14} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
      </aside>
    </>
  );
}
