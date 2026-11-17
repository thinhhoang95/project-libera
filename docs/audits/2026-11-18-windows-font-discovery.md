# Windows per-user fonts missing from discovery and rendering

Investigated on 2026-11-18, against efc2fb5, Electron 45.3.0 / Chromium
156.0.8078.96. The available checkout was
`C:\Users\hoang\Documents\project-libera`; the supplied `D:\project-libera`
path was unavailable.

## Finding

The missing fonts reproduce outside Libera in a minimal Electron application.
Windows DirectWrite's default font collection is stale on this machine, and
Chromium retains snapshots of font discovery and family matching. This is not
evidence of a Markdown editor race or an npm font-library bug.

An explicit DirectWrite refresh repairs enumeration. Rendering requires another
step: the isolated experiment also registers the chosen regular face in the
renderer with `FontFace(family, local(fullName))`. Changing only the Preferences
list would leave the editor falling back to its default font.

The diagnostic scripts change nothing. The fix itself is described under
"Resolution" at the end of this document.

## Observed evidence

The per-user Windows font registry contains 200 entries and every referenced
file exists. Examples include B612 Mono, Berkeley Mono Trial, Figtree, Google Sans
Code, IBM Plex Mono and Inter. WPF's file-based `GlyphTypeface` successfully reads
the B612 Mono, Figtree and Inter font files; this is not simply missing files or
unreadable font metadata.

Direct calls to `dwrite.dll` with shared and isolated factories gave:

| `GetSystemFontCollection` argument | Families | B612 Mono / Figtree |
| --- | ---: | --- |
| `checkForUpdates = FALSE` | 214 | Absent |
| `checkForUpdates = TRUE` | 233 | Present |

Within the same factory, the sequence FALSE, TRUE, FALSE returned 214, 233, 233.
Refreshing in a separate PowerShell process did **not** repair a new Electron
process: its enumeration still returned 214. A helper process that only warms
its own collection is therefore insufficient here.

The final Electron harness tested both sandboxed and unsandboxed windows,
three sequential queries in each, with a fresh temporary app profile per run:

| Experiment | Families / faces | Actual rendering of the six user fonts |
| --- | --- | --- |
| Baseline | 214 / 575 | All fall back to Consolas |
| Refresh DirectWrite inside Electron's main process before creating windows | 233 / 765 | All still fall back to Consolas |
| Same refresh, plus register regular faces using `FontFace` and `document.fonts.add()` | 233 / 765 | All six render with their requested family |

These outcomes were also repeated in three fresh processes per configuration
during exploratory testing. Rendering was verified with the DevTools protocol's
`CSS.getPlatformFontsForNode`, after layout and painting, rather than inferred
from CSS's requested `font-family` or `document.fonts.check()`.

The exact 210-family result was not reproduced. The stale 214-family collection
includes four Source Serif families: `Source Serif 4 14pt`,
`Source Serif 4 18pt 18pt`, `Source Serif 4 36pt 36pt`, and
`Source Serif 4 48pt 48pt`. Their presence/absence is a plausible explanation for
the reported difference of four, but needs snapshots of both lists to confirm.

## Code path and upstream behavior

- `electron/setup.html`: `readSystemFontFamilies()` calls `queryLocalFonts()`,
  deduplicates `family`, and sorts. The Reload button repeats that call. There
  is no npm font discovery library in this path.
- That page caches the result in `systemFontFamilies`. It labels a saved family
  absent from the list as `(not installed)`, which is inaccurate in this case.
- `src/components/libera/use-editor-themes.ts` builds the editor font stacks.
  `src/lib/markdown-preferences.ts` quotes the saved family and appends a
  fallback. Those functions do not load or register font faces. The Markdown
  editor receives that CSS stack through `workspace-panel.tsx`.
- Chromium's Windows enumeration calls DirectWrite
  `GetSystemFontCollection(&collection)` without requesting an update:
  [Windows enumeration source](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/font_access/font_enumeration_data_source_win.cc).
- The Chromium version bundled here builds its enumeration cache once per cache
  instance, behind `initialized_`, and reuses it on later calls:
  [Chromium 156 enumeration cache](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.96/content/browser/font_access/font_enumeration_cache.cc).
  Preferences shares the profile's Electron session, so reopening Preferences
  does not inherently create a new browser context or reset that cache.
