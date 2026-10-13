// Title and end cards for the demo video (1280×800), in the brand.
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";
const OUT = process.argv[2];
const EMBER = "#FF5B2E", INK = "#121212", PAPER = "#F5F5F2", MUTED = "#8C8A86";
const GLYPHS = [["i",0,"M0 0V12"],["m",16,"M0 12V0M0 4A4 4 0 0 1 8 4V12M8 4A4 4 0 0 1 16 4V12"],["a",12,"M12 0V12M12 6A6 6 0 1 0 12 6.01"],
  ["g",12,"M12 0V15A5 5 0 0 1 7 20H2M12 6A6 6 0 1 0 12 6.01"],["e",12,"M0.4 6H12A6 6 0 1 0 10.1 10.4"],["n",8,"M0 12V0M0 4A4 4 0 0 1 8 4V12"],["t",6,"M1.6 -4V9A3 3 0 0 0 4.6 12H7M-1 0H6"]];
const wordmark = (x, y, s) => { let cx = 0, p = ""; for (const [ch, w, d] of GLYPHS) { p += `<path d="${d}" transform="translate(${cx} 0)"/>`; cx += w + 3.6 + (ch === "i" ? 0.86 : 0); }
  return `<g transform="translate(${x} ${y}) scale(${s})"><g fill="none" stroke="${PAPER}" stroke-width="2.15">${p}</g><rect x="-1.83" y="-6.43" width="3.66" height="3.66" fill="${EMBER}"/></g>`; };
const mark = (x, y, size) => `<g transform="translate(${x} ${y}) scale(${size / 40}) translate(-4 -4)"><rect x="11" y="6" width="9" height="9" fill="${EMBER}"/>
  <path d="M15.5 20V31A6 6 0 0 0 21.5 37H32.5" fill="none" stroke="${PAPER}" stroke-width="4"/><rect x="32.5" y="32.5" width="9" height="9" fill="none" stroke="${PAPER}" stroke-width="4"/></g>`;
const T = (x, y, t, s, f, w = 400, a = "middle", fam = "Helvetica Neue") => `<text x="${x}" y="${y}" font-family="${fam}" font-size="${s}" font-weight="${w}" fill="${f}" text-anchor="${a}">${t}</text>`;
const grid = () => { let g = ""; for (let x = 0; x <= 1280; x += 32) g += `<path d="M${x} 0V800" stroke="#fff" stroke-opacity="0.035"/>`; for (let y = 0; y <= 800; y += 32) g += `<path d="M0 ${y}H1280" stroke="#fff" stroke-opacity="0.035"/>`; return g; };
const card = (name, body) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800"><rect width="1280" height="800" fill="${INK}"/>${grid()}${body}</svg>`;
  writeFileSync(`${OUT}/${name}.png`, new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "Helvetica Neue" }, fitTo: { mode: "width", value: 1280 } }).render().asPng());
};
card("title", `${mark(486, 200, 60)}${wordmark(568, 222, 2.6)}
  ${T(640, 400, "Can I switch my agent to a cheaper model?", 40, PAPER, 500)}
  ${T(640, 450, "Let's find out — on real runs, without touching production.", 22, MUTED)}
  <rect x="619" y="530" width="12" height="12" fill="${EMBER}"/>${T(640, 586, "imagent · self-hosted observability for AI agents", 16, MUTED)}`);
card("end", `${mark(412, 250, 90)}${wordmark(536, 284, 3.8)}
  ${T(640, 430, "Self-hosted observability for AI agents.", 32, PAPER, 500)}
  <rect x="440" y="480" width="400" height="56" rx="12" fill="#1C1C1B" stroke="#fff" stroke-opacity="0.12"/>
  ${T(640, 516, "$ docker compose up -d", 22, "#E8E6E1", 400, "middle", "Menlo")}
  ${T(640, 590, "github.com/Mathankarthik18/imagent  ·  MIT", 18, MUTED)}`);
console.log("cards ok");
