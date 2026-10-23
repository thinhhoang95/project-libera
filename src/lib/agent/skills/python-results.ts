import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { markdownImageSources, rewriteMarkdownImageSources } from "@/lib/markdown-image-sources";
import { getFileType } from "@/lib/storage/file-types";
import { pathExists } from "@/lib/storage/fs-utils";
import { markdownAssetPath } from "@/lib/storage/paths";
import { migratePythonSidecar } from "@/lib/storage/markdown-assets";
import { DEFAULT_PYTHON_TIMEOUT_MS, MAX_PYTHON_TIMEOUT_MS, PythonRunError, runPythonSidecar, type PythonCellResult, type PythonRunResult } from "@/lib/python/execute";
import { installPythonPackages, PYTHON_RUNTIME } from "@/lib/python/runtime";
import { ownsPythonFigureSource, parsePythonFigureSource, PYTHON_CELL_ID, pythonSidecarPath, replacePythonFigureSources, upsertPythonCell } from "@/lib/python/sidecar";
import {
  assertWritable,
  ok,
  optionalInteger,
  optionalString,
  plural,
  readCurrentText,
  requireString,
  resolve,
  ToolError,
  writeAgentFile,
  type AgentSkill,
  type AgentTool,
  type ToolContext,
} from "../tools";

// Python in notes: the agent writes code into the note's sidecar
// (`analysis.md` → `_assets/analysis.md/analysis.py`, cells marked `# %% [id]`), runs it with
// RunPython on Libera's private runtime, and gets back each cell's output and
// figures. Figures are saved in the note's assets; images of a cell already
// in the note are updated in place, and new ones come back as Markdown for the
// agent to place with Edit. The sidecar is the note's companion: whatever may
// change the note may change it.

export const PYTHON_SKILL = "python-results";

const PACKAGES = PYTHON_RUNTIME.packages.map((spec) => spec.split(/[<>=!~]/, 1)[0]).join(", ");

const instructions = `
# Python results and figures in notes

You can compute results, run simulations and plot figures with Python, and put them in a Markdown note. The code lives in the note's **sidecar**, a \`.py\` file in the note's assets folder beside its figures: \`Notes/analysis.md\` has \`Notes/_assets/analysis.md/analysis.py\`. RunPython's result names it, and Read of the note mentions it. The notebook's file list hides it; the user opens it with **Code** on a figure in the Visual editor. You can Read, Edit and Grep it like any file, and you may change it whenever you may change the note. Its figures are ordinary images in the note.

## The sidecar

Cells start with \`# %%\` lines, as in Jupyter's percent format:

\`\`\`python
import numpy as np
import matplotlib.pyplot as plt

# %% [data] Load the measurements
df = pd.read_csv("measurements.csv")   # paths are relative to the note's folder

# %% [loss-curve] Training loss
fig, ax = plt.subplots(figsize=(6, 3.5))
ax.plot(df.epoch, df.loss)
ax.set(xlabel="Epoch", ylabel="Loss", title="Loss falls below 0.1 after 40 epochs")
\`\`\`

- \`[id]\`: letters, digits, \`-\` and \`_\`. A cell with an id is a result: every Matplotlib figure open when it ends is saved (PNG) as one of its figures, and figures are closed after each cell. Code before the first \`# %%\` and cells without an id are setup: they run, and their figures are discarded.
- Running a cell runs the setup and every cell before it first, in a fresh Python process, so a cell may use what earlier cells defined. Keep slow work (big loads, long simulations) in a cell of its own, early, and keep each result cell to one figure or one table.
- The last expression of a cell is displayed, as in a notebook (a DataFrame, a number); \`print\` output comes back too.
- Installed: Python ${PYTHON_RUNTIME.python} with ${PACKAGES}. More packages: InstallPythonPackages. \`plt.show()\` is not needed.
- Code runs without network access and can read the notebook's files (macOS also blocks other files in the home folder and writing anywhere). Read data from files next to the note; put results in the note (figures, or numbers you write into the text), never files written by the code.

## How to work

1. Read the note, and the sidecar if it exists. Find the data the user means (Read a CSV, a table in the note); use real data, and never make up numbers. When the user asks for an illustration or a simulation, that is the data: say in the text or caption that it is simulated, and seed random generators (\`np.random.default_rng(0)\`) so a re-run draws the same figure.
2. Call **RunPython** with the note's path, the cell's id and its \`code\`. It writes the cell into the sidecar (creating the sidecar, or replacing that cell's code) and runs it. To run cells already in the sidecar unchanged, leave out \`code\`; leave out \`cell\` too to run every cell (the user asks to "re-run" or "refresh" the figures).
3. Read the result. If a cell failed, fix the code from the traceback (its line numbers are the sidecar's) and run again. Check printed numbers before you quote them.
4. Place the figure: for a new figure, RunPython gives a Markdown image; insert it with Edit where it belongs in the note, after the sentence that introduces it, and replace the alt text with a short description of what the figure shows. Copy the image path exactly as RunPython gave it, character for character (it is generated from the note's folders and name); never retype or tidy it. A figure already in the note is updated by RunPython itself; do not insert it again.
5. Write results into the note's text where they help (a number, a short table), saying where they come from. Reply in a sentence or two with what you added.

## Style

- Figures read in light and dark themes on a white background: keep Matplotlib's default white face, label axes with units, and title a figure with its finding ("Error halves with each doubling of n"), not its topic.
- \`figsize\` around (6, 3.5) suits a note; use \`fig.tight_layout()\` for several panels. Default resolution is 200 dpi.
- For a Markdown table of results, \`print(df.to_markdown(index=False))\` and copy the table into the note.
- Keep the sidecar tidy and readable: the user may re-run and change it. Imports at the top, one idea per cell, short comments where the code is not obvious.
- Prefer the note's live blocks (\`\`\`chart, \`\`\`mermaid; the visualization skill) for simple charts of numbers the reader may want to hover; use Python for computed results, statistics, simulations and plots those blocks cannot draw.
`;

