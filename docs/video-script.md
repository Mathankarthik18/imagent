# imagent — highlight video script

**For the video-generation agent.** Produce a ~2 min 30 s product highlight video from the scenes
below. Each scene lists its length, what is on screen, the on-screen text, and the voiceover.
Use real screen recordings of the imagent UI where a scene says **[SCREEN]**; generate motion
graphics where it says **[MOTION]**.

## Global direction

- **Format:** 16:9, 1920×1080, 30 fps. Also export a 9:16 cut (scenes 1, 2, 6, 7, 9 only).
- **Tone:** calm, confident, developer-to-developer. No hype words ("revolutionary", "game-changing").
- **Voice:** one narrator, warm, mid-paced (~150 words/min). Plain English.
- **Look:** light UI, generous padding. Screen recordings zoom smoothly (1.0 → 1.25×) onto the
  element being described; cursor visible and slowed down. Accent colour: imagent orange.
- **Typography:** on-screen text in a clean sans (Inter or similar), max 7 words per line,
  bottom-left lower-thirds; key numbers large and centred.
- **Music:** light electronic, low under the voice, small lift at scenes 6 and 9.
- **Captions:** burn in subtitles of the voiceover.
- **Accuracy:** imagent is installed from GitHub (it is not on PyPI) — never show `pip install imagent` on its own.

---

## Scene 1 — The hook (0:00–0:15) [SCREEN → MOTION]

**Visual:** open on one real trace in the flow canvas: the main agent, a sub-agent, its model
and tool calls. The model chip on a node swaps (`glm-5.3-flash` → `claude-haiku-5.5`), and
four question marks pop up next to parts of the run, one per beat of the voiceover:
- next to the cost: **$ ?**
- next to the tool calls: **🔧 ?**
- next to the sub-agents: **which agents ?**
- next to the final answer: **better ?**

Then a quick cut to the matching answers in imagent's experiment result: cost **−62%**, tool
calls **15 → 9**, a skipped sub-agent, and the verdict badge.

**On-screen text (one line per beat):**
"If I change the model on this run…"
"Will it cost less?"
"Will it call the same tools?"
"Will it use the same agents?"
"Will the answer still be right?"

**Voiceover:**
> Take one real run of your agent. Now change its model. Does it cost less? Does it still call
> the right tools — or more of them? Does it hand off to the same agents? And is the answer
> still right? imagent shows you all four — on your own runs, before you ship the change.

---

## Scene 2 — What imagent is (0:15–0:24) [MOTION]

**Visual:** the imagent logo; three cards slide in: **Traces · Blueprint · Experiments**.
Small badges underneath: "Self-hosted", "Open source", "No trace limits", "OpenTelemetry".

**On-screen text:** "Observability + experiments for AI agents"

**Voiceover:**
> imagent is a self-hosted monitoring tool for AI agents. It records every run, draws your
> agent's architecture, and lets you test other models on real traffic. No trace limits, no
> per-seat pricing — it runs on your own machine.

---

## Scene 3 — Setup in three lines (0:24–0:38) [SCREEN]

**Visual:** the **New project** dialog → the project key is shown once → the three connect
steps. Then a terminal and a code file:

```bash
pip install "imagent @ git+https://github.com/Mathankarthik18/imagent.git#subdirectory=sdk"
```
```env
IMAGENT_API_KEY=imk_…
```
```python
import imagent
imagent.init()
```

Then a row of framework logos lights up: LangChain / LangGraph / deepagents, OpenAI Agents SDK,
LlamaIndex, CrewAI, OpenAI SDK, Anthropic SDK.

**On-screen text:** "One key. One line. Any framework."

**Voiceover:**
> Create a project, copy its key, and add one line to your app. imagent picks up whatever you
> build with — LangGraph, deepagents, the OpenAI Agents SDK, LlamaIndex, CrewAI, or plain
> OpenAI and Anthropic calls.

---

## Scene 4 — Every run, as it happened (0:38–0:58) [SCREEN]

**Visual:** **Traces** page (By thread) → click a conversation → the flow canvas: main agent at
the top, a sub-agent box with its model calls and tools inside. Click **Replay**: the run plays
back step by step, the answer types itself out on the right. Point at the stats line
(duration, LLM calls, tool calls, tokens, cost).

