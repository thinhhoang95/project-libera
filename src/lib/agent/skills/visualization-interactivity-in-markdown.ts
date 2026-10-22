import type { AgentSkill } from "../tools";
import { finishLiveBlocks, LIVE_BLOCKS_CHECK, LIVE_BLOCKS_GUIDE } from "./live-blocks";

// Charts, Mermaid diagrams and live HTML "applets" in Markdown notes (and
// decks): when to use which, how to write them, and where they render. The
// block reference and the finish pass are shared with slide-deck
// (live-blocks.ts); slide layout itself is slide-deck's job.

export const VISUALIZATION_SKILL = "visualization-interactivity-in-markdown";

const instructions = `
# Charts, diagrams and interactive HTML in Markdown

Libera's Markdown can draw charts, diagrams and small interactive pages ("applets") from fenced code blocks, written into notes (\`.md\`) or slide decks (\`.slides.md\`). You write them with Edit and Write like any text.

## How to work

1. Find the data or the subject first. When the user points at numbers (a table in a note, a CSV or TSV file, figures in a PDF), Read them; use only those numbers. If there is nothing to work from and the user wants an illustration, say so in the chart's title or a line under it.
2. Choose the block (see "Which block to use"), and the place:
   - Into the note the user means, usually the open one, next to the text it illustrates, with a sentence before it saying what it shows.
   - When the user asks for a visual without naming a file, add it to the open note if it belongs there; otherwise create a new note in the current notebook. Never only paste a block into your reply: the chat shows blocks as code.
   - For a slide deck (\`.slides.md\`), load the slide-deck skill too: it covers slide layout, columns and fitting.
3. Write the block, then reply with what you added and where, in a sentence or two. The user sees it in the note's preview or the Visual editor.

When you edit an existing chart, diagram or applet, Read it first and keep its settings and style. Change only what the user asked.

In read-only permission you cannot change files: put the block in your answer as a fenced block the user can paste, and name the note it belongs in.

## Python figures

Besides these blocks, Libera can run Python (NumPy, SciPy, pandas, Matplotlib, seaborn, SymPy) and put its figures into a note as images; the code is kept in the note's \`.py\` sidecar, so the user can re-run and change it. That is the **python-results** skill: load it with the Skill tool, and follow it, when the visual needs code to compute: statistics, a regression or curve fit, a simulation, plotting a function or equation, a heat map, contour or 3-D surface from computed values, a scientific or publication-style plot, or a schematic easier to draw with Matplotlib than with Mermaid. Also load it when the user asks for Python, Matplotlib or a "plot" of something to calculate, or to re-run or change a figure named \`py-….png\`.

Use a block from this skill instead when the numbers are already there and the reader may want to hover them (\`chart\`), for a diagram of boxes and arrows (\`mermaid\`), and for anything the reader drags or types into (\`html live\`). Python figures are static images. They are not available in shared notebooks or in Read Only mode; use a block there.

${LIVE_BLOCKS_GUIDE}
## Notes

- In the Visual editor the block's code stays editable, with its drawing under it, redrawn half a second after typing stops. **Insert chart**, **Insert diagram** and **Insert interactive HTML** in its toolbar add starter blocks.
- Charts read a \`data:\` file relative to the note: \`data: sales.csv\` for a file next to it, \`data: ../data/sales.csv\` for one in another folder of the same notebook.
- A note's blocks follow the app's light or dark theme and change with it, so never assume a white background in live HTML: use \`libera.theme\`.
- Several small charts read better than one crowded chart: one idea per chart, with a title that states it ("Revenue grew 20% in 2026", not "Revenue").
${LIVE_BLOCKS_CHECK}`;

export const visualizationInteractivitySkill: AgentSkill = {
  name: VISUALIZATION_SKILL,
  description: "Add or edit charts (```chart), Mermaid diagrams (```mermaid: flowcharts, sequence, class, ER, Gantt, mind maps, timelines) and interactive HTML/JavaScript applets (```html live: calculators, sliders, simulations, custom charts) in Markdown notes and slides. Use when the user asks to visualize data, make or change a chart, graph, plot or diagram, draw a process or structure, or build a small interactive widget, calculator or applet. Plots that need computing are drawn with Python (python-results skill).",
  instructions,
  finishPass: finishLiveBlocks,
};
