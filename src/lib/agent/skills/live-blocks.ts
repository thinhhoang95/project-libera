import { isMarkdownSlidesPath, parseMarkdownSlides } from "@/lib/markdown-slides";
import { parseSlideChartSpec } from "@/lib/slide-charts";
import { getFileType } from "@/lib/storage/file-types";
import { readCurrentText, resolve, type ToolContext } from "../tools";

// What the slide-deck and visualization-interactivity-in-markdown skills
// share: the reference for the three live blocks (```chart, ```mermaid,
// ```html live), and the finish pass that parses the Markdown files the agent
// changed and sends back what is wrong with them. Both skills keep their
// checked versions in one place, so a file is reported once even when both
// skills are loaded.

/** The reference for charts, Mermaid diagrams and live HTML, in notes and slides alike. */
export const LIVE_BLOCKS_GUIDE = `
## Which block to use

Three fenced code blocks draw something instead of showing code, in notes and in slide decks:

- A block tagged \`chart\`: a chart from a few lines of settings. Use it for numbers: comparisons, trends, shares, distributions.
- A block tagged \`mermaid\`: a diagram from Mermaid text. Use it for processes, structures, sequences, timelines and schedules.
- A block tagged \`html live\`: HTML, CSS and JavaScript run like a small web page. Use it only for what the other two cannot do: something the reader interacts with (a slider, a calculator, a simulation), or a custom visual.

Prefer the simplest block that does the job: a chart over live HTML, a Markdown table when the numbers matter more than their shape. A block tagged only \`html\` (without \`live\`) is shown as code.

They render in the note's preview and the Visual editor (under the block's code), in slides, the presentation and PDF exports. Notes use the app's light or dark theme; slides use the deck's \`$theme\`. They do not render in this chat or in search results, which show their code: to show the user a chart or diagram, put it in a file.

## Charts

\`\`\`\`markdown
\`\`\`chart
type: bar
title: Revenue by quarter ($k)
labels: [Q1, Q2, Q3, Q4]
series:
  2025: [12, 19, 8, 15]
  2026: [14, 22, 11, 18]
\`\`\`
\`\`\`\`

- YAML or JSON. \`type\`: bar (default), line, area, pie, doughnut, scatter, bubble, radar, polarArea.
- Data: \`labels\` plus \`series\` (a name for each list of values, or one plain list), or \`data\`: CSV text (\`data: |\` with the rows indented below) or the path of a \`.csv\`/\`.tsv\` file next to the note or deck (\`data: sales.csv\`; the path cannot leave the notebook). In CSV the first column labels the points and each other column is a series; empty or non-numeric cells are gaps. For scatter, the first column is x.
- Options: \`title\`, \`x\`/\`y\` (axis titles), \`stacked\`, \`horizontal\`, \`smooth\`, \`legend\` (top, bottom, left, right, none), \`height\` (pixels, 300 by default), \`min\`/\`max\`, \`beginAtZero\` (false lets the axis start elsewhere), \`colors\` (CSS colors; quote hex values, as in ["#0d9488"], because YAML reads # as a comment). \`options\` is merged into Chart.js's options and \`datasets\` replaces \`series\` with Chart.js datasets, for anything the shorthand does not cover.
- Colors come from the theme and a colorblind-safe palette. Do not set colors unless the user asks.
- Charts get hover tooltips, a legend when there are two or more series, and a data table for screen readers.
- Use the user's real data: read the file it is in. For a large CSV, point \`data\` at the file instead of copying it. Never make up numbers; if you must sketch a shape without data, say so in the chart's title.

## Mermaid diagrams

\`\`\`\`markdown
\`\`\`mermaid
flowchart LR
  idea[Idea] --> draft[Draft]
  draft --> review{Review}
  review -->|Changes| draft
  review -->|Approved| publish[Publish]
\`\`\`
\`\`\`\`

- The first line names the diagram: \`flowchart LR\` or \`flowchart TD\`, \`sequenceDiagram\`, \`classDiagram\`, \`stateDiagram-v2\`, \`erDiagram\`, \`gantt\`, \`pie\`, \`mindmap\`, \`timeline\`, \`journey\`, \`gitGraph\`, \`quadrantChart\`, \`xychart-beta\`, \`block-beta\`.
- Keep a diagram to what one picture can say, about 4–12 nodes; split a bigger one. A diagram is as wide as Mermaid draws it and shrinks to fit a narrower page or column.
- Node ids are plain words without spaces; the text goes in brackets: \`a[Label]\`, \`b(Rounded)\`, \`c{Decision}\`, \`d((Circle))\`, \`e[(Database)]\`. Quote labels with punctuation: \`a["Step 1: plan (draft)"]\`. Edge labels: \`a -->|yes| b\`. Do not use \`end\` as a node id.
- Mermaid runs in strict mode: HTML in labels and \`click\` lines are dropped. Colors and fonts come from the theme; do not add \`%%{init}%%\`, \`classDef\` or \`style\` lines unless the user asks.
- \`accTitle: …\` and \`accDescr: …\` lines give the diagram a title and description for screen readers.
- A syntax error shows Mermaid's message in place of the diagram. You cannot see it, so write syntax you are sure of.

## Live HTML ("applets")

\`\`\`\`markdown
\`\`\`html live height=340
<label>Rate: <input id="rate" type="range" min="1" max="10" value="5"> <output id="shown">5</output>%</label>
<div style="height:280px"><canvas id="growth"></canvas></div>
<script>
  const input = document.getElementById("rate");
  const chart = new Chart(document.getElementById("growth"), {
    type: "line",
    data: { labels: [0, 1, 2, 3, 4, 5], datasets: [{ label: "Balance", data: [], borderColor: libera.colors[0] }] },
    options: { maintainAspectRatio: false },
  });
  const draw = () => {
    const rate = Number(input.value) / 100;
    document.getElementById("shown").textContent = input.value;
    chart.data.datasets[0].data = chart.data.labels.map((year) => 100 * (1 + rate) ** year);
    chart.update();
  };
  input.addEventListener("input", draw);
  draw();
</script>
\`\`\`
\`\`\`\`

- The block is the body of a small page: write HTML, \`<style>\` and \`<script>\` directly, without \`<html>\` or \`<body>\`.
- Chart.js is already loaded as \`Chart\`. \`libera.colors\` is the series palette, \`libera.theme\` has the theme's \`foreground\`, \`muted\`, \`rule\` and \`surface\` colors, its \`name\` and whether it is \`dark\`, and \`libera.mode\` is preview, presenter or export. Use them so the applet matches the page, instead of fixed colors.
- The block grows to fit its content; \`height=400\` after \`live\` fixes its height. A responsive Chart.js canvas is half as tall as it is wide: wrap it in a \`<div>\` with a height and pass \`maintainAspectRatio: false\`.
- It runs in a sandboxed frame with its own origin: no access to Libera, the user's files, cookies or the page around it, and no \`fetch\` of notebook files. Put the data it needs in the script.
- In the user's own notebooks it may load scripts, styles, images, fonts and data over https (for example a library from cdn.jsdelivr.net, with an exact version). Notebook images need an https or data: URL. In a shared notebook it waits for the reader to click **Run** and has no network at all, so keep it self-contained there.
- Script errors show under the block. Keep the code short and readable, and handle input that is out of range.
- PDF exports print the block's first drawing, so do not hide content the reader needs behind an interaction.
`;

