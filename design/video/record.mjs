// Records the imagent demo video: drives the real app in Chrome, captures frames via the
// DevTools screencast (with timestamps), and assembles title + scenes + end card with ffmpeg.
import puppeteer from "puppeteer-core";
import ffmpeg from "ffmpeg-static";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const V = process.argv[2];                  // work dir (has title.png, end.png)
const TRACE = process.argv[3];
const BASE = "http://localhost:8300";
const FR = `${V}/frames`;
rmSync(FR, { recursive: true, force: true });
mkdirSync(FR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new", args: ["--hide-scrollbars", "--window-size=1280,800"],
  defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);

// Overlay: a soft cursor and a caption bar, re-created on every page.
await page.evaluateOnNewDocument(() => {
  const css = `
    #__cur{position:fixed;z-index:2147483647;width:22px;height:22px;pointer-events:none;transform:translate(-3px,-2px);transition:none}
    #__cur.click::after{content:"";position:absolute;left:-14px;top:-14px;width:44px;height:44px;border-radius:50%;
      border:2px solid rgba(255,91,46,.9);animation:__p .5s ease-out forwards}
    @keyframes __p{from{transform:scale(.3);opacity:1}to{transform:scale(1.2);opacity:0}}
    #__cap{position:fixed;z-index:2147483646;pointer-events:none;left:556px;top:6px;transform:translateX(-50%);width:max-content;max-width:600px;
      display:flex;align-items:center;gap:10px;padding:8px 16px;border-radius:10px;background:rgba(18,18,18,.92);
      border:1px solid rgba(255,255,255,.12);box-shadow:0 12px 40px rgba(0,0,0,.45);color:#F5F5F2;
      font:500 14px/1.3 Inter,-apple-system,"Helvetica Neue",sans-serif;opacity:0;transition:opacity .35s}
    #__cap.on{opacity:1}#__cap i{flex:none;width:8px;height:8px;background:#FF5B2E}
    #__cap b{color:#FF8A63;font-weight:600;margin-right:6px}`;
  addEventListener("DOMContentLoaded", () => {
    const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
    const c = document.createElement("div"); c.id = "__cur";
    c.innerHTML = `<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2L18 11.5L11 13L8 20Z" fill="#F5F5F2" stroke="#121212" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
    const p = JSON.parse(sessionStorage.getItem("__cur") || "[640,400]"); c.style.left = p[0] + "px"; c.style.top = p[1] + "px";
    document.body.appendChild(c);
    const cap = document.createElement("div"); cap.id = "__cap"; document.body.appendChild(cap);
  });
  window.__caption = (step, text) => {
    const cap = document.getElementById("__cap"); if (!cap) return;
    cap.classList.remove("on");
    setTimeout(() => { cap.innerHTML = `<i></i><span>${step ? `<b>${step}</b>` : ""}${text}</span>`; cap.classList.add("on"); }, 180);
  };
  window.__move = (x, y, ms) => new Promise((done) => {
    const c = document.getElementById("__cur"); const sx = parseFloat(c.style.left), sy = parseFloat(c.style.top); const t0 = performance.now();
    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    const step = (now) => { const t = Math.min(1, (now - t0) / ms), e = ease(t);
      c.style.left = sx + (x - sx) * e + "px"; c.style.top = sy + (y - sy) * e + "px";
      sessionStorage.setItem("__cur", JSON.stringify([x, y])); t < 1 ? requestAnimationFrame(step) : done(); };
    requestAnimationFrame(step);
  });
  window.__click = () => { const c = document.getElementById("__cur"); c.classList.remove("click"); void c.offsetWidth; c.classList.add("click"); };
});

// Screencast frames with timestamps.
const frames = [];
const cdp = await page.createCDPSession();
cdp.on("Page.screencastFrame", async (f) => {
  const file = `${FR}/f${String(frames.length).padStart(5, "0")}.jpg`;
  writeFileSync(file, Buffer.from(f.data, "base64"));
  frames.push({ file, t: f.metadata.timestamp });
  await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
});

const caption = (step, text) => page.evaluate((s, t) => window.__caption?.(s, t), step, text);
async function moveTo(handleOrSel, ms = 700) {
  const el = typeof handleOrSel === "string" ? await page.waitForSelector(handleOrSel, { visible: true, timeout: 15000 }) : handleOrSel;
  const box = await el.boundingBox();
  const x = box.x + Math.min(box.width / 2, 60), y = box.y + box.height / 2;
  await page.evaluate((x, y, ms) => window.__move(x, y, ms), x, y, ms);
  return { el, x, y };
}
async function click(handleOrSel, ms = 700) {
  const { el } = await moveTo(handleOrSel, ms);
  await page.evaluate(() => window.__click());
  await sleep(160);
  await el.click();
}
const byText = async (tag, text) => {
  const h = await page.waitForFunction((tag, text) => [...document.querySelectorAll(tag)].find((e) => e.textContent.trim() === text || e.textContent.trim().startsWith(text)), { timeout: 20000 }, tag, text);
  return h.asElement();
};
async function go(url) { await page.goto(BASE + url, { waitUntil: "networkidle0" }); await sleep(600); }

await go("/p/demo/traces?view=list");
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });

// 1 · traces
await caption("1", "Every agent run is traced — tokens, cost, latency and errors, with no trace limits.");
await sleep(3200);
await moveTo("tbody tr:nth-child(2)", 900); await sleep(800);
await caption("1", "Open a run to see the whole agent: main agent, sub-agents, model and tool calls.");
await go(`/p/demo/traces/${TRACE}`);
await caption("1", "Open a run to see the whole agent: main agent, sub-agents, model and tool calls.");
await sleep(2600);
await click(await byText("button", "Replay"));
await caption("2", "Replay plays the run back step by step — what it read, what it called, what it answered.");
await sleep(7500);

// 3 · blueprint
await go("/p/demo/blueprint");
await caption("3", "The blueprint: your app's structure, read from the framework — with live stats per agent.");
await sleep(1200);
await moveTo(await byText("div", "email_router"), 900);
await sleep(3200);

// 4 · pick runs → new experiment
await go("/p/demo/traces?view=list");
await caption("4", "Now the question: is a cheaper model good enough? Pick a few real runs…");
const boxes = await page.$$("tbody input[type=checkbox]");
for (const b of boxes.slice(0, 3)) { await click(b, 520); await sleep(250); }
await sleep(600);
await click(await byText("button", "Replay with another model"));
await page.waitForSelector("input[placeholder^='e.g.']", { visible: true });
await sleep(500);
await caption("4", "…and the model to try. Replays run inside your app, with tools answered from the recording.");
await sleep(1500);
await click("input[placeholder^='e.g.']", 800);
await page.keyboard.type("cheap", { delay: 120 });
await sleep(1200);
await click(await byText("button", "Run experiment"), 900);

// 5 · results
await page.waitForFunction(() => location.pathname.includes("/experiments/") && !location.pathname.endsWith("/new"), { timeout: 20000 });
await caption("5", "Each replay is compared with its original run…");
await page.waitForFunction(() => document.body.innerText.includes("3/3 replays"), { timeout: 60000 }).catch(() => {});
await sleep(2500);
await caption("5", "…the cheap model behaved differently: it skipped creating the task.");
await sleep(3000);
const chip = await page.waitForFunction(() => [...document.querySelectorAll("button")].find((b) => /not judged|judge failed/.test(b.textContent)), { timeout: 20000 });
await click(chip.asElement(), 900);
await caption("5", "Open any replay to see exactly what changed — tool calls aligned, answers side by side.");
await sleep(4000);
await click(await byText("button", "Original is better"), 900);
await caption("6", "You decide which answer is better — or let the AI judge compare them blind.");
await sleep(3500);
await page.keyboard.press("Escape");
await sleep(1200);
await caption("6", "Answer: not yet. Without imagent, you'd have found out in production.");
await sleep(4200);

await cdp.send("Page.stopScreencast");
await browser.close();

// Assemble: title clip + recorded scenes (frames at their real timing) + end clip, joined with the concat filter.
const lines = ["ffconcat version 1.0"];
for (let i = 0; i < frames.length; i++) {
  const d = i + 1 < frames.length ? Math.max(0.02, frames[i + 1].t - frames[i].t) : 0.6;
  lines.push(`file '${frames[i].file}'`, `duration ${d.toFixed(3)}`);
}
lines.push(`file '${frames.at(-1).file}'`);
writeFileSync(`${V}/list.ffconcat`, lines.join("\n"));
const enc = ["-c:v", "libx264", "-crf", "20", "-preset", "slow", "-pix_fmt", "yuv420p", "-r", "30"];
execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-loop", "1", "-t", "3.6", "-i", `${V}/title.png`, "-vf", "scale=1280:800,fps=30", ...enc, `${V}/seg-title.mp4`]);
execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${V}/list.ffconcat`, "-vf", "scale=1280:800:flags=lanczos,fps=30", ...enc, `${V}/seg-main.mp4`]);
execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-loop", "1", "-t", "4.2", "-i", `${V}/end.png`, "-vf", "scale=1280:800,fps=30", ...enc, `${V}/seg-end.mp4`]);
execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-i", `${V}/seg-title.mp4`, "-i", `${V}/seg-main.mp4`, "-i", `${V}/seg-end.mp4`,
  "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", ...enc, "-movflags", "+faststart", `${V}/imagent-demo.mp4`]);
execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-i", `${V}/imagent-demo.mp4`, "-vf",
  "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4", `${V}/imagent-demo.gif`]);
console.log(JSON.stringify({ frames: frames.length, seconds: frames.length ? frames.at(-1).t - frames[0].t : 0 }));
