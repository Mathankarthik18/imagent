/* imagent brand (design/brand · direction A "Trace", palette Ember).
 * The mark is the letter i drawn as a trace: a root node (accent), the run it starts, and the
 * branch it spawns ending in a node. The wordmark is built from the same monoline strokes — no font. */

const ACCENT = "var(--brand-accent)";

/** The mark on its 48-unit grid. */
export function LogoMark({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="4 4 40 40" className={className} aria-label="imagent" role="img">
      <rect x="11" y="6" width="9" height="9" fill={ACCENT} />
      <path d="M15.5 20V31A6 6 0 0 0 21.5 37H32.5" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="butt" />
      <rect x="32.5" y="32.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="4" />
    </svg>
  );
}

/** The mark on a filled tile — app icon / favicon. */
export function AppIcon({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-label="imagent" role="img">
      <rect width="48" height="48" rx="11" fill="#121212" />
      <g transform="translate(8 8) scale(0.667)">
        <rect x="11" y="6" width="9" height="9" fill="#FF5B2E" />
        <path d="M15.5 20V31A6 6 0 0 0 21.5 37H32.5" fill="none" stroke="#F5F5F5" strokeWidth="4" />
        <rect x="32.5" y="32.5" width="9" height="9" fill="none" stroke="#F5F5F5" strokeWidth="4" />
      </g>
    </svg>
  );
}

// Wordmark glyphs on an x-height of 12 (y 0…12); widths in the same units.
const GLYPHS: [string, number, string][] = [
  ["i", 0, "M0 0V12"],
  ["m", 16, "M0 12V0M0 4A4 4 0 0 1 8 4V12M8 4A4 4 0 0 1 16 4V12"],
  ["a", 12, "M12 0V12M12 6A6 6 0 1 0 12 6.01"],
  ["g", 12, "M12 0V15A5 5 0 0 1 7 20H2M12 6A6 6 0 1 0 12 6.01"],
  ["e", 12, "M0.4 6H12A6 6 0 1 0 10.1 10.4"],
  ["n", 8, "M0 12V0M0 4A4 4 0 0 1 8 4V12"],
  ["t", 6, "M1.6 -4V9A3 3 0 0 0 4.6 12H7M-1 0H6"],
];
const STROKE = 2.15;
const TRACK = 3.6;

/** "imagent" — the dot of the i is the brand node. Height = the x-height + ascender/descender. */
export function Wordmark({ height = 16, className = "" }: { height?: number; className?: string }) {
  let x = 0;
  const parts = GLYPHS.map(([ch, w, path]) => {
    const at = x;
    x += w + TRACK + (ch === "i" ? STROKE * 0.4 : 0);
    return <path key={ch} d={path} transform={`translate(${at} 0)`} />;
  });
  const width = x - TRACK + 2;
  const vb = { x: -2, y: -7.5, w: width + 2, h: 28.5 };
  return (
    <svg height={height} viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} className={className} aria-label="imagent" role="img"
      style={{ width: (height * vb.w) / vb.h }}>
      <g fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="butt" strokeLinejoin="miter">{parts}</g>
      <rect x={-STROKE * 0.85} y={-4.6 - STROKE * 0.85} width={STROKE * 1.7} height={STROKE * 1.7} fill={ACCENT} />
    </svg>
  );
}

/** Mark + wordmark, as used in the sidebar. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2 text-ink">
      <LogoMark size={size} />
      <Wordmark height={size * 0.95} />
    </span>
  );
}