const CHECK_STATE = "markdown-live-blocks";
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([\w-]*)/;

/** ```chart blocks in Markdown, with the line each starts on; examples inside longer fences are skipped. */
function chartBlocks(source: string) {
  const lines = source.split(/\r?\n/);
  const blocks: { line: number; code: string }[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const open = FENCE_OPEN.exec(lines[index]);
    if (!open) continue;
    const fence = open[1];
    const closes = (line: string) => line.trim().startsWith(fence[0].repeat(fence.length)) && !line.trim().replace(/^[`~]+/, "").trim();
    const body: string[] = [];
    let end = index + 1;
    while (end < lines.length && !closes(lines[end])) {
      body.push(lines[end]);
      end += 1;
    }
    if (open[2] === "chart") blocks.push({ line: index + 1, code: body.join("\n") });
    index = end;
  }

  return blocks;
}

/** What a parse can tell is wrong with a Markdown file: broken chart settings, and a deck's invalid settings. */
export function markdownLiveBlockProblems(source: string, { deck = false } = {}) {
  const problems = deck ? parseMarkdownSlides(source).diagnostics.map((item) => (item.line ? `line ${item.line}: ${item.message}` : item.message)) : [];

  for (const block of chartBlocks(source)) {
    const parsed = parseSlideChartSpec(block.code);
    if ("error" in parsed) problems.push(`line ${block.line}, chart: ${parsed.error}`);
  }

  return problems;
}

/**
 * The finish pass both skills use: each Markdown file changed in the run is
 * checked once per version, so feedback the model cannot act on does not repeat.
 */
export async function finishLiveBlocks(context: ToolContext, { final }: { final: boolean }) {
  if (final) return null;
  let checked = context.skillState.get(CHECK_STATE) as Map<string, string> | undefined;
  if (!checked) {
    checked = new Map();
    context.skillState.set(CHECK_STATE, checked);
  }

  const reports: string[] = [];
  for (const path of context.changed.keys()) {
    if (getFileType(path) !== "markdown") continue;
    let current: { content: string } | null = null;
    try { current = await readCurrentText(context, await resolve(context, path)); } catch { current = null; }
    if (!current || checked.get(path) === current.content) continue;
    checked.set(path, current.content);
    const problems = markdownLiveBlockProblems(current.content, { deck: isMarkdownSlidesPath(path) });
    if (problems.length) reports.push(`${path}:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }

  return reports.length ? `The check of your charts and slide settings found problems. Fix them with Edit, then finish again.\n\n${reports.join("\n\n")}` : null;
}

/** How the finish check works, for the end of both skills' instructions. */
export const LIVE_BLOCKS_CHECK = `
## The check when you finish

When you finish a reply, Libera parses every Markdown file you changed. Chart blocks whose settings do not parse, and invalid slide-deck settings, come back to you with line numbers: fix them and finish again. The check cannot see the page, so it does not catch Mermaid syntax errors, script errors in live HTML or overfull slides; the user sees those in the preview.
`;
