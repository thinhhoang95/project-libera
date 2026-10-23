# Python in notes

A note can hold results computed in Python: figures, numbers and tables from data, statistics or simulations. Ask the AI agent ("plot the counts in counts.csv", "simulate 1,000 random walks and show the spread"); it writes the code, runs it, and puts the figures in the note. You can read and change the code, and re-run it from the note.

## The sidecar

A note's Python lives in the note's assets folder, beside its figures, in a file named after the note: `Notebook/Lab/growth.md` has `Notebook/_assets/Lab/growth.md/growth.py`. The folder uses the complete note filename and preserves its parent folders, keeping names such as `A B/report.md`, `A-B/report.md` and `report.markdown` distinct. Existing sidecars are migrated when their owner is unambiguous; ambiguous legacy code is kept for the user to assign to a note. Like the figures, it stays out of the sidebar and Search. **Code** on a figure opens it in the code editor, where you can change and save it; it also works in any Python editor. It goes with its note: renaming, moving, copying, archiving or deleting the note (or its folder) in Libera does the same to the sidecar. The agent finds it with Glob and Grep, and Read of a note names it. Cells start with `# %%` lines, as in Jupyter's percent format (VS Code, Spyder and Jupytext read it too):

```python
import numpy as np
import matplotlib.pyplot as plt

# %% [data] Load the counts
df = pd.read_csv("counts.csv")

# %% [growth] Counts per day
fig, ax = plt.subplots(figsize=(6, 3.5))
ax.plot(df.day, df["count"])
ax.set(xlabel="Day", ylabel="Count", title="Counts double every day")
```

- A cell with an id in brackets is a **result**. Every Matplotlib figure open when it ends is saved as one of its figures (PNG, 200 dpi).
- Code before the first `# %%`, and cells without an id, are **setup**: they run, and their figures are discarded.
- Running a cell first runs the setup and every cell above it, in a fresh Python process. Cells share variables as in a notebook, and a figure never depends on what ran earlier in some other session. `# %% [markdown]` cells are skipped.
- A cell's printed output and its last expression (a number, a DataFrame) go back to the agent, which writes what matters into the note.
- Relative paths are relative to the note's folder.

## Figures in the note

Figures are saved in the note's assets as `_assets/<note filename>/py-<cell>.<n>.<hash>.png` and appear in the note as ordinary Markdown images:

```markdown
![Counts double every day](_assets/growth.md/py-growth.1.d640440796.png)
```

The name links the image to its cell. The hash gives each result its own file, so a re-run shows at once, and undo brings back the earlier figure. All versions of Python figures are kept while the note exists, so saving and Undo can still restore an older figure. Unplaced results are kept too. Deleting the note (or its folder) deletes its sidecar and all of its figures, placed or not, like its other images; a figure another note also shows is kept. The note stays plain Markdown: other apps show the image, and if you delete the sidecar the figures are still there.

In the Visual editor, hovering a figure shows **Python · cell** with two buttons:

- **Re-run** runs the saved sidecar up to that cell and points this note's own images of every re-run cell at the new figures, as one undoable edit. An error shows under the figure with the line and the end of the traceback. Save the sidecar first if you changed it in a tab.
- **Code** opens the sidecar.

## What the agent does

The agent uses the **python-results** skill (see [AI Agent](ai-agent.md#python-results)). Its **RunPython** tool takes the note, a cell id and, optionally, the cell's code. It writes the cell into the sidecar (creating the sidecar, or replacing that cell's code), runs it, and returns each cell's output, figures and errors, with the sidecar's line numbers. Images of a cell already in the note are updated; new figures come back as Markdown the agent inserts with Edit where they belong. Without a cell it runs the whole sidecar, refreshing every figure. Changes to the sidecar and the note are part of the run's undo.

**InstallPythonPackages** adds packages from PyPI to Libera's runtime, wheels only, so no package code runs during the install. Packages installed this way are kept when the runtime updates.

The skill needs a permission that can change files; in Read Only the agent describes the analysis instead. The sidecar counts as part of its note: with **Modify open files only**, the agent may create and change the sidecar of a note that is open. Shared notebooks are not supported yet, because their images are shared files the collaboration host manages.

## The Python runtime

Python is part of Libera. On a new computer, Libera sets it up in the background a few seconds after it opens. uv (pinned and checksummed) installs Python 3.12 and NumPy, SciPy, pandas, Matplotlib, seaborn, SymPy, NetworkX, tabulate and Pillow, about 450 MB, into Libera's application data (`python/` next to `models/`). Nothing is installed system-wide. The Agent panel shows the progress, or the error with **Retry**. A run that needs Python before setup finishes waits for it.

To use another interpreter, such as a conda environment with your own packages, set `LIBERA_PYTHON` to its `python`. Libera then installs nothing, and InstallPythonPackages is off. `LIBERA_PYTHON_DIR` moves the runtime folder.

## Safety

Code runs as you, so Libera limits what it can reach:

- It gets a minimal environment, never Libera's own, which holds API keys.
- It runs with a time limit (2 minutes by default; the agent may ask for up to 10).
- On macOS it runs in a sandbox (`sandbox-exec`). There is no network. It cannot write anywhere but its scratch folder. In the home folder it can read only the notebook and Libera's Python runtime. Results reach the note only as figures and output. `LIBERA_PYTHON_SANDBOX=0` turns the sandbox off.
- Windows has no such sandbox. Code there can do what you can, so read what the agent wrote before re-running a sidecar you did not write.

## Implementation

- `src/lib/python/sidecar.ts`: where the sidecar is, the cell format, figure names and rewriting image sources (shared by the server and the editor). `src/lib/storage/asset-names.ts` names assets folders and lets sidecar paths through the storage path checks; `src/lib/storage/markdown-assets.ts` moves, copies and deletes sidecars with their notes.
- `src/lib/python/runtime.ts`: installing and finding the runtime. `src/lib/python/uv.ts` holds the uv release shared with Detection.
- `src/lib/python/execute.ts`: a run, its sandbox and environment, and saving figures. `electron/python-runner.py` executes the cells.
- `src/lib/agent/skills/python-results.ts`: the skill, RunPython and InstallPythonPackages.
- `src/app/api/python/route.ts` (status and setup) and `src/app/api/python/run/route.ts` (Re-run).
- `src/components/libera/tiptap-python-figure-view.ts` (the figure in the Visual editor) and `python-setup-status.tsx` (the Agent panel's line).

## Checks

`node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/python-results.test.ts`

The tests cover the cell format, adding and replacing cells, figure names and re-pointing images, package-name checks, the sandbox profile, loading the skill (and refusing it in Read Only), a run with a real interpreter (output, last expression, figure saved, sidecar written, note updated on a re-run, error lines, setup figures discarded, time limit), the run route, and the editor's Re-run, Code, undo and error display. The runs use `python3` (or `LIBERA_TEST_PYTHON`) when it has NumPy and Matplotlib, and are skipped otherwise.
