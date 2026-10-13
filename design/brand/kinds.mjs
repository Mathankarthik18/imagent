// Concepts for the five kind icons — two options each, same language as the set.
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";

const N = (x, y, s = 2.5) => `<rect x="${x - s / 2}" y="${y - s / 2}" width="${s}" height="${s}" fill="NODE" stroke="none"/>`;
const p = (d) => `<path d="${d}"/>`;

const C = {
  agent: {
    color: "#cc4a1a", label: "Agent",
    A: ["Bot · antenna node", "An agent you can recognise: a machine head whose antenna light is the brand node.",
      p("M5 9.5H19V19.5H5ZM12 9.5V6.25M9.5 13.25V15.75M14.5 13.25V15.75M2.75 13V16.25M21.25 13V16.25") + N(12, 4.75, 3)],
    B: ["Operator", "A figure at work: head, shoulders, and the node as its focus.",
      `<circle cx="12" cy="7.5" r="3.75"/>` + p("M4.75 20.5V19A5.5 5.5 0 0 1 10.25 13.5H13.75A5.5 5.5 0 0 1 19.25 19V20.5") + N(18.75, 4.5, 3)],
  },
  subagent: {
    color: "#4a3aa7", label: "Sub-agent",
    A: ["Spawned bot", "A smaller bot hanging from its parent's node — the trace branch from the logo.",
      p("M4.5 7V11.5A3 3 0 0 0 7.5 14.5H9.5M10.5 12.5H20.5V20.5H10.5ZM13.75 15.75V17.5M17.25 15.75V17.5") + `<rect x="2.75" y="2.75" width="3.5" height="3.5"/>` + N(15.5, 10, 2.5).replace("<rect", "<rect").replace(/y="[\d.]+"/, 'y="8.75"')],
    B: ["Helper", "A small bot in front of a bigger one — an agent with a helper.",
      p("M9.5 12.25H3V4.5H13V9.25M8 4.5V2.25M10.5 11H20.5V20.5H10.5ZM13.75 14.75V16.75M17.25 14.75V16.75M15.5 11V8.75") + N(15.5, 7.5, 2.5)],
  },
  llm: {
    color: "#0f8a5f", label: "LLM",
    A: ["Speaking spark", "Language + generation: a speech bubble with the AI spark inside.",
      p("M3.5 4.5H20.5V16.5H11L6.5 20.25V16.5H3.5Z") + `<path d="M12 6.75L13.1 9.4L15.75 10.5L13.1 11.6L12 14.25L10.9 11.6L8.25 10.5L10.9 9.4Z" fill="NODE" stroke="none"/>`],
    B: ["Text → spark", "Lines of text turning into an answer: the model at work.",
      p("M3.5 6.5H11M3.5 12H9M3.5 17.5H11") + `<path d="M16.5 4.5L18.1 8.4L22 10L18.1 11.6L16.5 15.5L14.9 11.6L11 10L14.9 8.4Z" fill="NODE" stroke="none"/>`],
  },
  framework: {
    color: "#6b6b68", label: "Framework tool",
    A: ["Cog", "Built-in machinery (ls, read_file, task…): a cog, cut with straight teeth.",
      p("M10.25 3H13.75L14.4 5.6L16.75 6.6L19.05 5.2L20.8 6.95L19.4 9.25L20.4 11.6L23 12.25V11.75M3 10.25V13.75L5.6 14.4L6.6 16.75L5.2 19.05L6.95 20.8L9.25 19.4L11.6 20.4L12.25 23").replace(/.*/, "") +
      p("M10.4 3.25H13.6L14.25 5.75L16.4 6.65L18.6 5.3L20.7 7.4L19.35 9.6L20.25 11.75L22.75 12.4V11.6") .replace(/.*/, "") +
      `<path d="M10.5 3.5H13.5L14.1 5.9L16.2 6.8L18.3 5.5L20.5 7.7L19.2 9.8L20.1 11.9L22.5 12.5L22.5 11.5L20.1 12.1L19.2 14.2L20.5 16.3L18.3 18.5L16.2 17.2L14.1 18.1L13.5 20.5H10.5L9.9 18.1L7.8 17.2L5.7 18.5L3.5 16.3L4.8 14.2L3.9 12.1L1.5 11.5V12.5L3.9 11.9L4.8 9.8L3.5 7.7L5.7 5.5L7.8 6.8L9.9 5.9Z" />` +
      `<circle cx="12" cy="12" r="3.25"/>` + N(12, 12)],
    B: ["Package", "Comes with the framework: a box — what the library ships.",
      p("M12 3L20.5 7.5V16.5L12 21L3.5 16.5V7.5ZM3.5 7.5L12 12L20.5 7.5M12 12V21") + N(12, 7.5, 3)],
  },
  tool: {
    color: "#2a62c4", label: "Tool",
    A: ["Wrench", "The universal sign for a tool, drawn precise: an open jaw at 45°.",
      `<path d="M17.23 3.41L15.11 5.53L18.47 8.89L20.59 6.77A4.75 4.75 0 1 1 17.23 3.41Z"/>` + p("M12.64 11.36L3.75 20.25") + N(14.6, 9.4, 2.5)],
    B: ["Hammer", "A tool you swing: head and handle, square-cut.",
      p("M9.5 3.5H18.5V8H9.5ZM9.5 5.75H5.5M14 8V20.5") + N(16.25, 5.75, 2.5)],
  },
};