function formatCell(cell: PythonCellResult, inNote: Set<string>) {
  const name = cell.id ? `[${cell.id}]` : `setup (line ${cell.line})`;
  const lines = [`${name}${cell.title ? ` ${cell.title}` : ""}: ${cell.error ? "failed" : "ok"} in ${cell.seconds.toFixed(1)} s`];
  if (cell.stdout.trim()) lines.push(`stdout:\n${cell.stdout.replace(/\s+$/, "")}`);
  if (cell.stderr.trim()) lines.push(`stderr:\n${cell.stderr.replace(/\s+$/, "")}`);
  if (cell.value !== null) lines.push(`value:\n${cell.value}`);
  for (const figure of cell.figures) {
    const placed = inNote.has(`${figure.cell}.${figure.index}`);
    lines.push(`figure ${figure.index} (${figure.width}×${figure.height} px): ${placed
      ? "already in the note, updated there"
      : `not in the note yet; insert it with Edit: ![Describe what the figure shows](${figure.src})`}`);
  }
  if (cell.discardedFigures) lines.push(`${plural(cell.discardedFigures, "figure")} discarded: this setup cell has no id. Give the cell an id ("# %% [name]") to keep its figures.`);
  if (cell.error) lines.push(`error (line ${cell.error.line ?? "?"} of the sidecar):\n${cell.error.traceback || `${cell.error.type}: ${cell.error.message}`}`);
  return lines.join("\n");
}

function summary(result: PythonRunResult) {
  const failed = result.cells.find((cell) => cell.error);
  if (result.timedOut) return "Timed out";
  if (failed) return `${failed.id ? `[${failed.id}]` : "Setup"} failed: ${failed.error!.type}`;
  return result.figures.length ? plural(result.figures.length, "figure") : `${plural(result.cells.length, "cell")} ran`;
}

