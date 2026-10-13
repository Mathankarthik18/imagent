// imagent brand — round 1: three logo directions + the icon language.
// Everything is drawn as geometry (no fonts in the artwork); board labels use SF Pro.
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = new URL("./out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const FONT = { loadSystemFonts: true, defaultFontFamily: "Helvetica Neue" };

function render(name, svg, width) {
  const png = new Resvg(svg, { font: FONT, fitTo: { mode: "width", value: width } }).render().asPng();
  writeFileSync(OUT + name + ".png", png);
  writeFileSync(OUT + name + ".svg", svg);
}

// ── wordmark: "imagent" built from monoline strokes (x-height 12, stroke set by caller) ──────────────
// Each glyph: [width, svg-path (stroke), extra (filled) ] in a box whose x-height runs y=0..12.
const G = {
  i: [0, "M0 0V12", "dot"],
  m: [16, "M0 12V0M0 4A4 4 0 0 1 8 4V12M8 4A4 4 0 0 1 16 4V12"],
  a: [12, "M12 0V12M12 6A6 6 0 1 0 12 6.01"],
  g: [12, "M12 0V15A5 5 0 0 1 7 20H2M12 6A6 6 0 1 0 12 6.01"],
  e: [12, "M0.4 6H12A6 6 0 1 0 10.1 10.4"],
  n: [8, "M0 12V0M0 4A4 4 0 0 1 8 4V12"],
  t: [6, "M1.6 -4V9A3 3 0 0 0 4.6 12H7M-1 0H6"],
};
function wordmark({ x, y, scale, stroke, ink, accent, track = 3.6 }) {
  let cx = 0, out = "";
  for (const ch of "imagent") {
    const [w, d, extra] = G[ch];
    out += `<path d="${d}" transform="translate(${cx} 0)" fill="none" stroke="${ink}" stroke-width="${stroke}" stroke-linecap="butt" stroke-linejoin="miter"/>`;
    if (extra === "dot") out += `<rect x="${cx - stroke * 0.85}" y="${-4.6 - stroke * 0.85}" width="${stroke * 1.7}" height="${stroke * 1.7}" fill="${accent}"/>`;
    cx += w + track + (ch === "i" ? stroke * 0.4 : 0);
  }
  return `<g transform="translate(${x} ${y}) scale(${scale})">${out}</g>`;
}

// ── three marks on a 48-unit grid ─────────────────────────────────────────────────────────────────
const MARKS = {
  // A · Trace i — the letter i as a trace: a root node, the run, and the branch it spawns.
  trace: (ink, accent, sw = 4) => `
    <rect x="11" y="6" width="9" height="9" fill="${accent}"/>
    <path d="M15.5 20V31A6 6 0 0 0 21.5 37H33" fill="none" stroke="${ink}" stroke-width="${sw}" stroke-linecap="butt"/>
    <rect x="32.5" y="32.5" width="9" height="9" fill="none" stroke="${ink}" stroke-width="${sw}"/>`,
  // B · Waterfall — three spans of a run, each starting where the last one handed off.
  waterfall: (ink, accent, sw = 4) => `
    <rect x="7" y="9" width="9" height="${sw * 2}" fill="${accent}"/>
    <rect x="19" y="9" width="22" height="${sw * 2}" fill="${ink}"/>
    <rect x="15" y="20" width="22" height="${sw * 2}" fill="${ink}"/>
    <rect x="23" y="31" width="18" height="${sw * 2}" fill="${ink}" opacity="0.45"/>`,
  // C · Bracket — an agent held in view: the node inside [ ], the way code holds a value.
  lens: (ink, accent, sw = 4) => `
    <path d="M15 8H8V40H15M33 8H40V40H33" fill="none" stroke="${ink}" stroke-width="${sw}" stroke-linecap="butt" stroke-linejoin="miter"/>
    <rect x="19" y="19" width="10" height="10" fill="${accent}"/>`,
};

const DIRECTIONS = [
  { key: "trace", title: "A · Trace", line: "The i is a trace: a root node, the run it starts, the branch it spawns.",
    palette: { name: "Signal", ink: "#0E1013", paper: "#F5F6F2", accent: "#B6F23C", accentInk: "#3F6B06", mid: "#6B7068",
      swatches: [["Ink", "#0E1013"], ["Paper", "#F5F6F2"], ["Signal", "#B6F23C"], ["Signal (text)", "#3F6B06"], ["Graphite", "#6B7068"]] } },
  { key: "waterfall", title: "B · Waterfall", line: "Three spans handing off — the shape every trace in imagent takes.",
    palette: { name: "Ion", ink: "#0D0E1A", paper: "#F6F6FB", accent: "#5B5CFF", accentInk: "#4344D6", mid: "#686A82",
      swatches: [["Ink", "#0D0E1A"], ["Paper", "#F6F6FB"], ["Ion", "#5B5CFF"], ["Cyan", "#20C9E6"], ["Slate", "#686A82"]] } },
  { key: "lens", title: "C · Bracket", line: "An agent held in view — one node inside [ ], the way code holds a value.",
    palette: { name: "Ember", ink: "#121212", paper: "#F7F5F2", accent: "#FF5B2E", accentInk: "#C2410C", mid: "#76716B",
      swatches: [["Ink", "#121212"], ["Paper", "#F7F5F2"], ["Ember", "#FF5B2E"], ["Amber", "#F2A93B"], ["Stone", "#76716B"]] } },
];

const label = (x, y, t, size = 15, fill = "#6b6b6b", weight = 400, anchor = "start") =>
  `<text x="${x}" y="${y}" font-family="Helvetica Neue" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${t}</text>`;

function board(d) {
  const p = d.palette, W = 1800, H = 1120, mark = MARKS[d.key];
  const tile = (x, y, size, bg, ink, accent, r = 0.225) =>
    `<g transform="translate(${x} ${y})"><rect width="${size}" height="${size}" rx="${size * r}" fill="${bg}"/>
      <g transform="translate(${size * 0.17} ${size * 0.17}) scale(${(size * 0.66) / 48})">${mark(ink, accent)}</g></g>`;
  const lockup = (x, y, h, ink, accent) =>
    `<g transform="translate(${x} ${y}) scale(${h / 48})">${mark(ink, accent)}</g>` +
    wordmark({ x: x + h * 1.22, y: y + h * 0.36, scale: h / 30, stroke: 2.15, ink, accent });
  const sizes = [64, 32, 24, 16].map((s, i) =>
    `<g transform="translate(${1130 + i * 110} 822)"><g transform="scale(${s / 48})">${mark(p.ink, p.accent, s <= 24 ? 5 : 4)}</g>
     ${label(s / 2, s + 26, `${s}px`, 13, "#8a8a8a", 400, "middle")}</g>`).join("");
  const sw = p.swatches.map(([n, hex], i) =>
    `<g transform="translate(${80 + i * 150} 900)"><rect width="128" height="80" rx="10" fill="${hex}" stroke="#00000014"/>
      ${label(0, 106, n, 14, "#1a1a1a", 600)}${label(0, 126, hex, 13, "#8a8a8a")}</g>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="#FFFFFF"/>
    ${label(80, 92, d.title, 34, "#111", 700)}
    ${label(80, 128, d.line, 18, "#5c5c5c")}
    ${label(W - 80, 92, `Palette · ${p.name}`, 16, "#8a8a8a", 500, "end")}

    <!-- hero: mark on paper and on ink -->
    <rect x="80" y="170" width="520" height="520" rx="28" fill="${p.paper}"/>
    <g transform="translate(180 270) scale(${320 / 48})">${mark(p.ink, p.accent)}</g>
    <rect x="630" y="170" width="520" height="520" rx="28" fill="${p.ink}"/>
    <g transform="translate(730 270) scale(${320 / 48})">${mark("#F5F5F5", p.accent)}</g>

    <!-- lockups -->
    <rect x="1180" y="170" width="540" height="250" rx="22" fill="${p.paper}"/>
    ${lockup(1236, 259, 72, p.ink, p.accentInk)}
    <rect x="1180" y="440" width="540" height="250" rx="22" fill="${p.ink}"/>
    ${lockup(1236, 529, 72, "#F2F2F2", p.accent)}

    <!-- app icons -->
    ${label(80, 760, "App icon", 15, "#1a1a1a", 600)}
    ${tile(80, 780, 96, p.ink, "#F5F5F5", p.accent)}
    ${tile(196, 796, 64, p.accent, p.ink, p.ink)}
    ${tile(280, 812, 32, p.ink, "#F5F5F5", p.accent)}
    ${label(420, 760, "In the product · sidebar", 15, "#1a1a1a", 600)}
    <rect x="420" y="780" width="300" height="56" rx="12" fill="#FAFAFA" stroke="#E6E6E6"/>
    ${lockup(440, 794, 28, "#141414", p.accentInk)}
    <rect x="740" y="780" width="300" height="56" rx="12" fill="#141414"/>
    ${lockup(760, 794, 28, "#EDEDED", p.accent)}
    ${label(1130, 760, "Small sizes", 15, "#1a1a1a", 600)}
    ${sizes}
    ${sw}
  </svg>`;
}

for (const d of DIRECTIONS) render(`logo-${d.key}`, board(d), 1800);

// ── icon language: the rules every icon follows, shown on 12 samples ─────────────────────────────
// Rules: 24 grid · 2px padding · 1.5 stroke · butt caps, miter joins · 45°/90° only · circles as the only curves
//        · one solid square "node" (2.5×2.5) per icon — the logo's node, the mark of the family.
const N = (x, y, c = "currentColor") => `<rect x="${x - 1.25}" y="${y - 1.25}" width="2.5" height="2.5" fill="${c}"/>`;
const ICONS = {
  overview: (a) => `<path d="M3 21H21M6 17V11M11 17V6M16 17V13"/>${N(16, 8.5, a)}`,
  traces: (a) => `<path d="M7 6H21M9 12H18M11 18H21"/>${N(3.5, 6, a)}`,
  blueprint: (a) => `<path d="M9 3H15V8H9ZM3 16H9V21H3ZM15 16H21V21H15ZM12 8V12M6 16V12H18V16"/>${N(12, 12, a)}`,
  experiments: (a) => `<path d="M9 3V9L4 19V21H20V19L15 9V3M7.5 3H16.5M6 15H18"/>${N(12, 18, a)}`,
  agent: (a) => `<path d="M8 4H4V20H8M16 4H20V20H16"/>${N(12, 12, a)}`,
  llm: (a) => `<path d="M7 7H17V17H7ZM10 7V4M14 7V4M10 20V17M14 20V17M7 10H4M7 14H4M20 10H17M20 14H17"/>${N(12, 12, a)}`,
  tool: (a) => `<path d="M3.5 20.5L12 12M12 12L9.5 9.5L15 4L20 9L14.5 14.5Z"/>${N(14.5, 9, a)}`,
  search: (a) => `<path d="M10.5 3.5A7 7 0 1 0 10.5 17.5A7 7 0 1 0 10.5 3.5ZM15.5 15.5L21 21"/>${N(10.5, 10.5, a)}`,
  copy: (a) => `<path d="M8 8H20V20H8ZM16 8V4H4V16H8"/>${N(14, 14, a)}`,
  external: (a) => `<path d="M14 4H20V10M20 4L11 13M17 14V20H4V7H10"/>${N(20, 4, a)}`,
  close: (a) => `<path d="M5 5L19 19M19 5L5 19"/>${N(12, 12, a)}`,
  check: (a) => `<path d="M4 12.5L9.5 18L20 6"/>${N(9.5, 18, a)}`,
};
function iconSheet(d) {
  const p = d.palette, W = 1800, H = 1000, keys = Object.keys(ICONS);
  const icon = (k, x, y, size, ink, accent, sw = 1.5) =>
    `<g transform="translate(${x} ${y}) scale(${size / 24})" fill="none" stroke="${ink}" stroke-width="${sw}" stroke-linecap="butt" stroke-linejoin="miter" color="${ink}">
       ${ICONS[k](accent).replace(/<rect/g, `<rect stroke="none"`)}</g>`;
  const grid = (x, y, s) => {
    let g = `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="#FAFAFA" stroke="#E2E2E2"/>`;
    for (let i = 1; i < 24; i++) g += `<path d="M${x + (i * s) / 24} ${y}V${y + s}M${x} ${y + (i * s) / 24}H${x + s}" stroke="#EFEFEF" stroke-width="1"/>`;
    g += `<rect x="${x + (2 * s) / 24}" y="${y + (2 * s) / 24}" width="${(20 * s) / 24}" height="${(20 * s) / 24}" fill="none" stroke="${p.accent}" stroke-dasharray="6 6" stroke-width="1.5"/>`;
    return g;
  };
  const rules = [
    ["Grid", "24 × 24, 2px safe padding"], ["Stroke", "1.5 at 24px — scales with size"], ["Ends", "Butt caps, mitred corners — exact, no blobs"],
    ["Angles", "90° and 45° only; circles are the only curves"], ["The node", "One solid 2.5 square per icon — the logo's node"],
    ["Colour", "Icons in ink; only the node may take the accent"],
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="#FFFFFF"/>
    ${label(80, 92, "Icon language", 34, "#111", 700)}
    ${label(80, 128, "One set of rules, so every icon is unmistakably imagent — shown with direction " + d.title.split(" ")[0] + "'s " + p.name + " accent.", 18, "#5c5c5c")}
    ${grid(80, 180, 384)}
    ${icon("blueprint", 80, 180, 384, "#141414", p.accent, 1.5)}
    ${rules.map(([k, v], i) => `${label(510, 210 + i * 62, k, 16, "#1a1a1a", 600)}${label(510, 234 + i * 62, v, 15, "#6a6a6a")}`).join("")}
    ${keys.map((k, i) => {
      const col = i % 6, row = Math.floor(i / 6), x = 980 + col * 130, y = 180 + row * 170;
      return `<rect x="${x}" y="${y}" width="110" height="110" rx="16" fill="#F7F7F7"/>${icon(k, x + 31, y + 31, 48, "#151515", p.accentInk)}
              ${label(x + 55, y + 136, k, 13, "#7a7a7a", 400, "middle")}`;
    }).join("")}
    ${label(80, 640, "At real sizes", 16, "#1a1a1a", 600)}
    <rect x="80" y="660" width="820" height="90" rx="14" fill="#FAFAFA" stroke="#ECECEC"/>
    ${keys.map((k, i) => icon(k, 104 + i * 66, 686, 24, "#1c1c1c", p.accentInk)).join("")}
    <rect x="80" y="770" width="820" height="90" rx="14" fill="${p.ink}"/>
    ${keys.map((k, i) => icon(k, 104 + i * 66, 796, 24, "#E8E8E8", p.accent)).join("")}
    ${label(80, 900, "16px", 13, "#8a8a8a")}
    ${keys.map((k, i) => icon(k, 124 + i * 40, 884, 16, "#1c1c1c", p.accentInk, 1.6)).join("")}
  </svg>`;
}
render("icon-language", iconSheet(DIRECTIONS[0]), 1800);
console.log("rendered:", OUT);
