# Energy bench

Replays the same editing, reading and idle sessions against two production
builds of Libera and reports what each cost: Energy Impact (the score Activity
Monitor shows), CPU seconds per process, idle wakeups and renderer work.

```sh
# Build the two versions (reused when they already exist)
BEFORE=$(node scripts/bench/energy/prepare.mjs 08e9c0b)
AFTER=$(node scripts/bench/energy/prepare.mjs main)

# Run every scenario three times per version, on mains power
npm run bench:energy -- --before "$BEFORE" --after "$AFTER"

# Fewer scenarios, or the app's battery paths (simulated: the page is told it runs on battery)
npm run bench:energy -- --before "$BEFORE" --after "$AFTER" --scenarios latex-typing,idle --power battery
```

Results go to `docs/audits/energy-bench/` (`--out` changes it): a JSON file
with every run and a Markdown summary of medians and ranges.

## What a run does

For each scenario and version, alternating versions (ABBA) so drift in the
machine's load falls on both:

1. A fresh copy of the fixture library (`fixtures.mjs`, generated from a fixed
   seed): a 85 KB Markdown note with headings, bold lead-ins, lists, math and
   tables; a LaTeX report; a 30-page text PDF typeset with `pdflatex`.
2. The version's standalone server with its own data folder, config and
   password (`libera`). Your own profile and notebooks are never touched. The
   app sets up its managed Python runtime at sign-in; the bench installs it
   once (into `<tmp>/libera-energy-cache/python`) and shares it, so no session
   pays for that one-time ~570 MB setup.
3. An Electron window (`harness.cjs`, 1440×900, empty profile) that signs in,
   opens the files with ⌘P as a user does, then drives the session with real
   input events through Chromium's input pipeline.
4. Measurement over the session only, after a 5 s settle:
   - Electron's per-process CPU time and idle wakeups (`app.getAppMetrics`).
   - Renderer task, script, layout and style time (DevTools Performance metrics).
   - `top`, once a second: Energy Impact and CPU time of the Electron process
     tree and of the server process tree (LaTeX compiles included).
   - API requests and menu-bar syncs (the preload stands in for the desktop
     app's menu bridge and counts its updates).

| Scenario | Session |
| --- | --- |
| `idle` | Note and PDF open, nothing touched for 60 s, window focused. |
| `idle-background` | The same, with another window focused (Libera visible behind it). |
| `visual-typing` | ~450 characters typed into the middle of the long note in the Visual editor at 8–14 characters a second, pauses between sentences, a word-by-word selection, some scrolling. |
| `source-typing` | The same in the Source editor, with a file link and a citation popup opened. |
| `pdf-annotate` | Reading the PDF: steady wheel scrolling, five highlights, three pen strokes, zoom in and out. |
| `latex-typing` | Typing into the LaTeX report with pauses long enough for automatic compiles. |
| `panels` | Dragging the sidebar edge back and forth, then switching tabs. |

## Reading the numbers

- Energy Impact is relative and has no unit; compare before and after on the
  same machine, never across machines. CPU seconds are the more concrete number.
- The window must stay visible: an occluded window is throttled by macOS and
  measures nothing. Other busy apps add noise; close what you can, and look at
  the ranges before believing a difference of a few percent.
- Not covered: the Electron main process of the real app (vibrancy, the power
  state file), and real battery power. `--power battery` only makes the page
  take its battery paths; the machine itself stays on mains.
