// Kind icons built from the logo's DNA: solid root node · stem with the logo's elbow · hollow end node.
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";

const solid = (x, y, s) => `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="NODE" stroke="none"/>`;
const p = (d) => `<path d="${d}"/>`;

// The logo mark on the 24 grid (for reference): root node, stem + elbow (r 3), hollow end node.
const LOGO = solid(4.25, 2.5, 4.5) + p("M6.5 9.5V14.5A3 3 0 0 0 9.5 17.5H15.25") + `<rect x="15.25" y="15.25" width="4.5" height="4.5"/>`;

const KINDS = [
  { key: "agent", label: "Agent", color: "#cc4a1a",
    why: "The logo, branching: a root node that delegates — two branches, two pieces of work.",
    body: solid(3, 2.75, 5) + p("M5.5 7.75V16.25A3 3 0 0 0 8.5 19.25H14.5M5.5 9.75A3 3 0 0 0 8.5 12.75H14.5") + `<rect x="14.5" y="10.5" width="4.5" height="4.5"/><rect x="14.5" y="17" width="4.5" height="4.5"/>` },
  { key: "subagent", label: "Sub-agent", color: "#4a3aa7",
    why: "Arrives on the logo's branch from a parent off-canvas — and holds its own node.",
    body: p("M5 2.75V9.5A3 3 0 0 0 8 12.5H10.25M10.25 8.75H20.25V18.75H10.25Z") + solid(13.25, 11.75, 4) },
  { key: "llm", label: "LLM", color: "#0f8a5f",
    why: "The node speaking: a bubble with the root node and the line it is writing.",
    body: p("M3.25 4.25H20.75V16.25H11L6.75 20V16.25H3.25ZM11 10.25H17.25") + solid(6.25, 8, 4.5) },
  { key: "tool", label: "Tool", color: "#2a62c4",
    why: "An open-end spanner: the logo's end node as its head, a slot cut for the jaw.",
    body: p("M14.5 3.75H11.75V12.25H20.25V3.75H17.5V7.5H14.5ZM11.75 12.25L3.75 20.25") + solid(14.75, 9.25, 2.5) },
  { key: "framework", label: "Framework tool", color: "#6b6b68",
    why: "Built-in machinery: the logo's square node turned into a square cog.",
    body: p("M7.5 7.5H16.5V16.5H7.5ZM12 7.5V3.75M12 16.5V20.25M7.5 12H3.75M16.5 12H20.25M7.5 7.5L5 5M16.5 7.5L19 5M7.5 16.5L5 19M16.5 16.5L19 19") + solid(9.75, 9.75, 4.5) },
];

const T = (x, y, t, s = 14, f = "#7a7a7a", w = 400, a = "start") =>
  `<text x="${x}" y="${y}" font-family="Helvetica Neue" font-size="${s}" font-weight="${w}" fill="${f}" text-anchor="${a}">${t}</text>`;
