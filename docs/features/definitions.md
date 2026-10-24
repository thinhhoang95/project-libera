# Definitions and notation

Math papers and notes introduce many symbols and terms before the interesting part starts. The **Definitions** tab of the Outlines panel keeps them at hand: one searchable card per definition, symbol and standing convention, with the math typeset, and a link back to where each one is introduced.

## Generating the cards

Open a Markdown note, a LaTeX file or a PDF, choose **Outlines** in the left rail, switch the panel from **Outline** to **Definitions**, and click **Generate definitions**. Libera opens the AI panel, starts a new Agent chat (it reuses the open chat if that one is still empty) and sends "Extract the definitions and notation in <path>." with the `extract-definitions` skill already loaded. The agent uses the chat's model, reasoning effort and permission mode.

The agent reads the whole document, unsaved changes included: a text file window by window, a PDF 20 pages at a time from its extracted text. It saves cards as it goes, so they appear in the tab while it works. You can follow its steps in the AI panel. The document itself never changes, so this works in every permission mode, Read Only included.

If the run ends without saving a card (the model cannot call tools, the API key is rejected, or you stopped it), the tab says so; the agent's reply in the AI panel gives the reason. Wait for a reply to finish, or stop it, before you generate: the AI panel runs one request at a time.

The command palette (⌘/Ctrl+Shift+P) has the same actions under **Definitions**, for the document in view:

- **Generate definitions** opens the Definitions tab and starts the run. It reads **Regenerate definitions** when the document already has cards, and **Generating definitions…** (unavailable) while a run for it is going on.
- **Show definitions** opens the Outlines panel at the Definitions tab.

You can also ask the agent yourself, for example "collect the notation in thesis.pdf". It loads the same skill, and the cards show up in the tab.

## The cards

Each card has:

- the **term**: a name ("Lipschitz continuity") or a symbol ($\mathcal{F}_t$);
- its **kind**: Definition, Notation or Convention (standing assumptions and usage rules, such as "throughout, $G$ is a finite group" or "$\log$ is natural");
- its **meaning** in this document, in Markdown with math, in the document's own symbols;
- **aliases** to search by, such as the spoken name of a symbol ("script F", "filtration");
- where it is **introduced**: the document's label ("Definition 2.3", "§1.2") or a line or page, and the excerpt that introduces it.

The cards look like the cards in the Comments panel: the term and its kind on top with the location at the right, the excerpt in italics, then the meaning and the aliases. Click a card to select it and jump to where it is introduced: a Markdown editor selects the passage, a LaTeX editor goes to the line, and a PDF opens at the page and finds the excerpt.

An overloaded symbol gets one card per meaning, each with its own location. A symbol the document uses without defining gets a card only when its meaning is clear from the document, marked "used without definition".

Cards use the math markers set in Preferences. In a Markdown note they may use the note's [Markdown macros](markdown-macros.md), which are expanded when the cards are shown.

**Search** puts the best matches first: cards whose term is the query, then terms that start with it, then terms that contain it, then aliases, then meanings, locations and kinds; ties keep the document's order. Math is matched the way it reads, ignoring spacing, punctuation, braces and the `_` and `^` marks: `Qfg`, `Q f g` and `Q_{f,g}` all find $\mathcal{Q}_{f,g}$, Greek letters can be typed as letters or names (`πK` and `PiK` find $\Pi_K$), and LaTeX command names match too, so `mathcal` finds every $\mathcal{…}$ symbol. In aliases and meanings, a query squeezed this way must be at least three characters long or match whole words, so short queries do not match by accident. Press Enter to jump to the first match, or Escape to clear the search. **Show** narrows the list to one kind and counts each kind. Long lists show 60 cards at a time.

## Checks

The agent's work is checked before it is saved. Anything wrong goes back to the agent with what to fix, as with the agent's other skills.

Each card sent to **SaveDefinitions** is checked:

