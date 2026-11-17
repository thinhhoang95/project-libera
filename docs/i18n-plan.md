# Multi-language support (i18n) plan

Status: planning. Inventory of user-facing strings lives in `messages/en.json` (draft; not yet wired into code),
with source locations in `docs/i18n/en.sources.json`. See [Inventory](#inventory-2026-11-18).

## Starting point

- No translation setup exists. All interface text is written inline in JSX across ~210 UI files
  (~78k lines in `src/components`, `src/app`, `electron/main.cjs`, `electron/setup.html`).
- `<html lang="en">` is fixed in `src/app/layout.tsx`.
- Number/date formatting is inconsistent: at least 25 call sites hard-code English
  (`toLocaleString("en")`, `Intl.RelativeTimeFormat("en")`, `locale: "en-US"` for citeproc), others use the OS default.
- Plurals are hand-written English (`n === 1 ? "page" : "pages"`, the `plural(n, word)` helper).

## Design: a language preference, not locale URLs

The Next.js i18n guide (`node_modules/next/dist/docs/01-app/02-guides/internationalization.md`) routes by URL
(`app/[lang]/...`) and negotiates `Accept-Language` in a proxy. That fits public websites, not a desktop app on a
local server. Instead, language works like the theme preference:

- Store `localePreference` (`"system"` or a locale code) in the Electron config file next to `themePreference`
  (`src/lib/theme-config.ts`).
- `src/app/layout.tsx` reads it, sets `<html lang>`, and passes that locale's messages to a client provider.
- `"system"` resolves through Electron's `app.getLocale()`, falling back to `en`.

## Library

`next-intl` in its "without i18n routing" mode: works in server and client components and uses ICU message
syntax, so plurals and select forms are correct in every language. Messages live in `messages/<locale>.json`,
namespaced by feature area.

## Phases

### 0. Foundation
- Add `next-intl`, the provider, `messages/en.json`, the stored preference, and a language picker in Preferences.
- Add `src/lib/i18n/formatters.ts` (numbers, dates, relative time, list format, collation) driven by the active
  locale; replace hard-coded `"en"` / `"en-US"` / `undefined` formatting call sites.

### 1. Extraction, one feature area per PR
- Key namespaces follow `src/components/libera/*` (collab, references, latex, audio, global-search, …), so areas
  convert in parallel without conflicts.
- Turn hand-written plurals into ICU plural messages.
- Include tooltips (`title`), `aria-label`, `placeholder`, empty states, confirm dialogs and error toasts.
- Add a lint rule (`react/jsx-no-literals` or `eslint-plugin-i18next`), tightened per folder as each converts.

### 2. Electron main process
- Menus in `electron/main.cjs`, native dialogs (`dialog.show*`), and the first-run `electron/setup.html` read the
  same JSON through a small `t()` helper; menus are rebuilt when the language changes.

### 3. Translations and checks
- A script compares each `messages/<locale>.json` against `en.json` for missing / unused keys and mismatched ICU
  placeholders. Run on its own, not in a full test sweep.
- AI-drafted translations, reviewed by a native speaker on the most-used surfaces.

### 4. Later
- Right-to-left languages: convert physical `ml-/mr-/left-/right-` utilities to logical `ms-/me-/start-/end-`.
- Collab server emails (`server/src/mail`): per-recipient locale stored server-side.

## Out of scope
- Strings written for the AI agent (`src/lib/agent/*`): they are read by the model and stay English; only the
  parts surfaced in the UI are translated.
- User content (Markdown, LaTeX, notebooks) is never translated.
- Content language for read-aloud, transcription and spellcheck is a separate setting from interface language.

## Inventory (2026-11-18)

`messages/en.json` holds **7,204 messages** (217 ICU plurals) inventoried from every UI file; each key's source
location is in `docs/i18n/en.sources.json`. Keys are namespaced by source file
(`references.referencesPanel.addButton`, `lib.storage.integrity.inkUnreadable`, `electron.main.*`,
`electron.setup.*`), so per-area extraction PRs never touch each other's keys. The file is a draft: nothing reads
it yet, and wording will shift as each area is converted.

How it was built: 12 parallel inventory passes over balanced slices of `src/components`, `src/app`, `src/lib`
and `electron/`, plus a hand pass for gaps. A merge check confirmed no key collisions, every key has a source
location, braces balance, and stray `<` / `>` are quoted. Every message was searched for in its source file; the
~90 not found verbatim were spot-checked and are sentences the code assembles from pieces (e.g.
`` `Switch to ${mode} editor` ``), which the inventory correctly reassembled into whole messages.

### Largest areas
| Area | Messages |
|------|---------:|
| collab, audio, recording, spending | 945 |
| top-level components (gallery, image viewer, document chat, …) | 942 |
| references | 873 |
| LaTeX, Markdown source, search, detection, ink | 838 |
| notebook panel, Markdown review, dialogs | 837 |
| Electron menus/dialogs + Preferences window (`setup.html`) + app shell | 832 |

### Found during the inventory — fix before or during extraction
- **Code that matches on display text** (breaks once translated; switch to codes/ids first):
  `use-meeting-recorder.ts:467` (`startsWith("Your edits could not be saved")`), `photo-viewer.tsx:557`
  (`group !== "Photo"`).
- **Raw identifiers shown as text** need label maps: comment/review status (`"open"`, `"resolved"`), search result
  `type`, spending units (`hour`/`day`/`month`), reasoning-effort enum labels, saved-pen brush/line-style words.
- **Sentence assembly in code**: many messages are fragments joined with `" · "`, leading spaces, or
  capitalize/lowercase calls (e.g. `"Add {label}"` deriving a singular, `"Selected {kind}"`). Convert these to whole
  ICU messages with `select` while extracting each area.
- **One key, two meanings**: `notebookPanel.editedLabel` is reused as a full-date title (`notebook-panel.tsx:1993`).
- **Riskiest message**: `notebookMigrationDialog.reviewSummary` (nested plurals); consider splitting.
- **`relativeTimeLabel`** (`src/lib/relative-time.ts`, "5m ago") and the `"en"`-pinned `Intl.RelativeTimeFormat`
  in `where-was-i-card.tsx` / `search-view.tsx` move to the shared formatters, not to messages.
- **`electron/setup.html` is the whole Preferences window**, not only first-run setup; it is plain HTML outside
  Next, so it needs the main-process `t()` and the language must be passed in when it loads.
- **PDF footer** (`electron.main.markdownPdfFooter`): page numbers are filled by Chromium at print time.
- **Welcome headings** that used `<br/>` are now `<line>…</line>` rich-text tags.
- **Repeated phrases** ("Cancel" ×48, "Close" ×16, "Dismiss" ×14, "Save"/"Saving…" ×13, "Done" ×12, …) are
  candidates for a shared `common` namespace; dedupe while converting, not up front.

### Deliberately not inventoried
- Text sent to AI models (prompts, starter prompts, tool messages, LaTeX repair requests).
- Text inserted into the user's document: LaTeX snippet placeholders, Markdown toolbar defaults ("Heading",
  "List item"), slide-deck templates, live-block templates, PDF-to-Markdown markers.
- Rendering of the document itself in LaTeX Visual mode ("Figure", "Theorem", siunitx units): it follows the
  document's language (babel/polyglossia), not the interface language.
- Citation term values ("PhD thesis", "in press", "et al.") — citeproc localizes these from its own CSL locales.
- Photo filter names (Aden, Clarendon, …), format names (BibTeX, RIS, CSL-JSON), model and product names.
- Palette search keywords; consider translating them later so commands are findable in the user's language.

## Open decisions
1. First target language(s).
2. RTL in the first release or later.
3. Desktop only, or collab server and emails too.
4. Translation source: human, AI-drafted + review, or a platform (Crowdin / Weblate).
5. Default file and folder names ("Untitled", "New folder", "{stem} copy", "Recording {date}"): translate them
   (names on disk then differ by language) or keep English. They are in the inventory either way.
6. Example placeholders ("e.g. 12-14", "/Users/me/thesis/refs.bib", "Smith (2020)"): localize or keep.
