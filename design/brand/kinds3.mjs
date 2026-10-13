// Tool and framework-step options — three each, built from the logo's parts, judged in context.
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";

const solid = (x, y, w, h = w) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="NODE" stroke="none"/>`;
const p = (d) => `<path d="${d}"/>`;

const ROWS = [
  { label: "Tool", color: "#2a62c4", sample: "list_vessels_tool", options: [
    ["A · Terminal", "Run something: the logo's square as a window, a prompt, the node as the cursor.",
      p("M3.5 4.5H20.5V19.5H3.5ZM7.25 9.25L10.25 12L7.25 14.75") + solid(12.75, 13, 4, 2.25)],
    ["B · Plug", "Connect to another system: the logo's branch into a square with two prongs.",
      p("M3.75 3V8.5A3 3 0 0 0 6.75 11.5H9M9 7.5H16V16.5H9ZM16 9.75H20.5M16 14.25H20.5") + solid(11.25, 10.25, 2.5)],
    ["C · Wrench", "The tool everyone knows, drawn precisely: round head, straight slot, the node in the jaw.",
      `<path d="M17.23 3.41L15.11 5.53L18.47 8.89L20.59 6.77A4.75 4.75 0 1 1 17.23 3.41Z"/>` + p("M12.64 11.36L3.75 20.25") + solid(13.35, 8.15, 2.5)],
  ] },
  { label: "Framework step", color: "#6b6b68", sample: "PatchToolCallsMiddleware.before_agent", options: [
    ["A · Pipeline", "A step in the framework's pipeline: the logo's stem, the solid node is this step.",
      `<rect x="9.75" y="2.75" width="4.5" height="4.5"/><rect x="9.75" y="16.75" width="4.5" height="4.5"/>` + p("M12 7.25V9.75M12 14.25V16.75") + solid(9.5, 9.5, 5)],
    ["B · Layers", "Middleware: two plates, a line passing through them, the node between.",
      p("M3.75 4H20.25V8H3.75ZM3.75 16H20.25V20H3.75ZM3.75 12H9.5M14.5 12H20.25") + solid(9.75, 9.75, 4.5)],
    ["C · Router", "The framework choosing what runs next: one line splits at the node into two.",
      p("M2.75 12H9.75M14.25 12H15.75A2.75 2.75 0 0 0 18.5 9.25V7.75M14.25 12H15.75A2.75 2.75 0 0 1 18.5 14.75V16.25") +
      `<rect x="16.25" y="3.25" width="4.5" height="4.5"/><rect x="16.25" y="16.25" width="4.5" height="4.5"/>` + solid(9.75, 9.75, 4.5)],
  ] },
];

const T = (x, y, t, s = 14, f = "#7a7a7a", w = 400, a = "start") =>
  `<text x="${x}" y="${y}" font-family="Helvetica Neue" font-size="${s}" font-weight="${w}" fill="${f}" text-anchor="${a}">${t}</text>`;
const icon = (body, size, color) => {
  const sw = Math.max(1.5, (1.35 * 24) / size);
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="butt" stroke-linejoin="miter">${body.replaceAll("NODE", color)}</svg>`;
};
const at = (x, y, s) => `<g transform="translate(${x} ${y})">${s}</g>`;
const wrap = (x, y, text, max = 46) => {
  let out = "", line = "", yy = y;
  for (const w of text.split(" ")) { if ((line + w).length > max) { out += T(x, yy, line.trim(), 12.5, "#6a6a6a"); line = ""; yy += 18; } line += w + " "; }
  return out + T(x, yy, line.trim(), 12.5, "#6a6a6a");
};

let b = T(80, 92, "Tool &amp; framework step · options", 32, "#111", 700);
b += T(80, 126, "Three each. Built from the logo's parts, and judged where they live — a steps-tree row and a flow tile.", 16, "#5c5c5c");
let y = 175;
for (const r of ROWS) {
  b += T(80, y + 22, r.label, 20, "#111", 700);
  r.options.forEach(([name, why, body], i) => {
    const x = 80 + i * 590;
    b += `<rect x="${x}" y="${y + 40}" width="560" height="320" rx="20" fill="#F6F5F3"/>`;
    b += at(x + 30, y + 70, icon(body, 132, r.color));
    b += T(x + 190, y + 90, name, 18, "#111", 600) + wrap(x + 190, y + 116, why);
    [32, 24, 16].forEach((s, j) => { b += at(x + 190 + j * 60, y + 180, icon(body, s, r.color)); });
    // steps-tree row
    b += `<rect x="${x + 30}" y="${y + 232}" width="500" height="40" rx="10" fill="#fff" stroke="#E2E2E0"/>`;
    b += at(x + 44, y + 244, icon(body, 16, r.color)) + T(x + 70, y + 257, r.sample, 13, "#171717") + T(x + 516, y + 257, "4ms", 12, "#91908c", 400, "end");
    // flow tile
    b += `<rect x="${x + 30}" y="${y + 284}" width="270" height="58" rx="12" fill="#fff" stroke="#DCDCD9"/><rect x="${x + 42}" y="${y + 297}" width="32" height="32" rx="8" fill="${r.color}1f"/>`;
    b += at(x + 49, y + 304, icon(body, 18, r.color)) + T(x + 86, y + 310, r.sample.length > 22 ? "before_agent" : r.sample, 13, "#171717", 500) + T(x + 86, y + 328, r.label + " · 4ms", 11.5, "#91908c");
  });
  y += 400;
}
const W = 1880, H = y + 10;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fff"/>${b}</svg>`;
writeFileSync(new URL("./out/tool-framework.svg", import.meta.url), svg);
writeFileSync(new URL("./out/tool-framework.png", import.meta.url),
  new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "Helvetica Neue" }, fitTo: { mode: "width", value: 1880 } }).render().asPng());
console.log("ok");
