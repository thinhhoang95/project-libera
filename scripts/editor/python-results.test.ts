import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { Editor } from "@tiptap/core";
import { NextRequest } from "next/server";
import { AGENT_SKILLS } from "../../src/lib/agent/skills";
import { PYTHON_SKILL } from "../../src/lib/agent/skills/python-results";
import { RunSnapshots } from "../../src/lib/agent/snapshots";
import { activeTools, ALL_TOOLS, type ToolContext } from "../../src/lib/agent/tools";
import { cellsToRun, pythonSandboxProfile, runPythonSidecar } from "../../src/lib/python/execute";
import { isPythonPackageSpec, pythonInterpreter } from "../../src/lib/python/runtime";
import {
  parsePythonCells,
  legacyPythonSidecarPath,
  previousPythonFigureSources,
  parsePythonFigureSource,
  pythonCellProblem,
  pythonFigureFileName,
  pythonSidecarHref,
  pythonSidecarPath,
  pythonFigureSourcePrefix,
  replacePythonFigureSources,
  upsertPythonCell,
} from "../../src/lib/python/sidecar";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { createPythonFigureNodeView, PYTHON_FIGURE_OPEN_CODE_EVENT } from "../../src/components/libera/tiptap-python-figure-view";
import { GET as codeRoute, POST as runRoute } from "../../src/app/api/python/run/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import { cleanupMarkdownImageAssets, migratePythonSidecar, pruneUnusedMarkdownImageAssets } from "../../src/lib/storage/markdown-assets";
import { archiveFile, copyFileToDirectory, createFolder, deleteFile, deleteFolder, moveFile, moveFileToDirectory, readLiberaFile, renameFolder, updateMarkdownFile } from "../../src/lib/storage/files";
import { splitFilePath } from "../../src/lib/storage/paths";
import { isVisibleTreeFile } from "../../src/lib/storage/tree";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MouseEvent", "CustomEvent", "Event", "DOMParser", "MutationObserver", "getComputedStyle"] as const) {
  Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
}
Object.assign(globalThis, { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
after(() => dom.window.close());

// The interpreter for the runs below: one with NumPy and Matplotlib, as
// Libera's runtime has. Without one, those tests are skipped.
const probe = spawnSync(process.env.LIBERA_TEST_PYTHON ?? "python3", ["-c", "import sys, numpy, matplotlib, pandas; print(sys.executable)"], { encoding: "utf8", env: { ...process.env, PYTHONNOUSERSITE: "1" } });
const PYTHON = probe.status === 0 ? probe.stdout.trim() : null;
const needsPython = PYTHON ? {} : { skip: "no python3 with NumPy and Matplotlib" };
// One runtime folder for the file, so Matplotlib builds its font cache once.
const runtimeDirectory = mkdtempSync(path.join(os.tmpdir(), "libera-python-runtime-"));
process.env.LIBERA_PYTHON_DIR = runtimeDirectory;
after(() => rmSync(runtimeDirectory, { recursive: true, force: true }));

test("sidecar: cells, ids, setup code and Jupytext text cells", () => {
  const source = "import numpy as np\n\n# %% [data] Load\nx = np.arange(3)\n\n# %% just a title\ny = x * 2\n# %% [markdown]\n# Some prose\n# %% [plot]\nprint(y)\n";
  const cells = parsePythonCells(source);
  assert.deepEqual(cells.map((cell) => [cell.id, cell.title, cell.startLine, cell.text]), [
    [null, "", 1, false],
    ["data", "Load", 4, false],
    [null, "just a title", 7, false],
    [null, "", 9, true],
    ["plot", "", 11, false],
  ]);
  assert.equal(cells[1].code, "x = np.arange(3)\n");
  assert.deepEqual(cellsToRun(cells, "data").map((cell) => cell.id), [null, "data"]);
  assert.deepEqual(cellsToRun(cells).map((cell) => cell.id), [null, "data", null, "plot"], "text cells never run");
  assert.throws(() => cellsToRun(cells, "missing"), /no cell "missing".*data, plot/);
  assert.equal(pythonCellProblem(cells), null);
  assert.match(pythonCellProblem(parsePythonCells("# %% [a]\n1\n# %% [a]\n2\n"))!, /Two cells have the id "a"/);
  assert.match(pythonCellProblem(parsePythonCells("# %% [bad id]\n1\n"))!, /invalid/);
  assert.equal(pythonSidecarPath("Notes/sub/analysis.md"), "Notes/_assets/sub/analysis.md/analysis.py");
  assert.equal(pythonSidecarPath("Notes/Attack Map/1022_Sticky Flights.md"), "Notes/_assets/Attack Map/1022_Sticky Flights.md/1022_Sticky Flights.py", "the file keeps the note's own name");
  assert.equal(pythonSidecarHref("Notes/Attack Map/1022_Sticky Flights.md"), "../_assets/Attack%20Map/1022_Sticky%20Flights.md/1022_Sticky%20Flights.py");
  assert.equal(pythonSidecarHref("Notes/analysis.md"), "_assets/analysis.md/analysis.py");
});

test("sidecar: a cell is added, or its code replaced, leaving the rest as it was", () => {
  const created = upsertPythonCell("", "wave", "plt.plot([1, 2])\n", "A wave");
  assert.match(created, /^# Python for the note/);
  assert.ok(created.endsWith("# %% [wave] A wave\nplt.plot([1, 2])\n"));

  const source = "import math\n\n# %% [a]\nprint(1)\n\n# %% [b] Bee\nprint(2)\n";
  assert.equal(upsertPythonCell(source, "a", "print(10)\nprint(11)"), "import math\n\n# %% [a]\nprint(10)\nprint(11)\n\n# %% [b] Bee\nprint(2)\n");
  assert.equal(upsertPythonCell(source, "b", "print(20)"), "import math\n\n# %% [a]\nprint(1)\n\n# %% [b] Bee\nprint(20)\n");
  assert.equal(upsertPythonCell(source, "c", "print(3)"), `${source}\n# %% [c]\nprint(3)\n`);
  assert.equal(upsertPythonCell(source.replace(/\n/g, "\r\n"), "a", "print(0)"), "import math\r\n\r\n# %% [a]\r\nprint(0)\r\n\r\n# %% [b] Bee\r\nprint(2)\r\n", "keeps CRLF");
});

test("figures: names link an image to its cell, and a re-run repoints only that cell's images", () => {
  const name = pythonFigureFileName("loss-curve", 2, "0123456789abcdef");
  assert.equal(name, "py-loss-curve.2.0123456789.png");
  assert.deepEqual(parsePythonFigureSource(`_assets/Notes/a/${name}`), { cell: "loss-curve", index: 2 });
  assert.deepEqual(parsePythonFigureSource("/api/markdown-assets/raw?document=a.md&asset=_assets/a.md/py-run-2.1.aaaaaaaaaa.png"), null, "the asset query is not a file name");
  assert.deepEqual(parsePythonFigureSource("_assets/a.md/py-run-2.1.aaaaaaaaaa.png"), { cell: "run-2", index: 1 });
  assert.equal(parsePythonFigureSource("_assets/a/photo.png"), null);

  const markdown = "# Results\n\n![Loss](_assets/a.md/py-loss.1.aaaaaaaaaa.png)\n\n![Second](_assets/a.md/py-loss.2.aaaaaaaaaa.png)\n\n![Other](_assets/a.md/py-other.1.bbbbbbbbbb.png \"title\")\n";
  const result = replacePythonFigureSources("Lab/a.md", markdown, [
    { cell: "loss", index: 1, src: "_assets/a.md/py-loss.1.cccccccccc.png", width: 10, height: 10 },
    { cell: "other", index: 1, src: "_assets/a.md/py-other.1.dddddddddd.png", width: 10, height: 10 },
  ], ["loss"]);
  assert.equal(result.content, markdown.replace("py-loss.1.aaaaaaaaaa", "py-loss.1.cccccccccc"), "cells that did not finish keep their images");
  assert.deepEqual([...result.referenced], ["loss.1"]);
  assert.deepEqual(result.orphaned, ["_assets/a.md/py-loss.2.aaaaaaaaaa.png"]);
  const foreign = "![Foreign](_assets/other.md/py-loss.1.aaaaaaaaaa.png)";
  assert.equal(replacePythonFigureSources("Lab/a.md", foreign, [
    { cell: "loss", index: 1, src: "_assets/a.md/py-loss.1.cccccccccc.png", width: 10, height: 10 },
  ], ["loss"]).content, foreign, "another note's cell with the same id is never refreshed");
});

test("sidecar paths distinguish lossy folder names, note names and Markdown extensions", async () => {
  await withLibrary(async (_context, notebook) => {
    const notes = ["A B/report.md", "A-B/report.md", "A B/report.markdown", "A B/report.markdown.md", "A B/percent%20.md", "A B/percent~25.md"];
    const paths = notes.map((note) => pythonSidecarPath(`Lab/${note}`));
    assert.equal(new Set(paths).size, notes.length);
    for (const [index, note] of notes.entries()) {
      await mkdir(path.dirname(path.join(notebook, note)), { recursive: true });
      await writeFile(path.join(notebook, note), `# ${index}`);
      const sidecar = path.join(notebook, paths[index].slice(4));
      await mkdir(path.dirname(sidecar), { recursive: true });
      await writeFile(sidecar, `value = ${index}\n`);
    }
    await deleteFile(`Lab/${notes[0]}`);
    for (let index = 1; index < notes.length; index++) {
      assert.equal(await readFile(path.join(notebook, paths[index].slice(4)), "utf8"), `value = ${index}\n`);
    }
  });
});

test("legacy migration preserves code and figure ownership; ambiguous legacy sidecars survive deletes", async () => {
  await withLibrary(async (_context, notebook) => {
    const old = path.join(notebook, legacyPythonSidecarPath("Lab/growth.md").slice(4));
    await mkdir(path.dirname(old), { recursive: true });
    await writeFile(old, "# %% [a]\nprint(1)\n");
    const figure = "_assets/growth/py-a.1.aaaaaaaaaa.png";
    await writeFile(path.join(notebook, figure), "png");
    const request = new NextRequest("http://localhost/api/python/run?document=Lab%2Fgrowth.md", { headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` } });
    const response = await codeRoute(request);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).path, pythonSidecarPath("Lab/growth.md"));
    const source = await readFile(sidecarFile(notebook), "utf8");
    assert.ok(source.startsWith("# %% [a]\nprint(1)\n"));
    assert.deepEqual(previousPythonFigureSources(source), [figure]);
    assert.deepEqual(previousPythonFigureSources(upsertPythonCell(source, "a", "print(2)")), [figure], "editing the last cell preserves ownership");
    await mkdir(path.join(notebook, "A B"));
    await mkdir(path.join(notebook, "A-B"));
    for (const folder of ["A B", "A-B"]) await writeFile(path.join(notebook, folder, "report.md"), "# Report");
    const ambiguous = path.join(notebook, legacyPythonSidecarPath("Lab/A B/report.md").slice(4));
    await mkdir(path.dirname(ambiguous), { recursive: true });
    await writeFile(ambiguous, "# shared legacy code\n");
    await assert.rejects(migratePythonSidecar("Lab/A B/report.md"), /shared by multiple note names/);
    await deleteFile("Lab/A B/report.md");
    assert.equal(await readFile(ambiguous, "utf8"), "# shared legacy code\n");
  });
});

test("runtime: LIBERA_PYTHON picks the interpreter, and only plain package names install", () => {
  const previous = process.env.LIBERA_PYTHON;
  process.env.LIBERA_PYTHON = "/opt/conda/bin/python";
  try { assert.equal(pythonInterpreter(), "/opt/conda/bin/python"); }
  finally { if (previous === undefined) delete process.env.LIBERA_PYTHON; else process.env.LIBERA_PYTHON = previous; }
  for (const spec of ["statsmodels", "scikit-learn>=1.5", "numpy==2.3.1", "xarray[io]", "pkg>=1,<2"]) assert.ok(isPythonPackageSpec(spec), spec);
  for (const spec of ["https://evil.example/x.whl", "--index-url=http://x", "./local", "git+https://x", "a b", "-e ."]) assert.ok(!isPythonPackageSpec(spec), spec);
});

test("sandbox profile: no network, writes only to scratch, home readable only where allowed", () => {
  const profile = pythonSandboxProfile({ home: "/Users/me", writable: ["/tmp/run \"1\""], readable: ["/Users/me/Notes"] });
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /\(deny file-write\*\)\n\(allow file-write\* \(subpath "\/tmp\/run \\"1\\""\)/);
  assert.match(profile, /\(deny file-read\* \(subpath "\/Users\/me"\)\)\n\(allow file-read\* \(literal "\/Users\/me"\) \(subpath "\/Users\/me\/Notes"\)/);
});

function sidecarFile(notebook: string) {
  return path.join(notebook, "_assets", "growth.md", "growth.py");
}

async function writeSidecar(notebook: string, source: string) {
  await mkdir(path.dirname(sidecarFile(notebook)), { recursive: true });
  await writeFile(sidecarFile(notebook), source);
}

async function withLibrary(run: (context: ToolContext, notebook: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-python-results-"));
  const saved = { data: process.env.LIBERA_DATA_DIR, python: process.env.LIBERA_PYTHON };
  process.env.LIBERA_DATA_DIR = directory;
  if (PYTHON) process.env.LIBERA_PYTHON = PYTHON;
  try {
    const notebook = path.join(directory, "users", "admin", "Lab");
    await mkdir(notebook, { recursive: true });
    await writeFile(path.join(notebook, "growth.md"), "# Growth\n\nThe simulation below shows exponential growth.\n");
    await writeFile(path.join(notebook, "counts.csv"), "day,count\n0,1\n1,2\n2,4\n3,8\n");
    const context: ToolContext = {
      permission: "notebook", skills: AGENT_SKILLS, loadedSkills: new Set(), skillState: new Map(),
      notebook: "Lab", notebooks: ["Lab"], openFiles: new Set(), drafts: new Map(), fileState: new Map(), tasks: [],
      snapshots: new RunSnapshots("run-python-results"), changed: new Map(),
      maxResultChars: 40_000, signal: new AbortController().signal, emit: () => {},
    };
    await run(context, notebook);
  } finally {
    if (saved.data === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = saved.data;
    if (saved.python === undefined) delete process.env.LIBERA_PYTHON; else process.env.LIBERA_PYTHON = saved.python;
    await rm(directory, { recursive: true, force: true });
  }
}

function tool(context: ToolContext, name: string) {
  const found = activeTools(ALL_TOOLS, context).find((candidate) => candidate.name === name);
  assert.ok(found, `${name} is offered`);
  return found;
}

test("the skill loads on demand, and not in Read Only", async () => {
  await withLibrary(async (context) => {
    assert.ok(!activeTools(ALL_TOOLS, context).some((candidate) => candidate.name === "RunPython"), "RunPython waits for the skill");
    const loaded = await tool(context, "Skill").run({ name: PYTHON_SKILL }, context);
    for (const topic of ["# %% [", "RunPython", "sidecar", "InstallPythonPackages", "seed"]) assert.ok(loaded.text.includes(topic), topic);
    tool(context, "RunPython");
    const readOnly = { ...context, permission: "read-only" as const, loadedSkills: new Set<string>() };
    const refused = await tool(readOnly, "Skill").run({ name: PYTHON_SKILL }, readOnly);
    assert.match(refused.text, /needs a permission that can change files/);
    assert.ok(!readOnly.loadedSkills.has(PYTHON_SKILL));
  });
});

test("RunPython writes the cell, saves its figure, updates the note on a re-run, and reports errors with sidecar lines", needsPython, async () => {
  await withLibrary(async (context, notebook) => {
    await tool(context, "Skill").run({ name: PYTHON_SKILL }, context);
    const run = tool(context, "RunPython");
    const code = [
      "import pandas as pd",
      "import matplotlib.pyplot as plt",
      "df = pd.read_csv('counts.csv')",
      "fig, ax = plt.subplots(figsize=(4, 3))",
      "ax.plot(df.day, df['count'])",
      "print('doubling', df['count'].iloc[-1] / df['count'].iloc[-2])",
      "df['count'].sum()",
    ].join("\n");
    const first = await run.run({ document: "Lab/growth.md", cell: "growth", code, title: "Counts per day" }, context);
    assert.equal(first.isError, false, first.text);
    assert.match(first.text, /doubling 2\.0/);
    assert.match(first.text, /value:\n(np\.int64\()?15/);
    const insert = /!\[Describe what the figure shows\]\((_assets\/growth\.md\/py-growth\.1\.[0-9a-f]{10}\.png)\)/.exec(first.text);
    assert.ok(insert, first.text);
    const sidecar = await readFile(sidecarFile(notebook), "utf8");
    assert.match(sidecar, /# %% \[growth\] Counts per day\nimport pandas as pd/);
    assert.ok(context.changed.has("Lab/_assets/growth.md/growth.py"), "the sidecar is part of the run's changes (and its undo)");
    const png = await readFile(path.join(notebook, insert[1]));
    assert.equal(png.subarray(1, 4).toString(), "PNG");

    // The agent places the figure; a re-run with new code points it at the new file.
    await writeFile(path.join(notebook, "growth.md"), `# Growth\n\n![Counts](${insert[1]})\n`);
    context.fileState.clear();
    const second = await run.run({ document: "Lab/growth.md", cell: "growth", code: code.replace("figsize=(4, 3)", "figsize=(5, 3)") }, context);
    assert.equal(second.isError, false, second.text);
    assert.match(second.text, /already in the note, updated there/);
    const note = await readFile(path.join(notebook, "growth.md"), "utf8");
    const updated = /\((_assets\/growth\.md\/py-growth\.1\.[0-9a-f]{10}\.png)\)/.exec(note)![1];
    assert.notEqual(updated, insert[1]);
    assert.ok((await readdir(path.join(notebook, "_assets", "growth.md"))).includes(path.basename(updated)));

    const failed = await run.run({ document: "Lab/growth.md", cell: "broken", code: "x = 1\nraise ValueError('no data')" }, context);
    assert.equal(failed.isError, true);
    assert.match(failed.text, /\[broken\]: failed/);
    const sidecarLines = (await readFile(sidecarFile(notebook), "utf8")).split("\n");
    const line = sidecarLines.indexOf("raise ValueError('no data')") + 1;
    assert.match(failed.text, new RegExp(`error \\(line ${line} of the sidecar\\)`));
    assert.match(failed.text, /ValueError: no data/);

    const missing = await run.run({ document: "Lab/growth.md", cell: "nope" }, context).catch((error: Error) => error);
    assert.match(String(missing), /no cell "nope"/);
  });
});

test("RunPython preserves edits made after it reads the note", needsPython, async () => {
  await withLibrary(async (context, notebook) => {
    const noteFile = path.join(notebook, "growth.md");
    const original = "# Growth\n\n![Old](_assets/growth.md/py-growth.1.aaaaaaaaaa.png)\n";
    await writeFile(noteFile, original);
    await tool(context, "Skill").run({ name: PYTHON_SKILL }, context);
    let edit: Promise<void> | undefined;
    context.emit = (event) => {
      if (event.type === "file_changed" && event.path === pythonSidecarPath("Lab/growth.md")) edit = writeFile(noteFile, `${original}\nUser edit during the run.\n`);
    };
    const result = await tool(context, "RunPython").run({ document: "Lab/growth.md", cell: "growth", code: "import matplotlib.pyplot as plt\nplt.plot([1, 2])" }, context);
    await edit;
    assert.equal(result.isError, false, result.text);
    const saved = await readFile(noteFile, "utf8");
    assert.match(saved, /User edit during the run/);
    assert.doesNotMatch(saved, /aaaaaaaaaa\.png/);
  });
});

test("native crashes and unfinished checkpoints fail the tool and the run route", needsPython, async () => {
  await withLibrary(async (context, notebook) => {
    await writeSidecar(notebook, "# %% [first]\nprint('first')\n# %% [crash]\nimport os\nos._exit(7)\n");
    await tool(context, "Skill").run({ name: PYTHON_SKILL }, context);
    await assert.rejects(tool(context, "RunPython").run({ document: "Lab/growth.md" }, context), /stopped unexpectedly.*exit code 7/);
    const request = new NextRequest("http://localhost/api/python/run", { method: "POST", body: JSON.stringify({ document: "Lab/growth.md" }), headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` } });
    const response = await runRoute(request);
    assert.equal(response.status, 422);
    assert.match(JSON.stringify(await response.json()), /exit code 7/);
  });
});

test("syntax errors retain absolute sidecar lines and traceback locations", needsPython, async () => {
  await withLibrary(async (_context, notebook) => {
    const source = "x = 1\n\n# %% [bad]\nx =\n";
    await writeSidecar(notebook, source);
    const result = await runPythonSidecar({ documentPath: "Lab/growth.md", source });
    assert.equal(result.cells.at(-1)?.error?.line, 4);
    assert.match(result.cells.at(-1)?.error?.traceback ?? "", /line 4/);
  });
});

test("timeouts kill descendants and finish without waiting for their inherited pipes", needsPython, async () => {
  await withLibrary(async (_context, notebook) => {
    const source = "# %% [spawn]\nimport subprocess, sys, time\nchild = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\nprint(child.pid)\n# %% [wait]\ntime.sleep(30)\n";
    await writeSidecar(notebook, source);
    const start = Date.now();
    const result = await runPythonSidecar({ documentPath: "Lab/growth.md", source, timeoutMs: 4_000 });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - start < 8_000, "the child must not hold the result open for 30 seconds");
    const pid = Number(result.cells[0].stdout.trim());
    assert.ok(pid > 0);
    for (let attempt = 0; attempt < 20; attempt++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.throws(() => process.kill(pid, 0), "the descendant is no longer running");
  });
});

test("moves and copies preserve refresh ownership, and foreign figures keep their sources", needsPython, async () => {
  await withLibrary(async (context, notebook) => {
    await tool(context, "Skill").run({ name: PYTHON_SKILL }, context);
    const run = tool(context, "RunPython");
    const first = await run.run({ document: "Lab/growth.md", cell: "plot", code: "import matplotlib.pyplot as plt\nplt.plot([1,2])" }, context);
    const image = /!\[Describe what the figure shows\]\(([^)]+)\)/.exec(first.text)![1];
    await writeFile(path.join(notebook, "growth.md"), `![Own](${image})\n![Foreign](_assets/foreign.md/py-plot.1.aaaaaaaaaa.png)\n`);
    await moveFile("Lab/growth.md", "Lab", "Renamed.md");
    context.fileState.clear();
    const rerun = await run.run({ document: "Lab/Renamed.md", cell: "plot", code: "import matplotlib.pyplot as plt\nplt.plot([3,4,1])" }, context);
    assert.equal(rerun.isError, false, rerun.text);
    const moved = await readFile(path.join(notebook, "Renamed.md"), "utf8");
    assert.ok(moved.includes(`![Own](${pythonFigureSourcePrefix("Lab/Renamed.md")}/`));
    assert.match(moved, /!\[Foreign\]\(_assets\/foreign\.md\/py-plot\.1\.aaaaaaaaaa\.png\)/);
    const copy = await copyFileToDirectory("Lab/Renamed.md", "Lab", "Copy.md");
    assert.ok(copy.content?.includes("_assets/Copy.md/py-plot.1."));
    const copied = await run.run({ document: copy.file.path, cell: "plot", code: "import matplotlib.pyplot as plt\nplt.plot([8,9])" }, context);
    assert.equal(copied.isError, false, copied.text);
    assert.equal(await readFile(path.join(notebook, "Renamed.md"), "utf8"), moved, "refreshing the copy leaves its source unchanged");
    const other = path.join(path.dirname(notebook), "Other");
    await mkdir(other);
    await moveFile("Lab/Renamed.md", "Other", "Renamed.md");
    const movedSidecar = path.join(other, pythonSidecarPath("Other/Renamed.md").slice("Other/".length));
    assert.deepEqual(previousPythonFigureSources(await readFile(movedSidecar, "utf8")), [], "old source paths are not ownership in another notebook");
  });
});

test("saving repeatedly and undoing retains even old figure files", async () => {
  await withLibrary(async (_context, notebook) => {
    const folder = path.dirname(sidecarFile(notebook));
    await mkdir(folder, { recursive: true });
    const before = "![Before](_assets/growth.md/py-a.1.aaaaaaaaaa.png)\n";
    const after = "![After](_assets/growth.md/py-a.1.bbbbbbbbbb.png)\n";
    await writeFile(path.join(folder, "py-a.1.aaaaaaaaaa.png"), "old png");
    await writeFile(path.join(folder, "py-a.1.bbbbbbbbbb.png"), "new png");
    const lastYear = new Date(Date.now() - 365 * 24 * 60 * 60_000);
    await utimes(path.join(folder, "py-a.1.aaaaaaaaaa.png"), lastYear, lastYear);
    await writeFile(path.join(notebook, "growth.md"), before);
    await updateMarkdownFile("Lab/growth.md", after);
    await updateMarkdownFile("Lab/growth.md", `${after}\nMore text.\n`);
    await updateMarkdownFile("Lab/growth.md", before);
    assert.equal(await readFile(path.join(folder, "py-a.1.aaaaaaaaaa.png"), "utf8"), "old png");
    assert.equal(await readFile(path.join(folder, "py-a.1.bbbbbbbbbb.png"), "utf8"), "new png");
    await deleteFile("Lab/growth.md");
    await assert.rejects(stat(folder), { code: "ENOENT" });
  });
});

test("a figure path the model mistyped is repaired when the reply ends; one it cannot match is reported", needsPython, async () => {
  await withLibrary(async (context, notebook) => {
    await mkdir(path.join(notebook, "Attack Map"));
    await writeFile(path.join(notebook, "Attack Map", "1022_Sticky Flights.md"), "# Sticky\n\nThe two axes.\n");
    await tool(context, "Skill").run({ name: PYTHON_SKILL }, context);
    const result = await tool(context, "RunPython").run({ document: "Lab/Attack Map/1022_Sticky Flights.md", cell: "axes", code: "import matplotlib.pyplot as plt\nplt.plot([0, 1])" }, context);
    const src = /\]\((_assets\/Attack%20Map\/1022_Sticky%20Flights\.md\/py-axes\.1\.[0-9a-f]{10}\.png)\)/.exec(result.text)?.[1];
    assert.ok(src, result.text);
    // As in a real run: the model turned the "_" after the date into "-".
    const typo = src.replace("1022_Sticky", "1022-Sticky");
    const notePath = path.join(notebook, "Attack Map", "1022_Sticky Flights.md");
    await writeFile(notePath, `# Sticky\n\n![Axes](${typo})\n\n![Gone](_assets/Attack%20Map/1022_Sticky%20Flights.md/py-other.1.aaaaaaaaaa.png)\n`);
    context.fileState.clear();
    const skill = AGENT_SKILLS.find((candidate) => candidate.name === PYTHON_SKILL)!;
    const feedback = await skill.finishPass!(context, { final: false });
    const note = await readFile(notePath, "utf8");
    assert.ok(note.includes(`![Axes](${src})`), note);
    assert.match(feedback ?? "", /py-other\.1\.aaaaaaaaaa\.png/);
    assert.equal(await skill.finishPass!(context, { final: false }), null, "reported once");
  });
});

test("a setup cell's figures are discarded, a slow cell times out with what finished", needsPython, async () => {
  await withLibrary(async (context, notebook) => {
    await writeSidecar(notebook, "import time\nimport matplotlib.pyplot as plt\nplt.plot([1, 2])\n\n# %% [quick]\nprint('done')\n\n# %% [slow]\ntime.sleep(30)\n");
    await tool(context, "Skill").run({ name: PYTHON_SKILL }, context);
    const result = await tool(context, "RunPython").run({ document: "Lab/growth.md", timeout_seconds: 8 }, context);
    assert.equal(result.isError, true);
    assert.match(result.text, /1 figure discarded: this setup cell has no id/);
    assert.match(result.text, /\[quick\]: ok/);
    assert.match(result.text, /time limit/);
  });
});

test("the run route re-runs the saved sidecar for the Visual editor", needsPython, async () => {
  await withLibrary(async (_context, notebook) => {
    await writeSidecar(notebook, "import matplotlib.pyplot as plt\n\n# %% [line]\nplt.plot([0, 1], [0, 1])\n");
    const request = (body: unknown) => new NextRequest("http://localhost/api/python/run", {
      method: "POST", body: JSON.stringify(body), headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` },
    });
    const response = await runRoute(request({ document: "Lab/growth.md", cell: "line" }));
    assert.equal(response.status, 200);
    const result = await response.json() as { completed: string[]; figures: Array<{ src: string; width: number }> };
    assert.deepEqual(result.completed, ["line"]);
    assert.match(result.figures[0].src, /^_assets\/growth\.md\/py-line\.1\.[0-9a-f]{10}\.png$/);
    assert.ok(result.figures[0].width > 100);
    assert.equal((await runRoute(request({ document: "Lab/other.md" }))).status, 404);
    assert.equal((await runRoute(new NextRequest("http://localhost/api/python/run", { method: "POST", body: "{}" }))).status, 401);
  });
});

test("storage: a sidecar opens under _assets (nothing else there does), stays out of the tree, and goes with its note", async () => {
  await withLibrary(async (_context, notebook) => {
    const exists = (relative: string) => stat(path.join(notebook, ...relative.split("/"))).then(() => true, () => false);
    assert.deepEqual(splitFilePath("Lab/_assets/growth.md/growth.py").pathParts, ["_assets", "growth.md", "growth.py"]);
    for (const reserved of ["Lab/_assets/growth.md/photo.png", "Lab/_assets/growth.py", "Lab/_assets/growth.md/.hidden/x.py"]) assert.throws(() => splitFilePath(reserved), /reserved/, reserved);
    assert.equal(isVisibleTreeFile("Lab", ["_assets", "growth.md", "growth.py"]), false);

    await writeSidecar(notebook, "# %% [a]\nprint(1)\n");
    assert.equal((await readLiberaFile("Lab/_assets/growth.md/growth.py")).content, "# %% [a]\nprint(1)\n", "Code opens it as a file");
    await pruneUnusedMarkdownImageAssets("Lab/growth.md", "# Growth\n");
    assert.ok(await exists("_assets/growth.md/growth.py"), "collecting unused images leaves it");

    await moveFile("Lab/growth.md", "Lab", "Growth notes.md");
    assert.ok(!(await exists("_assets/growth.md")), "the old assets folder is gone once empty");
    assert.ok(await exists("_assets/Growth notes.md/Growth notes.py"), "renamed with the note");
    await createFolder("Lab", "Sub");
    await moveFileToDirectory("Lab/Growth notes.md", "Lab/Sub");
    assert.ok(await exists("_assets/Sub/Growth notes.md/Growth notes.py"), "moved with the note");
    const copy = (await copyFileToDirectory("Lab/Sub/Growth notes.md", "Lab")).file.path;
    assert.ok(await exists(pythonSidecarPath(copy).slice("Lab/".length)), `copied with the note (${copy})`);
    assert.ok(await exists("_assets/Sub/Growth notes.md/Growth notes.py"), "the original keeps its own");
    await renameFolder("Lab/Sub", "Two words");
    assert.ok(await exists("_assets/Two words/Growth notes.md/Growth notes.py"), "a renamed folder carries its notes' sidecars");
    await writeFile(path.join(notebook, "_assets", "Two words", "Growth notes.md", "py-fresh.1.cccccccccc.png"), "png");
    await deleteFolder("Lab/Two words");
    assert.ok(!(await exists("_assets/Two words")), "deleted with its folder");
    const archived = (await archiveFile(copy)).file.path;
    assert.ok(await exists(pythonSidecarPath(archived).slice("Lab/".length)), "archived with the note");
    assert.ok(!(await exists(pythonSidecarPath(copy).slice("Lab/".length))));
    const archivedFolder = path.dirname(pythonSidecarPath(archived).slice("Lab/".length));
    await writeFile(path.join(notebook, ...archivedFolder.split("/"), "py-a.1.aaaaaaaaaa.png"), "png");
    await writeFile(path.join(notebook, ...archivedFolder.split("/"), "py-a.2.bbbbbbbbbb.png"), "png");
    await writeFile(path.join(notebook, ...archived.split("/").slice(1)), `# Copy\n\n![A](${archivedFolder}/py-a.1.aaaaaaaaaa.png)\n`);
    await deleteFile(archived);
    assert.ok(!(await exists("_assets/_archive")), "deleted with the note: its sidecar, its figures, and a fresh figure not placed yet");
  });
});

test("agent: Glob and Read find a note's sidecar; open-files may write the sidecar of an open note only", async () => {
  await withLibrary(async (context, notebook) => {
    await writeSidecar(notebook, "# %% [a]\nprint(1)\n");
    await mkdir(path.join(notebook, "_assets", "growth.md", "deep"), { recursive: true });
    await writeFile(path.join(notebook, "_assets", "growth.md", "photo.png"), "png");
    const found = await tool(context, "Glob").run({ pattern: "**/*" }, context);
    assert.match(found.text, /Lab\/_assets\/growth\.md\/growth\.py/);
    assert.doesNotMatch(found.text, /photo\.png/, "images in _assets stay hidden");
    assert.match((await tool(context, "Grep").run({ pattern: "print\\(1\\)" }, context)).text, /_assets\/growth\.md\/growth\.py/);
    assert.match((await tool(context, "Read").run({ file_path: "Lab/growth.md" }, context)).text, /sidecar, Lab\/_assets\/growth\.md\/growth\.py/);

    const openFiles = { ...context, permission: "open-files" as const, openFiles: new Set(["Lab/growth.md"]) };
    await tool(openFiles, "Read").run({ file_path: "Lab/_assets/growth.md/growth.py" }, openFiles);
    const edited = await tool(openFiles, "Edit").run({ file_path: "Lab/_assets/growth.md/growth.py", old_string: "print(1)", new_string: "print(2)" }, openFiles);
    assert.equal(edited.isError ?? false, false, edited.text);
    assert.match(await readFile(sidecarFile(notebook), "utf8"), /print\(2\)/);
    await writeFile(path.join(notebook, "other.md"), "# Other\n");
    const created = await tool(openFiles, "Write").run({ file_path: "Lab/_assets/other.md/other.py", content: "x = 1\n" }, { ...openFiles, openFiles: new Set(["Lab/other.md"]) });
    assert.equal(created.isError ?? false, false, created.text);
    const refused = await tool(openFiles, "Write").run({ file_path: "Lab/_assets/other.md/other.py", content: "x = 2\n" }, openFiles).catch((error: Error) => error);
    assert.match(String(refused instanceof Error ? refused.message : refused.text), /only modify files that are open/);
  });
});

test("saving a note preserves all Python figure versions for undo", async () => {
  await withLibrary(async (_context, notebook) => {
    const folder = path.join(notebook, "_assets", "growth.md");
    await mkdir(folder, { recursive: true });
    for (const name of ["py-new.1.aaaaaaaaaa.png", "py-old.1.bbbbbbbbbb.png", "py-shown.1.cccccccccc.png", "upload.png"]) await writeFile(path.join(folder, name), "png");
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    await utimes(path.join(folder, "py-old.1.bbbbbbbbbb.png"), hourAgo, hourAgo);
    const previous = "# Growth\n\n![Shown](_assets/growth.md/py-shown.1.cccccccccc.png)\n";
    await writeFile(path.join(notebook, "growth.md"), "# Growth\n");
    await cleanupMarkdownImageAssets("Lab", [{ documentPath: "Lab/growth.md", content: previous }]);
    assert.deepEqual((await readdir(folder)).sort(), ["py-new.1.aaaaaaaaaa.png", "py-old.1.bbbbbbbbbb.png", "py-shown.1.cccccccccc.png"], "old and replaced figures remain available to history");
  });
});

test("Visual editor: Python figures get Re-run and Code; other images stay plain", async () => {
  const documentPath = "Lab/growth.md";
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: createMarkdownExtensions(documentPath, { imageNodeView: createPythonFigureNodeView(documentPath) }),
    content: "![Counts](_assets/growth.md/py-growth.1.aaaaaaaaaa.png)\n\n![Photo](_assets/growth.md/photo.png)\n\n![Foreign](_assets/foreign.md/py-growth.1.aaaaaaaaaa.png)\n",
    contentType: "markdown",
  });
  const originalFetch = globalThis.fetch;
  try {
    const figure = element.querySelector(".libera-python-figure")!;
    assert.ok(figure, "the figure is wrapped");
    assert.equal(figure.querySelector("span")!.textContent, "Python · growth");
    assert.equal(element.querySelectorAll(".libera-python-figure").length, 2, "the photo is a plain image");

    let opened = "";
    element.addEventListener(PYTHON_FIGURE_OPEN_CODE_EVENT, (event) => { opened = (event as CustomEvent<{ href: string }>).detail.href; });
    const [rerun, code] = [...figure.querySelectorAll("button")];
    code.click();
    assert.equal(opened, "_assets/growth.md/growth.py");

    let sent: unknown = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        figures: [{ cell: "growth", index: 1, src: "_assets/growth.md/py-growth.1.bbbbbbbbbb.png", width: 800, height: 600 }],
        completed: ["growth"], timedOut: false, cells: [{ id: "growth", line: 3, error: null }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    rerun.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(sent, { document: documentPath, cell: "growth" });
    assert.match(editor.getMarkdown(), /!\[Counts\]\(_assets\/growth\.md\/py-growth\.1\.bbbbbbbbbb\.png\)/);
    assert.match(editor.getMarkdown(), /photo\.png/);
    assert.match(editor.getMarkdown(), /!\[Foreign\]\(_assets\/foreign\.md\/py-growth\.1\.aaaaaaaaaa\.png\)/, "Visual refresh cannot replace a foreign figure with the same cell id");
    editor.commands.undo();
    assert.match(editor.getMarkdown(), /py-growth\.1\.aaaaaaaaaa\.png/, "a re-run is one undoable step");

    globalThis.fetch = (async () => new Response(JSON.stringify({
      figures: [], completed: [], timedOut: false,
      cells: [{ id: "growth", line: 3, error: { type: "NameError", message: "name 'df' is not defined", traceback: "Traceback…\nNameError: name 'df' is not defined", line: 5 } }],
    }), { status: 200 })) as typeof fetch;
    const again = element.querySelector(".libera-python-figure")!;
    again.querySelector("button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const message = again.querySelector(".libera-python-figure-message") as HTMLElement;
    assert.equal(message.hidden, false);
    assert.match(message.textContent ?? "", /\[growth\] failed at line 5:\n[\s\S]*NameError/);
  } finally {
    globalThis.fetch = originalFetch;
    editor.destroy();
    element.remove();
  }
});