- Microsoft's contract explicitly says FALSE can return delayed changes and
  TRUE performs an immediate check:
  [DirectWrite documentation](https://learn.microsoft.com/en-us/windows/win32/api/dwrite/nf-dwrite-idwritefactory-getsystemfontcollection).

These mechanisms explain why retrying the JavaScript API need not repair the
list. They do not establish exactly why Windows' default collection became stale
or which event caused the original 210/214 fluctuation. Family rendering has its
own cached state: the main-process refresh experiment proves that repairing
enumeration alone does not repair CSS family matching.

## Reproduce

From the repository root, with dependencies installed:

```powershell
node scripts/diagnostics/windows-fonts.cjs
```

To reproduce the two workaround experiments, compile the diagnostic addon with
an x64 Windows GCC toolchain (GCC was available at
`C:\Strawberry\c\bin\gcc.exe` on this machine):

```powershell
$fontAddon = Join-Path $env:TEMP 'libera-font-refresh.node'
& C:\Strawberry\c\bin\gcc.exe -shared -O2 -o $fontAddon scripts/diagnostics/windows-font-refresh.c
node scripts/diagnostics/windows-fonts.cjs "--refresh-addon=$fontAddon"
node scripts/diagnostics/windows-fonts.cjs "--refresh-addon=$fontAddon" --register-local-faces
```

The harness prints JSON with full family lists, repeated query results,
full-name face loading outcomes, and actual fonts used for each sample. It uses
an ephemeral loopback server, hidden windows and a temporary Electron profile.
The temporary profile is removed afterward. It does not install/uninstall fonts,
write registry values, restart Windows services or open the user's Libera data.
The addon refreshes only its host process's DirectWrite collection.

## Fix direction and limits

1. Repair discovery at the native boundary, before Chromium's first enumeration.
   The verified primitive is `GetSystemFontCollection(..., TRUE)` in Electron's
   main process. The diagnostic addon is a proof of concept, not a packaged
   production dependency. An upstream Electron/Chromium change or a maintained
   native bridge needs proper packaging and lifecycle handling.
2. Repair renderer font resolution too. Explicit registration by full face name
   worked for all six tested families after the native refresh. A production
   implementation must preserve weights and styles, handle variable fonts,
   apply in every relevant renderer (including Preferences and exports), handle
   failed loads, and trigger editor remeasurement after font loading.
3. Handle later font changes explicitly. The startup experiment does not solve
   hot installation or invalidate an already-initialized enumeration cache.
4. Describe absent families as missing from the current discovery result, rather
   than definitively uninstalled. Reloading the same API should not promise an
   OS-level refresh.

An app restart alone was not a reliable fix in these tests. Disabling the
renderer sandbox did not help. Merely merging registry font names into the
dropdown would not fix rendering, and registry display labels are not reliable
CSS family or face names. `local()` should use the enumerated full face name or
PostScript name; for example `B612 Mono Regular`, not just `B612 Mono`.

The verified workaround covers the regular Latin faces used by the harness.
Bold, italic, variable axes, non-Latin fallback, live installations and Libera's
full editor/export flows still require validation before a production fix.

## Resolution

Libera no longer depends on DirectWrite for Windows per-user fonts, so neither
the stale enumeration nor the stale CSS matching can hide them. No native addon
is needed.

- `electron/user-fonts.cjs` (main process) finds per-user font files
  (`%LOCALAPPDATA%\Microsoft\Windows\Fonts` plus absolute paths under HKCU's font
  registry key), reads family, full name, weight (including a variable font's
  `wght` range) and italic from the sfnt `name`/`OS/2`/`head`/`fvar` tables, and
  serves each face over a privileged `libera-font://face/<id>` protocol on the
  profile session. Only scanned files are served, by opaque id. A `.ttc` member is
  rewritten as a standalone font because `@font-face` cannot select a collection
  member. Results are cached by path, mtime and size.
- Renderers register the faces they need as `FontFace` objects (`src/lib/user-fonts.ts`,
  called from `useEditorThemes` for the editors and previews, and from the PDF
  export page, which also waits for the load before printing). The source is
  `url(libera-font://…)` with `local(fullName)` as a fallback, with each face's real
  weight and style, so bold, italic and variable fonts work.
- Preferences merges these families into the `queryLocalFonts()` list, registers
  the faces for its previews, and says "(not found)" rather than "(not installed)"
  for a saved family absent from the list.
- A legacy DirectWrite family name (for example "Figtree Light") that may already
  be saved is registered as an alias, so existing preferences keep working.
- A family requested but not found triggers one rescan (at most every 5 seconds),
  so a font installed while the app runs is picked up without a restart.

Checked on this machine against the real per-user folder in an Electron window
using the app's preload, loaded from an `http://127.0.0.1` page like the editor:
47 faces registered, none failed, and B612 Mono, Berkeley Mono Trial, Figtree,
Google Sans Code, IBM Plex Mono and Inter rendered as themselves in regular,
bold, italic and bold italic (`CSS.getPlatformFontsForNode`). Unit tests are in
`scripts/lib/user-fonts.test.cjs`.

Not covered: system-wide fonts missing from a stale collection still go through
Chromium, and the Preferences list for them can still be incomplete; non-ASCII
paths in the HKCU registry key (read with `reg.exe`) may be skipped, though the
per-user folder is scanned directly; fonts whose files Chromium's sanitizer
rejects fall back to `local()`, which a stale collection may not resolve. Non-Windows
platforms are unchanged.