const runPythonTool: AgentTool = {
  name: "RunPython",
  kind: "write",
  description: `Runs Python for a Markdown note and saves its figures. The code lives in the note's sidecar, a .py file in the note's assets folder (Notes/a.md → Notes/_assets/a.md/a.py), cells marked "# %% [id]".

Usage:
- document: the note's library path. cell: the id of the cell to run; the setup code and earlier cells run first.
- code: the cell's complete code. It replaces that cell in the sidecar (or adds the cell, creating the sidecar if needed). Leave it out to run the sidecar as it is.
- Leave out cell and code to run every cell, refreshing every figure.
- Every Matplotlib figure open at the end of a cell with an id is saved. Images of that cell already in the note are updated; new figures come back as Markdown images to insert with Edit.
- Returns each cell's printed output, last expression, figures and errors (line numbers are the sidecar's). The run times out after ${DEFAULT_PYTHON_TIMEOUT_MS / 1000} seconds unless timeout_seconds says otherwise.`,
  parameters: {
    type: "object",
    properties: {
      document: { type: "string", description: "Library path of the Markdown note." },
      cell: { type: "string", description: "Id of the cell to run, e.g. \"loss-curve\"." },
      code: { type: "string", description: "The cell's complete Python code, without its # %% line." },
      title: { type: "string", description: "Optional short title for a new cell's # %% line." },
      timeout_seconds: { type: "integer", description: `Time limit (default ${DEFAULT_PYTHON_TIMEOUT_MS / 1000}, at most ${MAX_PYTHON_TIMEOUT_MS / 1000}).` },
    },
    required: ["document"],
    additionalProperties: false,
  },
  describe: (args) => args.cell ? `Running Python cell ${String(args.cell)}` : `Running the Python of ${String(args.document ?? "a note")}`,
  async run(args, context) {
    const document = await resolve(context, requireString(args, "document"));
    if (getFileType(document.path) !== "markdown") throw new ToolError(`${document.path} is not a Markdown note. RunPython puts figures into a note (.md); its code lives in the note's sidecar (${pythonSidecarPath(document.path)}).`);
    const cell = optionalString(args, "cell")?.trim();
    const code = optionalString(args, "code");
    const title = optionalString(args, "title") ?? "";
    const timeout = optionalInteger(args, "timeout_seconds", { min: 1, max: MAX_PYTHON_TIMEOUT_MS / 1000 });
    if (cell !== undefined && !PYTHON_CELL_ID.test(cell)) throw new ToolError(`"${cell}" is not a valid cell id: use letters, digits, - and _ (up to 64), e.g. "loss-curve".`);
    if (code !== undefined && !cell) throw new ToolError("Give the cell's id with code, e.g. cell: \"loss-curve\".");
    assertWritable(context, document, { creating: false });
    if (isSharedNotebookPath(document.path)) throw new ToolError("Python figures are not available in shared notebooks yet. Describe the analysis to the user, or put the code in your reply.");
    const note = await readCurrentText(context, document);
    if (!note) throw new ToolError(`No note at ${document.path}. Create it with Write first.`);

    await migratePythonSidecar(document.path);
    const sidecar = await resolve(context, pythonSidecarPath(document.path));
    const current = await readCurrentText(context, sidecar);
    let source = current?.content ?? "";
    if (code !== undefined) {
      assertWritable(context, sidecar, { creating: !current });
      const next = upsertPythonCell(source, cell!, code, title);
      if (next !== source) {
        await writeAgentFile(context, sidecar, next, current ?? { content: null, fromDraft: false });
        source = next;
      }
    } else if (!current) {
      throw new ToolError(`${sidecar.path} does not exist yet. Pass the cell's code to create it.`);
    }

    let result: PythonRunResult;
    try {
      result = await runPythonSidecar({ documentPath: document.path, source, cell, timeoutMs: timeout ? timeout * 1000 : undefined, signal: context.signal });
    } catch (error) {
      if (error instanceof PythonRunError) throw new ToolError(error.message);
      throw error;
    }

    const latest = await readCurrentText(context, document);
    if (!latest) throw new ToolError("The note was removed while Python was running. Its figures were not inserted.");
    const updated = replacePythonFigureSources(document.path, latest.content, result.figures, result.completed, result.previousSources);
    if (updated.content !== latest.content) await writeAgentFile(context, document, updated.content, latest, true);
    const saved = runFigures(context);
    const forNote = saved.get(document.path) ?? new Map<string, string>();
    for (const figure of result.figures) forNote.set(`${figure.cell}.${figure.index}`, figure.src);
    saved.set(document.path, forNote);
    const lines = [`Ran ${plural(result.cells.length, "cell")} of ${result.sidecarPath} with Python ${result.python}.`];
    lines.push(...result.cells.map((entry) => formatCell(entry, updated.referenced)));
    if (result.timedOut) lines.push(`The run hit its time limit; ${result.notRun.length ? `not run: ${result.notRun.join(", ")}` : "the last cell did not finish"}. Make the code faster, or pass a larger timeout_seconds.`);
    else if (result.notRun.length) lines.push(`Not run, because of the error: ${result.notRun.join(", ")}.`);
    if (updated.orphaned.length) lines.push(`The note still shows ${plural(updated.orphaned.length, "figure")} these cells no longer draw: ${updated.orphaned.join(", ")}. Remove those images with Edit, or draw the figures again.`);
    const failed = result.timedOut || result.cells.some((entry) => entry.error);
    return { text: lines.join("\n\n"), isError: failed, result: summary(result), detail: lines.slice(1).join("\n\n").slice(0, 1_500) };
  },
};

