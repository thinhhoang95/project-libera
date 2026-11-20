# Links follow moved files

When a file or folder moves in the app, the paths written in notes and LaTeX sources that pointed at it, or that a moved note wrote from its old place, are rewritten so they keep opening the same file. The rule is the notebook check's: after any in-app move, **Check Notebook** reports no link, image, chart or LaTeX finding it did not report before. A path that already found nothing is left exactly as it was: never "fixed", never pointed at another file.

Code: `src/lib/move-rewrites.ts` (pure: where the paths are in a text, and applying a rewrite; shared by the server and the app), `src/lib/storage/move-links.ts` (planning against the disk, writing notes, the records that follow), `src/lib/latex/path-occurrences.ts`. Tests: `scripts/editor/notebook-move-links.test.ts`.

## Which moves

Every in-app move of a local file or folder: Move… and drag and drop in the rail (`moveFileToDirectory`, one call per file, which the multi-selection's batch move also uses), rename (`moveFile`), Archive File (`archiveFile`), folder rename (`renameFolder`) and Archive Folder (`archiveFolder`). A move to another notebook is a migration (`migration.ts`), which applies the same engine with its committed mapping in a finalize step of its own.

## What is rewritten

The planner resolves each path with the resolver that reads it, before the move (the old layout: what is on disk now, with the moved paths put back) and after it, and changes only paths whose target would change:

| Where | Resolver | Rewritten when |
|---|---|---|
| Markdown links: inline, reference definitions (the first of a label wins, as in CommonMark), angle-bracket destinations, HTML `<a href>` | `resolveMarkdownFileLink` (relative to the note, then from the library root), as `linkCandidates`/`resolveLinkTargetWith` give it to the check | the link found a file before, and from the note's new place, or because the file moved, it finds another file or none |
| `/api/files/raw/<library path>` addresses, in links, images and HTML `<img src>` | the library path in the address | that file moved |
| ```` ```chart ```` data files (`.csv`, `.tsv`) | `resolveDeckRelativePath` (the note's folder, not past the notebook) | the data file or the note moved |
| LaTeX `\input`, `\include`, `\subfile`, `\includegraphics(*)`, `\includepdf`, `\lstinputlisting`, `\bibliography`, `\addbibresource` | `latexDependencies`'s candidates, from each main file's folder | the file, a main file that builds it, or the source moved |

The new path keeps the link's style: a link that resolved relative to its note is written relative to its new place, one written from the library root stays a library path (written relative instead if a file at the relative candidate would shadow it). Only the path changes: the title, the fragment (a heading, `#t=73`, a saved `#libera=…` position, an annotation id), the query, angle brackets and quotes stay as written. Path segments that are unchanged keep their original spelling and percent-encoding; new ones are percent-encoded where a destination needs it (spaces, parentheses, `%`, `#`, `?`, quotes, `&`), and fully (`encodeURIComponent`) when the link already used percent-encoding. A LaTeX path keeps whether it named the extension; a chart value keeps its quotes.

Every new path is resolved again against the layout after the move and must find the intended file (not just some file); otherwise it is not written and is reported.

Left alone: code spans and fences (links there are not links), external URLs and fragment-only links, `_assets/...` and `/api/markdown-assets/raw?document=…&asset=…` image addresses (they name the notebook, not the note's folder, so a move inside a notebook does not change them; a migration's image step already rewrites moved notes' images), paths that found nothing before the move, LaTeX names built by a macro (`#1`, `\figdir/a`; the check only counts them), `\import`/`\subimport`, `% !TEX root` and `\documentclass[…]{subfiles}`.

Reported instead of rewritten (the notice lists them; Check Notebook then shows the broken link, as the oracle requires): a reference definition shared by a link and an image whose resolvers want different paths (the definition would have to be split), a chart whose data file ends up in another notebook (charts can't reach another notebook), a LaTeX chapter built from two main files that would need two different paths, a path whose spelling has Markdown escapes and whitespace that can't be written back, a note that can't be read or written, a note in a shared notebook, a note a running migration is moving.

## Which notes are read

The moved notes and LaTeX sources, and every Markdown note of every local notebook (links between notebooks are library paths): the link index can lag, so it is not trusted to narrow the search. A note is read in full (a walk of at most 20,000 entries per notebook, `_archive` included, like the check's) and parsed only when its text names one of the moved or arriving items (the last segment of each path), or has a `%`, `&` or `\` that could spell one. LaTeX projects of the notebooks involved are read through `latexDependencies` (at most 400 sources, like the check). A notebook that can't be read in full is reported as not fully checked.

## Order of the rewrites

On the server and in the app, one order: **images, then links, then citation keys**. Images first because the migration's image map is keyed by the text as staged; links are planned on the text after it; citation keys last, because the cited-references step plans on the text it finds and records its hashes. Within the link step, all kinds (links, images by address, charts, LaTeX) are one pass of span edits, applied from the end of the text.

## Where the rewrite is applied

One pure function, `rewriteMovedPaths(text, filePath, rewrite)`, applies a note's rewrite: `rewrite` maps each path *as written* (its source text) to the text written instead, per kind (`link`, `image`, `html-link`, `html-image`, `chart`, `latex`). A span used by several kinds (a definition shared by a link and an image) changes only when every kind maps it to the same text.

- **On disk**, after the move committed, each note is rewritten under its path lock (`withPathLocks`), read and published with `replaceFileIfUnchanged`: a note saved meanwhile is read again and its rewrite planned on that text, never overwritten. A failure is an `unfinished` step (`step: "links"`); the move itself stands.
- **Pending agent reviews** (baselines, `transformReviewBaselines`), **undo history** (`recordMovedRunFiles`: the original and draft rewritten, the written hash carried over) and **review comments** (the snapshot and its anchors mapped through each edit, `rewriteReviewSnapshots`), as the migration does for its image rewrites.
- **The link index** forgets the rewritten notes (the tree load that follows every move reads them again), the **citation index** of each notebook concerned is refreshed, and **Global Search** is told.
- **Open tabs**: `followFileMove` (every renderer move path) applies each note's rewrite to the tab's draft and its save baseline, so a note open with unsaved edits gets the same change on both and saves without a conflict. The moved note's own tab composes images, links and citation keys (`movedTabText`). Saved workspaces' tabs, saved and unsaved, get the same rewrite (`WorkspaceFileChange.rewrite`, now applied to tabs that did not move too). A link only in an unsaved draft is rewritten when its destination, as written, is one the saved text had.

## Response contract

`LiberaFileMovePayload` (and the folder rename and archive responses) gain `links`:

```ts
links?: {
  /** Each note whose text was rewritten, by its path after the move, and the rewrite applied to it. */
  rewritten: { path: string; rewrite: MovedPathRewrite }[];
  /** Paths that could not be kept: the note, the path as written, why. */
  skipped: { path: string; written: string; reason: string }[];
  /** Notebooks whose notes could not all be read, so links there may not have been followed. */
  unchecked: string[];
}
```

`changedLinks` is gone (its notice, "links in a moved note now open another file", too): the app says **Updated links in N notes**, and warns with the list of what could not be rewritten. A move that failed after the file moved (`MoveCommittedError`, a body with `moved` and `unfinished`) still retargets the tab and shows the unfinished steps.

## Migration

The link step runs after the files moved and before the cited-references step, with the committed mapping: only the items that are at their new path (a partial migration, **Stop here**, rewrites for what moved; a selected file that stayed in the source is a note like any other, and its links to what moved follow). An item at both places (its source edited after its copy was published) is left alone on both sides, for the person to sort out. Its plan (each note's rewrite and its text hashes before and after) is saved in the journal (`linkRewrites`) before the first note is written; a resume applies the same rewrites: a note at its rewritten text is left alone (applying twice could chain one path into another), any other text gets the saved rewrite applied once. A moved note at its rewritten text is the note this migration moved (`isOurs`, the final check). The result carries each moved note's rewrite (`moved[].links`) and the other notes' (`linkRewrites`), which the app applies to tabs and saved workspaces in the same order. The review's link warnings now say the links are updated.

## Shared notebooks

Text of a shared note changes only through the shared write path, with the host's document authority. A move inside a shared notebook (`moveSharedFile`, `renameSharedFolder`) rewrites nothing, as before. A local move whose links are in a shared notebook's notes leaves those notes and lists them as not rewritten.

## Not done

- A Try to fix pairing never rewrites links (name-only repair, `notebook-integrity.md`).
- Links in plain text files, chat history, and `\import`/`\subimport` paths are not rewritten.
- A reference definition is never split; see above.