**On-screen text:** "See every step, every tool, every token"

**Voiceover:**
> Every run shows up as a flow: the main agent, its sub-agents, every model call and tool call
> — with timing, tokens and cost. Hit Replay and watch the run unfold exactly as it happened.

---

## Scene 5 — The blueprint, read from your code (0:58–1:16) [SCREEN]

**Visual:** **Blueprint** page: the orchestrator card on top, a frame of 20+ sub-agent cards
below, each with its model and run stats. Click a sub-agent → side panel: **Overview** (runs,
p50/p95, cost, models used), **Tools** (called vs never called), **Prompt**, **Framework**
(middleware chain). Then show a new sub-agent card appearing on its own.

**On-screen text:** "Your architecture — always up to date"

**Voiceover:**
> The Blueprint is your agent's architecture, read straight from the framework: every agent,
> sub-agent, model, prompt, tool and middleware — with live numbers from real traffic. Add an
> agent in code, and it appears here on its own.

---

## Scene 6 — Try another model, from any run (1:16–1:38) [SCREEN]

**Visual:** on a trace, select a sub-agent → the button reads **Try another model for
vessel_qa** → click. The **New experiment** page opens straight on the agents step: the
**agent × model matrix**. Click **+ Model**, add a cheaper model as a column, click one cell to
move an agent to it (orange dot = changed). Show a column's **All →** moving every agent.
Then **Options**: "Use the recorded results (recommended)".

**On-screen text:** "Change one agent's model. Or all of them."

**Voiceover:**
> Found a run you care about? Click Try another model. Pick new models in one grid — one agent,
> a few, or all of them. imagent replays your real runs inside your app, and by default every
> tool answers from the recording — so nothing real gets sent, written or changed.

---

## Scene 7 — Is the answer actually better? (1:38–2:02) [SCREEN]

**Visual:** the experiment results page, answering the hook's four questions in order:
**cost** and **time** against the original, **tool calls** (same tools called, skipped tools),
**which agents** ran, then **Answers vs original: Worse** with the quality bar and the
criteria table (Correct / Complete / Clear: original vs new). Open the replay: **"Which answer is better?"** with the
AI judge's reason highlighted: *"invents an inspection email and a thread ID not in the tool
data."* Hover the three review buttons.

**On-screen text (large, centred, one at a time):**
"80% faster" → "but it made things up" → "Worse."

**Voiceover:**
> And here's the part that matters. The original run isn't treated as the truth. A judge model
> compares both answers blind — against the real tool data, for correctness, completeness and
> your own rules. In this test, the faster model was eighty percent quicker… but it invented
> facts. imagent caught it. And you can always overrule the judge with one click.

---

## Scene 8 — Safe by default, full access when you want it (2:02–2:14) [SCREEN]

**Visual:** the tool options with **Run every tool for real** selected and the red
confirmation box. Then the experiment list as a table: variants with better/tie/worse bars and
a ★ on the best one.

**On-screen text:** "Recorded by default. Live when you choose."

**Voiceover:**
> Need the new model to explore freely? Switch to live tools, confirm, and it runs for real.
> Every experiment lands in one list, with the best variant starred.

---

## Scene 9 — Close (2:14–2:30) [MOTION]

**Visual:** recap with the three cards (**Traces · Blueprint · Experiments**) → the line
"Switch models with evidence, not guesses." → logo and the GitHub URL.

**On-screen text:**
"Switch models with evidence, not guesses."
"github.com/Mathankarthik18/imagent"

**Voiceover:**
> imagent. See every run, know your architecture, and switch models with evidence — not
> guesses. Self-hosted and open source.

---

## Recording checklist (for whoever captures the screens)

1. Use a project with a few dozen real runs and a multi-agent app (the Bosun project works:
   orchestrator + 21 sub-agents).
2. Hide or blur anything sensitive: API keys, email addresses, customer and vessel names in
   inputs and outputs.
3. Light theme and dark theme both work — pick one for the whole video (dark recommended).
4. Browser at 1920×1080, zoom 110%, no bookmarks bar, no notifications.
5. Before scene 7, make sure the AI judge is on (**Settings → Judging experiment answers**) and
   the experiment has finished, so the verdict and reason are visible.