- **Math.** Every formula must typeset in KaTeX, and inline math must be closed on the same line. LaTeX commands outside math markers are refused, because they would show as raw text. In a Markdown note the note's macros are allowed. In LaTeX and PDF documents the agent must write the document's own `\newcommand` and `\DeclareMathOperator` macros out in standard LaTeX, because KaTeX does not know them.
- **Where it is introduced.** In Markdown and LaTeX, the excerpt must be in the document exactly (only spacing may differ), and the card's line is taken from it; a line past the end is refused, and a card with neither excerpt nor line is refused. In a PDF a card needs a page. Its excerpt is looked for ignoring spacing, punctuation and ligatures; when it is found on another page, the card moves there, and when it is not found (PDF text often mangles math), the card is kept without it.
- **Meaning.** It must explain the term, not restate it.
- **Repeats.** The same kind, term and location twice in one call is refused.

Rejected cards are not saved, and the rest of the call is. The agent resends only the fixed cards. In the AI panel the save step says how many were rejected; expand it to see why. If none of the cards in the first save of a run are valid, the previous cards are kept.

When the agent finishes its reply, Libera looks for passages that usually introduce something but have no card pointing at them:

- in text: `\begin{definition}` (and `notation`, `convention`, `assumption`), headings and `\section`s named Definitions or Notation, lead-ins such as "**Definition 3.**", `:=`, `\coloneqq` and `\triangleq`, and phrases such as "we denote", "we say", "is called" and "let … denote";
- in a PDF: pages with "Definition 2.1", "we define", "is called" or `:=` and no card.

It sends the list (at most 15 passages, with the count of the rest) back to the agent, at most twice per run. The agent saves cards for passages that introduce something and says in its reply which ones did not. A reminder is also sent once if the agent loaded the skill and saved nothing.

## The side-car file

The cards are stored in a side-car JSON file next to the notebook's other Libera data: `<notebook>/.libera/definitions/by-path/<folders>/<file name>.json`. A linked folder keeps it in Libera's data directory instead. Renaming, moving, copying, archiving or deleting the document (or its folder) in Libera does the same to the side-car. A PDF's cards also follow it when it is renamed or deleted outside Libera, as its annotations do ([PDF outlines and annotations](pdf-outlines.md#pdfs-changed-outside-libera)). In a shared notebook it stays on this computer: each member has their own cards.

The file records the model and the time the cards were made, and the document's size and SHA-256 hash. When the document has changed since then, the tab says so and offers **Regenerate**. If the cards were made from unsaved changes, they show as changed until the document is saved.

The refresh button generates the cards again at any time: the first save of the new run replaces the old cards. The trash button, after a confirmation, deletes the file.

## Implementation

- `src/lib/definitions.ts`: card and file types, parsing and normalization, search, excerpt matching, and the browser events between the tab and the AI panel.
- `src/lib/definitions-validation.ts`: the card checks (KaTeX, math markers, excerpts, lines and pages, repeats) and the search for passages without a card.
- `src/lib/agent/skills/extract-definitions.ts`: the skill's instructions, the SaveDefinitions tool and the finish pass.
- `src/lib/storage/definitions.ts`: reading, writing and deleting the side-car, and the staleness check. `src/lib/storage/files.ts` moves, copies and deletes it with the document; `definitionsPath` and `definitionsDirectoryPath` in `src/lib/storage/paths.ts` place it.
- `src/app/api/definitions/route.ts`: `GET ?path=` reads the cards and whether the document changed; `DELETE ?path=` deletes the file.
- `src/components/libera/definitions-panel.tsx`: the tab, and `DefinitionsPaletteCommands`, the palette commands (rendered in `libera-app.tsx`). `outline-panel.tsx` holds the Outline and Definitions switch, which `outline-view.ts` remembers and lets the palette set, and `document-chat-panel.tsx` starts the run when the tab asks (`libera:definitions-request`) and reports saves (`definitions_saved` agent events) and the end of the run back to it.

## Checks

`node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/definitions.test.ts scripts/editor/definitions-palette.test.ts`

The tests cover search ranking and LaTeX matching, the math checks, excerpt and line checks, PDF page correction, the search for uncovered passages, search, and a SaveDefinitions run in Read Only: rejected cards and their feedback, the finish pass, merging later saves, staleness, and the side-car following a renamed and a deleted document. The palette test covers when Generate is offered, the request it sends, the switch to the Definitions tab, and Generate waiting while a run goes on.