const installPackagesTool: AgentTool = {
  name: "InstallPythonPackages",
  kind: "write",
  description: `Installs Python packages from PyPI into Libera's Python runtime, for RunPython. Already installed: ${PACKAGES}.

Usage:
- packages: PyPI names, optionally with versions ("statsmodels", "scikit-learn>=1.5"). Install only what the code needs, by its exact PyPI name.
- Only prebuilt wheels are installed; a package without a wheel for this computer fails.`,
  parameters: {
    type: "object",
    properties: { packages: { type: "array", items: { type: "string" }, description: "Package names, e.g. [\"statsmodels\"]." } },
    required: ["packages"],
    additionalProperties: false,
  },
  describe: (args) => `Installing ${Array.isArray(args.packages) ? args.packages.join(", ") : "Python packages"}`,
  async run(args, context) {
    if (context.permission === "read-only") throw new ToolError("You are in Read Only mode and cannot install packages.");
    const packages = args.packages;
    if (!Array.isArray(packages) || !packages.length || packages.some((entry) => typeof entry !== "string")) throw new ToolError("packages must be a list of package names.");
    if (packages.length > 10) throw new ToolError("Install at most 10 packages at a time.");
    try {
      const output = await installPythonPackages(packages as string[], context.signal);
      return ok(`Installed ${packages.join(", ")}.${output ? `\n${output.split("\n").slice(-12).join("\n")}` : ""}`, "Installed");
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : "Installing failed.");
    }
  },
};

// The model copies a figure's long asset path into the note by hand, and
// sometimes gets a character wrong (`1022_Sticky` → `1022-Sticky`): the image
// then shows broken. When a reply ends, a figure image whose file does not
// exist is pointed at the figure RunPython saved for that cell in this run.
const FIGURES_STATE = "python-results:figures";
const REPORTED_STATE = "python-results:reported";

/** The figures RunPython saved in this run: note path → `cell.index` → src. */
function runFigures(context: ToolContext) {
  let figures = context.skillState.get(FIGURES_STATE) as Map<string, Map<string, string>> | undefined;
  if (!figures) {
    figures = new Map();
    context.skillState.set(FIGURES_STATE, figures);
  }
  return figures;
}

async function figureExists(notebook: string, source: string) {
  try { return await pathExists(markdownAssetPath(notebook, source.split(/[?#]/, 1)[0]).targetPath); }
  catch { return false; }
}

async function finishPass(context: ToolContext, { final }: { final: boolean }) {
  const saved = context.skillState.get(FIGURES_STATE) as Map<string, Map<string, string>> | undefined;
  if (!saved) return null;
  let reported = context.skillState.get(REPORTED_STATE) as Set<string> | undefined;
  if (!reported) {
    reported = new Set();
    context.skillState.set(REPORTED_STATE, reported);
  }
  const problems: string[] = [];
  for (const [notePath, figures] of saved) {
    let document;
    let note;
    try {
      document = await resolve(context, notePath);
      note = await readCurrentText(context, document);
    } catch { continue; }
    if (!note) continue;
    const sources: Record<string, string> = {};
    const missing: string[] = [];
    for (const source of markdownImageSources(note.content)) {
      const figure = parsePythonFigureSource(source);
      if (!figure || source in sources || missing.includes(source) || await figureExists(document.notebook, source)) continue;
      const replacement = figures.get(`${figure.cell}.${figure.index}`);
      // A mistyped folder is repairable only when the exact content-addressed filename matches.
      // Matching just the cell id could steal an unrelated, missing figure from another note.
      if (!ownsPythonFigureSource(notePath, source) && (!source.startsWith("_assets/") || !replacement || source.split("/").at(-1) !== replacement.split("/").at(-1))) continue;
      if (replacement) sources[source] = replacement;
      else missing.push(source);
    }
    if (Object.keys(sources).length) await writeAgentFile(context, document, rewriteMarkdownImageSources(note.content, sources), note);
    const fresh = missing.filter((source) => !reported.has(`${notePath}\n${source}`));
    for (const source of fresh) reported.add(`${notePath}\n${source}`);
    if (fresh.length) problems.push(`${notePath}:\n${fresh.map((source) => `- ${source}`).join("\n")}`);
  }
  if (final || !problems.length) return null;
  return `These Python figure images in the note point at files that do not exist. Copy the figure's Markdown from RunPython's result exactly, or run its cell again, then finish again.\n\n${problems.join("\n\n")}`;
}

export const pythonResultsSkill: AgentSkill = {
  name: PYTHON_SKILL,
  description: "Compute results, run simulations and plot figures with Python (NumPy, SciPy, pandas, Matplotlib, seaborn, SymPy) and put them in a Markdown note; the code lives in the note's .py sidecar. Use when the user asks to calculate, analyze data, simulate, fit, or plot something that needs code, or to re-run or change a note's Python figures.",
  instructions,
  unavailable: (context: ToolContext) => {
    if (context.permission === "read-only") return "Running Python saves figures into the note, so it needs a permission that can change files. Ask the user to switch from Read Only, or describe the analysis and give the code in your reply.";
    if (context.notebook && isSharedNotebookPath(context.notebook)) return "Python figures are not available in shared notebooks yet. Describe the analysis, or give the code in your reply.";
    return null;
  },
  tools: [runPythonTool, installPackagesTool],
  finishPass,
};
