// README artwork: the banner (1280×640, also the GitHub social preview) and feature icons —
// rendered from the shipped brand/icon components so they never drift from the product.
import * as React from "react";
(globalThis as unknown as { React: typeof React }).React = React;
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, writeFileSync } from "node:fs";
import { Icon, KindIcon } from "../src/components/icons";

const out = process.argv[2];
mkdirSync(`${out}/icons`, { recursive: true });

const EMBER = "#FF5B2E", INK = "#121212", PAPER = "#F5F5F2", MUTED = "#8C8A86";
const inner = (html: string) => html.replace(/^<span[^>]*>/, "").replace(/<\/span>$/, "").replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
const kind = (k: string, color: string) => inner(renderToStaticMarkup(<KindIcon kind={k} size={24} />))
  .replace(/var\(--icon-node, currentColor\)/g, color).replace(/currentColor/g, color);
const ui = (name: keyof typeof Icon, color: string, node = color) =>
  inner(renderToStaticMarkup(React.createElement(Icon[name], { size: 24 })))
    .replace(/var\(--icon-node, currentColor\)/g, node).replace(/currentColor/g, color);
const g24 = (body: string, x: number, y: number, size: number, color: string) =>
  `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="butt" stroke-linejoin="miter">${body}</svg>`;

// wordmark (same construction as Brand.tsx)
const GLYPHS: [string, number, string][] = [
  ["i", 0, "M0 0V12"], ["m", 16, "M0 12V0M0 4A4 4 0 0 1 8 4V12M8 4A4 4 0 0 1 16 4V12"],
  ["a", 12, "M12 0V12M12 6A6 6 0 1 0 12 6.01"], ["g", 12, "M12 0V15A5 5 0 0 1 7 20H2M12 6A6 6 0 1 0 12 6.01"],
  ["e", 12, "M0.4 6H12A6 6 0 1 0 10.1 10.4"], ["n", 8, "M0 12V0M0 4A4 4 0 0 1 8 4V12"], ["t", 6, "M1.6 -4V9A3 3 0 0 0 4.6 12H7M-1 0H6"],
];
function wordmark(x: number, y: number, scale: number, ink: string) {
  let cx = 0, s = "";
  for (const [ch, w, d] of GLYPHS) { s += `<path d="${d}" transform="translate(${cx} 0)"/>`; cx += w + 3.6 + (ch === "i" ? 0.86 : 0); }
  return `<g transform="translate(${x} ${y}) scale(${scale})"><g fill="none" stroke="${ink}" stroke-width="2.15">${s}</g>
    <rect x="-1.83" y="-6.43" width="3.66" height="3.66" fill="${EMBER}"/></g>`;
}
const mark = (x: number, y: number, size: number, ink: string) => `<g transform="translate(${x} ${y}) scale(${size / 40}) translate(-4 -4)">
  <rect x="11" y="6" width="9" height="9" fill="${EMBER}"/>
  <path d="M15.5 20V31A6 6 0 0 0 21.5 37H32.5" fill="none" stroke="${ink}" stroke-width="4"/>
  <rect x="32.5" y="32.5" width="9" height="9" fill="none" stroke="${ink}" stroke-width="4"/></g>`;
const T = (x: number, y: number, t: string, s: number, f: string, w = 400, family = "Helvetica Neue") =>
  `<text x="${x}" y="${y}" font-family="${family}" font-size="${s}" font-weight="${w}" fill="${f}">${t}</text>`;

// ── banner ──
const W = 1280, H = 640;
let b = `<rect width="${W}" height="${H}" fill="${INK}"/>`;
// faint grid, the icon grid scaled up
for (let x = 0; x <= W; x += 32) b += `<path d="M${x} 0V${H}" stroke="#ffffff" stroke-opacity="0.035"/>`;
for (let y = 0; y <= H; y += 32) b += `<path d="M0 ${y}H${W}" stroke="#ffffff" stroke-opacity="0.035"/>`;
b += mark(96, 176, 92, PAPER);
b += wordmark(214, 210, 3.9, PAPER);
b += T(98, 350, "Self-hosted observability", 36, PAPER, 500);
b += T(98, 394, "for AI agents.", 36, PAPER, 500);
b += T(98, 440, "Traces, blueprints and model experiments", 20, MUTED);
b += T(98, 468, "for LangChain &amp; LangGraph — no trace limits.", 20, MUTED);
const chips = ["OpenTelemetry", "ClickHouse", "LangGraph", "MIT"];
let cx = 98;
for (const c of chips) { const w = c.length * 9.6 + 28; b += `<rect x="${cx}" y="510" width="${w}" height="34" rx="17" fill="none" stroke="#ffffff" stroke-opacity="0.18"/>` + T(cx + 14, 532, c, 15, "#D9D7D2", 500); cx += w + 10; }

// a trace, drawn in the icon language: name column, then a waterfall of when each span ran
const rows: [string, string, string, number, number, number][] = [
  // kind, colour, name, indent, start, width (on a 0–220 timeline)
  ["agent", "#FF6B3D", "orchestrator", 0, 0, 220], ["llm", "#4CC79A", "claude-sonnet", 14, 4, 46],
  ["subagent", "#B8B0F2", "noon_report", 14, 54, 140], ["llm", "#4CC79A", "glm-5.3-flash", 28, 58, 40],
  ["tool", "#7AA7F0", "list_vessels", 28, 100, 14], ["tool", "#7AA7F0", "noon_reports", 28, 116, 56],
  ["framework", "#8C8A86", "summarize", 14, 198, 18],
];
const ox = 818, oy = 150, col = 168;
b += `<rect x="${ox - 28}" y="${oy - 44}" width="${col + 276}" height="${rows.length * 44 + 70}" rx="20" fill="#1A1A19" stroke="#ffffff" stroke-opacity="0.08"/>`;
b += T(ox - 6, oy - 12, "trace · 9 spans · 2.3s", 13, MUTED, 500, "Menlo");
rows.forEach(([k, color, name, indent, start, width], i) => {
  const y = oy + 14 + i * 44;
  b += g24(kind(k, color), ox + indent, y, 20, color);
  b += T(ox + 28 + indent, y + 15, name, 13.5, "#E8E6E1", 400, "Menlo");
  b += `<rect x="${ox + col + start}" y="${y + 5}" width="${width}" height="10" rx="2" fill="${color}" fill-opacity="${i === 0 ? 0.9 : 0.78}"/>`;
});
writeFileSync(`${out}/banner.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${b}</svg>`);

// ── feature icons for the README (ember node on ink tile; work on light and dark GitHub) ──
const tile = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56">
  <rect width="56" height="56" rx="14" fill="${INK}"/>${g24(body, 14, 14, 28, PAPER)}</svg>`;
const features: Record<string, string> = {
  traces: ui("traces", PAPER, EMBER), blueprint: ui("blueprint", PAPER, EMBER), experiments: ui("experiments", PAPER, EMBER),
  judge: ui("check", PAPER), projects: ui("projects", PAPER, EMBER), live: ui("clock", PAPER, EMBER),
  agent: kind("agent", PAPER).replace(/fill="#F5F5F2" stroke="none"/g, `fill="${EMBER}" stroke="none"`),
  tool: kind("tool", PAPER).replace(/fill="#F5F5F2" stroke="none"/g, `fill="${EMBER}" stroke="none"`),
  llm: kind("llm", PAPER).replace(/fill="#F5F5F2" stroke="none"/g, `fill="${EMBER}" stroke="none"`),
};
for (const [n, body] of Object.entries(features)) writeFileSync(`${out}/icons/${n}.svg`, tile(body));
console.log("written");
