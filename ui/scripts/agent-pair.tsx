// Board: the agent / sub-agent pair, rendered from the shipped KindIcon.
import * as React from "react";
(globalThis as unknown as { React: typeof React }).React = React;
import { renderToStaticMarkup } from "react-dom/server";
import { writeFileSync } from "node:fs";
import { KindIcon } from "../src/components/icons";

const glyph = (kind: string, size: number, color: string) =>
  renderToStaticMarkup(<KindIcon kind={kind} size={size} />)
    .replace(/^<span[^>]*>/, "").replace(/<\/span>$/, "")
    .replace(/var\(--icon-node, currentColor\)/g, color).replace(/currentColor/g, color);
const T = (x: number, y: number, t: string, s = 14, f = "#7a7a7a", w = 400, a = "start") =>
  `<text x="${x}" y="${y}" font-family="Helvetica Neue" font-size="${s}" font-weight="${w}" fill="${f}" text-anchor="${a}">${t}</text>`;
const at = (x: number, y: number, svg: string) => `<g transform="translate(${x} ${y})">${svg}</g>`;
const EMBER = "#cc4a1a", VIOLET = "#4a3aa7";

let b = "";
b += T(80, 92, "Agent &amp; sub-agent", 32, "#111", 700);
b += T(80, 126, "Parent and child of one family — the sub-agent arrives on the logo's branch.", 16, "#5c5c5c");
// hero
b += `<rect x="80" y="170" width="420" height="300" rx="24" fill="#F6F5F3"/>` + at(200, 230, glyph("agent", 180, EMBER)) + T(290, 450, "agent · orchestrator", 14, "#7a7a7a", 400, "middle");
b += `<rect x="530" y="170" width="420" height="300" rx="24" fill="#F6F5F3"/>` + at(650, 230, glyph("subagent", 180, VIOLET)) + T(740, 450, "sub-agent · spawned", 14, "#7a7a7a", 400, "middle");
// sizes
b += T(80, 530, "Real sizes", 16, "#1a1a1a", 600);
[32, 24, 16, 13].forEach((s, i) => { b += at(80 + i * 70, 560, glyph("agent", s, EMBER)); b += at(80 + i * 70, 610, glyph("subagent", s, VIOLET)); });
// in context: flow tiles
b += T(420, 530, "Flow canvas", 16, "#1a1a1a", 600);
const tile = (x: number, y: number, kind: string, bg: string, fg: string, title: string, meta: string) =>
  `<rect x="${x}" y="${y}" width="250" height="58" rx="12" fill="#fff" stroke="#DCDCD9"/>
   <rect x="${x + 12}" y="${y + 13}" width="32" height="32" rx="8" fill="${bg}"/>${at(x + 19, y + 20, glyph(kind, 18, fg))}
   ${T(x + 56, y + 26, title, 13, "#171717", 500)}${T(x + 56, y + 44, meta, 11.5, "#91908c")}`;
b += tile(420, 555, "agent", EMBER, "#ffffff", "bosun_orchestrator", "Main agent · 1m 14s");
b += `<path d="M545 613V631" stroke="#DCDCD9" stroke-width="1.5"/>`;
b += tile(420, 631, "subagent", "#ECEAF6", VIOLET, "noon_report_ledger", "Sub-agent · 28.2s");
// in context: steps tree
b += T(710, 530, "Steps tree", 16, "#1a1a1a", 600);
const row = (y: number, depth: number, kind: string, color: string, label: string, name: string) =>
  `${at(712 + depth * 16, y - 12, glyph(kind, 13, color))}${T(732 + depth * 16, y, label, 9.5, color, 700)}${T(732 + depth * 16 + label.length * 7 + 6, y, name, 12.5, "#171717", 500)}`;
b += row(575, 0, "agent", EMBER, "AGENT", "bosun_orchestrator");
b += row(603, 1, "llm", "#0f8a5f", "", "z-ai/glm-5.3-flash");
b += row(631, 1, "subagent", VIOLET, "SUB-AGENT", "noon_report_ledger");
b += row(659, 2, "tool", "#2a62c4", "", "list_vessels_tool");
const W = 1030, H = 720;
writeFileSync(process.argv[2], `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fff"/>${b}</svg>`);
