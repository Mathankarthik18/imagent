// Renders the shipped icon components to one SVG sheet (design/brand/final).
import * as React from "react";
(globalThis as unknown as { React: typeof React }).React = React;
import { renderToStaticMarkup } from "react-dom/server";
import { writeFileSync } from "node:fs";
import { Icon, KindIcon } from "../src/components/icons";
import { AppIcon, Logo, LogoMark } from "../src/components/Brand";

const out = process.argv[2];
const groups: [string, string[]][] = [
  ["Navigation", ["overview", "blueprint", "traces", "experiments", "threads", "settings", "projects", "key"]],
  ["Actions", ["search", "refresh", "restart", "copy", "external", "plus", "expand", "play", "pause"]],
  ["Controls", ["chevronDown", "chevronRight", "chevronLeft", "close", "check"]],
  ["Status &amp; meaning", ["x", "warning", "star", "clock", "sun", "moon", "running", "pending"]],
];
const kinds = ["agent", "subagent", "llm", "tool", "framework", "retriever", "embedding", "span"];
const svg = (el: JSX.Element) => renderToStaticMarkup(el);
const strip = (s: string) => s.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");

let body = "", y = 220;
const cell = 104, x0 = 80;
const text = (x: number, yy: number, t: string, size = 14, fill = "#7a7a7a", weight = 400, anchor = "start") =>
  `<text x="${x}" y="${yy}" font-family="Helvetica Neue" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${t}</text>`;
const tileAt = (x: number, yy: number, inner: string, color = "#151515", node = "#cc4a1a") =>
  `<rect x="${x}" y="${yy}" width="84" height="84" rx="14" fill="#F6F5F3"/>
   <g transform="translate(${x + 18} ${yy + 18}) scale(2)" color="${color}" style="--icon-node:${node}">${inner}</g>`;
for (const [title, names] of groups) {
  body += text(x0, y - 18, title, 16, "#1a1a1a", 600);
  names.forEach((n, i) => {
    const C = (Icon as Record<string, (p: { size?: number }) => JSX.Element>)[n];
    const inner = strip(svg(<C size={24} />)).replace(/var\(--icon-node, currentColor\)/g, "#cc4a1a");
    body += tileAt(x0 + i * cell, y, `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#151515" stroke-width="1.5" stroke-linecap="butt" stroke-linejoin="miter">${inner}</svg>`);
    body += text(x0 + i * cell + 42, y + 104, n, 12, "#8a8a8a", 400, "middle");
  });
  y += 175;
}
body += text(x0, y - 18, "Span kinds — built from the logo · colour carries the kind", 16, "#1a1a1a", 600);
kinds.forEach((k, i) => {
  const html = svg(<KindIcon kind={k} size={24} />);
  const color = ({ agent: "#cc4a1a", subagent: "#4a3aa7", framework: "#6b6b68", llm: "#0f8a5f", tool: "#2a62c4", retriever: "#a93a66", embedding: "#a93a66" } as Record<string, string>)[k] ?? "#7a7a7a";
  const inner = strip(html.replace(/^<span[^>]*>/, "").replace(/<\/span>$/, "")).replace(/var\(--icon-node, currentColor\)/g, color).replace(/currentColor/g, color);
  body += tileAt(x0 + i * cell, y, `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="butt" stroke-linejoin="miter">${inner}</svg>`, color, color);
  body += text(x0 + i * cell + 42, y + 104, k, 12, "#8a8a8a", 400, "middle");
});
const logo = strip(svg(<LogoMark size={48} />)).replace(/var\(--brand-accent\)/g, "#FF5B2E").replace(/currentColor/g, "#121212");
const lockup = svg(<Logo size={40} />);
const app = strip(svg(<AppIcon size={48} />));
const W = 1180, H = y + 160;
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#fff"/>
  ${text(x0, 92, "imagent · icon set", 32, "#111", 700)}
  ${text(x0, 126, "Direction A Trace · palette Ember · drawn from the shipped components", 16, "#5c5c5c")}
  <g transform="translate(${W - 240} 56) scale(1.5)"><svg viewBox="0 0 48 48" width="48" height="48">${app}</svg></g>
  <g transform="translate(${W - 150} 60)"><svg viewBox="4 4 40 40" width="64" height="64">${logo}</svg></g>
  ${body}</svg>`;
writeFileSync(out, sheet);
void lockup;