const T = (x, y, t, s = 14, f = "#7a7a7a", w = 400, a = "start") =>
  `<text x="${x}" y="${y}" font-family="Helvetica Neue" font-size="${s}" font-weight="${w}" fill="${f}" text-anchor="${a}">${t}</text>`;
const icon = (body, size, color) => {
  const sw = Math.max(1.5, (1.35 * 24) / size);
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="butt" stroke-linejoin="miter">${body.replaceAll("NODE", color)}</svg>`;
};
const at = (x, y, s) => `<g transform="translate(${x} ${y})">${s}</g>`;

let b = T(80, 92, "Kind icons · options", 32, "#111", 700) + T(80, 126, "Pick one per row — A or B. Same language as the set: 24 grid, 1.5 stroke, square ends, one node.", 16, "#5c5c5c");
let y = 180;
for (const [, k] of Object.entries(C)) {
  b += T(80, y + 20, k.label, 18, "#111", 700);
  ["A", "B"].forEach((opt, i) => {
    const [name, why, body] = k[opt];
    const x = 300 + i * 760;
    b += `<rect x="${x}" y="${y - 10}" width="720" height="190" rx="18" fill="#F6F5F3"/>`;
    b += at(x + 30, y + 15, icon(body, 120, k.color));
    b += T(x + 180, y + 30, `${opt} · ${name}`, 17, "#111", 600);
    b += T(x + 180, y + 56, why, 13.5, "#6a6a6a");
    [32, 24, 16].forEach((s, j) => { b += at(x + 180 + j * 64, y + 100, icon(body, s, k.color)); });
    b += `<rect x="${x + 400}" y="${y + 92}" width="290" height="48" rx="10" fill="#fff" stroke="#E2E2E0"/>`;
    b += at(x + 414, y + 108, icon(body, 16, k.color)) + T(x + 440, y + 121, k.label === "Tool" ? "list_vessels_tool" : k.label === "LLM" ? "z-ai/glm-5.3-flash" : k.label === "Framework tool" ? "read_file" : k.label === "Sub-agent" ? "noon_report_ledger" : "bosun_orchestrator", 13, "#171717", 500);
  });
  y += 220;
}
const W = 1900, H = y + 30;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fff"/>${b}</svg>`;
writeFileSync(new URL("./out/kinds-options.svg", import.meta.url), svg);
writeFileSync(new URL("./out/kinds-options.png", import.meta.url),
  new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "Helvetica Neue" }, fitTo: { mode: "width", value: 1900 } }).render().asPng());
console.log("ok");
