import { useEffect, useRef, useState } from "react";

export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
}

/** Global single-key shortcut (ignored while typing or with modifiers unless asked). */
export function useHotkey(key: string, handler: (e: KeyboardEvent) => void, opts: { meta?: boolean; enabled?: boolean } = {}) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (opts.enabled === false) return;
    const on = (e: KeyboardEvent) => {
      if (opts.meta ? !(e.metaKey || e.ctrlKey) : e.metaKey || e.ctrlKey || e.altKey) return;
      if (!opts.meta && isTyping(e)) return;
      if (e.key.toLowerCase() !== key.toLowerCase()) return;
      ref.current(e);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [key, opts.meta, opts.enabled]);
}

/** j/k (or ↑/↓) move through list rows, Enter/o opens. Returns the active index. */
export function useListKeys(count: number, onOpen: (index: number) => void, enabled = true) {
  const [active, setActive] = useState(-1);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  useEffect(() => {
    if (active >= count) setActive(count - 1);
  }, [count, active]);
  useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, count - 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if ((e.key === "Enter" || e.key === "o") && active >= 0) {
        e.preventDefault();
        openRef.current(active);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [count, active, enabled]);
  useEffect(() => {
    if (active < 0) return;
    document.querySelector(`[data-row-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return [active, setActive] as const;
}

/** Persisted pixel size for draggable dividers. */
export function useStoredSize(key: string, initial: number): [number, (n: number) => void] {
  const [size, setSize] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(key));
      return Number.isFinite(v) && v > 0 ? v : initial;
    } catch {
      return initial;
    }
  });
  const set = (n: number) => {
    setSize(n);
    try {
      localStorage.setItem(key, String(Math.round(n)));
    } catch {
      /* storage unavailable */
    }
  };
  return [size, set];
}