const icon = (body, size, color) => {
  const sw = Math.max(1.5, (1.35 * 24) / size);
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="butt" stroke-linejoin="miter">${body.replaceAll("NODE", color)}</svg>`;
};
const at = (x, y, s) => `<g transform="translate(${x} ${y})">${s}</g>`;

let b = T(80, 92, "Kind icons · from the logo", 32, "#111", 700);
b += T(80, 126, "Every kind is built from the mark's three parts — root node, the elbowed stem, the hollow end node.", 16, "#5c5c5c");
// the logo, as the source
b += `<rect x="80" y="165" width="300" height="300" rx="22" fill="#121212"/>` + at(130, 215, icon(LOGO.replace(/NODE/g, "#FF5B2E"), 200, "#F5F5F5"));
b += T(230, 492, "the mark — the source", 13, "#8a8a8a", 400, "middle");
// big icons row
KINDS.forEach((k, i) => {
  const x = 420 + i * 290;
  b += `<rect x="${x}" y="165" width="270" height="300" rx="22" fill="#F6F5F3"/>` + at(x + 55, 195, icon(k.body, 160, k.color));
  b += T(x + 135, 395, k.label, 17, "#111", 600, "middle");
  const words = k.why.split(" "); let line = "", ly = 420;
  for (const w of words) { if ((line + w).length > 38) { b += T(x + 135, ly, line.trim(), 12, "#6a6a6a", 400, "middle"); line = ""; ly += 17; } line += w + " "; }
  b += T(x + 135, ly, line.trim(), 12, "#6a6a6a", 400, "middle");
});
// real sizes
b += T(80, 560, "Real sizes", 16, "#1a1a1a", 600);
KINDS.forEach((k, i) => { [32, 24, 16].forEach((s, j) => { b += at(80 + j * 56, 585 + i * 52, icon(k.body, s, k.color)); }); b += T(260, 607 + i * 52, k.label, 13, "#7a7a7a"); });
// in a steps tree
b += T(420, 560, "In the product · steps tree", 16, "#1a1a1a", 600);
b += `<rect x="420" y="580" width="620" height="250" rx="14" fill="#fff" stroke="#E4E4E2"/>`;
const rows = [["agent", 0, "AGENT", "bosun_orchestrator", "1m 14s"], ["llm", 1, "", "z-ai/glm-5.3-flash", "55.6s"], ["framework", 1, "", "read_file", "4ms"],
  ["subagent", 1, "SUB-AGENT", "noon_report_ledger", "28.2s"], ["llm", 2, "", "z-ai/glm-5.3-flash", "8.3s"], ["tool", 2, "", "list_vessels_tool", "4ms"]];
rows.forEach(([kind, depth, tag, name, dur], i) => {
  const k = KINDS.find((x) => x.key === kind), y = 612 + i * 36, x = 440 + depth * 22;
  b += at(x, y - 13, icon(k.body, 16, k.color));
  if (tag) b += T(x + 24, y, tag, 10, k.color, 700);
  b += T(x + 24 + (tag ? tag.length * 7.4 + 8 : 0), y, name, 13.5, "#171717", tag ? 500 : 400) + T(1020, y, dur, 12.5, "#91908c", 400, "end");
});
// in the flow canvas
b += T(1080, 560, "In the product · flow canvas", 16, "#1a1a1a", 600);
const tile = (x, y, k, bg, fg, title, meta) =>
  `<rect x="${x}" y="${y}" width="270" height="58" rx="12" fill="#fff" stroke="#DCDCD9"/><rect x="${x + 12}" y="${y + 13}" width="32" height="32" rx="8" fill="${bg}"/>${at(x + 19, y + 20, icon(k.body, 18, fg))}
   ${T(x + 56, y + 26, title, 13, "#171717", 500)}${T(x + 56, y + 44, meta, 11.5, "#91908c")}`;
const K = Object.fromEntries(KINDS.map((k) => [k.key, k]));
b += tile(1080, 580, K.agent, "#cc4a1a", "#ffffff", "bosun_orchestrator", "Main agent · 1m 14s");
b += `<path d="M1215 638V654" stroke="#DCDCD9" stroke-width="1.5"/>` + tile(1080, 654, K.subagent, "#ECEAF6", "#4a3aa7", "noon_report_ledger", "Sub-agent · 28.2s");
b += `<path d="M1215 712V728" stroke="#DCDCD9" stroke-width="1.5"/>` + tile(1080, 728, K.tool, "#E8EEF9", "#2a62c4", "list_vessels_tool", "Tool · 4ms");
b += `<path d="M1215 786V802" stroke="#DCDCD9" stroke-width="1.5"/>` + tile(1080, 802, K.llm, "#E5F4EE", "#0f8a5f", "z-ai/glm-5.3-flash", "8.3s · 1,412 tok");

const W = 1900, H = 900;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fff"/>${b}</svg>`;
writeFileSync(new URL("./out/kinds-logo.svg", import.meta.url), svg);
writeFileSync(new URL("./out/kinds-logo.png", import.meta.url),
  new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "Helvetica Neue" }, fitTo: { mode: "width", value: 1900 } }).render().asPng());
console.log("ok");
