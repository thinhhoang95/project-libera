# PDF outlines and annotations

For a PDF, the **Outline** view of the Outlines panel shows the PDF's table of contents. Its highlights, notes and drawings are in the **Annotations** tab, which appears in the left rail only while a PDF tab is active.

## The outline

When the PDF has bookmarks of its own, the Outline view shows them as a tree. **Expand to** sets how many levels are open; the chevrons open and close single entries; **Search outline** finds entries in closed branches too. Click an entry to go to its page. Bookmarks that point to a spot on the page scroll to that spot.

When the PDF has no bookmarks, the view offers **Generate outline**. Libera opens the AI panel and starts an Agent chat that says "Generate an outline for <path>." with the `generate-pdf-outline` skill loaded. The command palette has **Generate PDF outline** (Regenerate when there is one, unavailable for PDFs with bookmarks) and **Show PDF annotations**.

A generated outline shows **AI outline** above it, with a button to generate it again and one to delete it. If the PDF also has bookmarks (it was replaced by a version with bookmarks, say), **Show AI outline** and **Show bookmarks** switch between them. Entries whose title is not in the PDF's extracted text are in italics. A note under the header lists what verification found and the agent left as it was; expand it to read the problems. If the PDF changed since the outline was made, the view says so and offers **Regenerate**.

## How an outline is generated

1. **Chunks.** GenerateOutline splits the PDF into chunks of at most 12 pages and about 40,000 characters.
2. **Outliners in parallel.** Each chunk goes to a subagent, at most four at a time. A subagent gets its pages' text with one difference from plain extracted text: lines printed in larger type than the body text start with their relative size, such as `[×1.6] 2 Methods`, because plain text alone cannot tell a heading from a sentence. If the first pages have a printed table of contents, every subagent gets it as well, so subagents that work apart agree on titles and levels. A subagent also sees the end of the page before its chunk, for context. It finishes by calling SubmitOutline with its headings: title, level, page, and number.
3. **Checking each chunk.** SubmitOutline checks each heading against the page text, ignoring spacing, case, punctuation, hyphenation and ligatures. A heading found on another page of the chunk moves there. A heading found nowhere is sent back once, to be copied exactly. The second time it is kept and marked as not found, because PDF text often mangles headings that contain math.
4. **Stitching.** The chunks are joined in page order. A heading repeated at a chunk edge is dropped. A chunk that starts in the middle of a chapter cannot know the chapter's level, so its levels are compared with those of the other chunks. For numbered headings, the level is the depth of the number plus an offset: "3" and "3.2" are one level apart. When most of a chunk's numbered headings use a different offset than the rest of the document, the whole chunk is shifted. Then the top level becomes 1, and jumps of more than one level are closed. The agent is told about every adjustment.
5. **Verification.** The whole outline is checked:
   - **Errors** (they break the outline): entries out of page order; a first entry that is not level 1, or a jump of more than one level; a number at the wrong depth (2.3 at another level than the other two-part numbers); a number under the wrong parent (2.3.1 under 4); siblings numbered out of order; repeated entries; pages outside the PDF; pages a subagent could not outline.
   - **Warnings** (worth a look; they may be right): titles not in the page text (with the page where they were found, if any); gaps in the numbering (2.1 then 2.3); long stretches without an entry (at least 25 pages, or a fifth of the PDF).
6. **Feedback and amendment.** The outline is saved, and the verification goes back to the agent with the outline, or, for a long one, with the entries around the problems. The agent fixes them with **AmendOutline**: update, insert, delete or shift entries by id (`o1`, `o2`, …). It reads the pages first when it needs to. Each call is verified and saved again, and the result says what is left. Pages that a subagent could not outline (the token budget ran out, the run hit a limit) are outlined again with `GenerateOutline` and `pages: "41-60"`, and the result is spliced into the saved outline. When the agent ends its reply with errors left, the finish pass sends them back, at most twice. Warnings it judges right can stay.

Scanned PDFs without a text layer are refused, with a suggestion to convert them with [PDF to Markdown](pdf-to-markdown.md) first. A PDF with its own bookmarks is left alone unless the user asks for an AI outline anyway.

## The side-car

A generated outline is a side-car JSON file beside the notebook's other Libera data: `<notebook>/.libera/outlines/by-path/<folders>/<file name>.json`. A linked folder keeps it in Libera's data directory instead. The file records the entries, the problems that are left, the model, when the outline was made and amended, and the PDF's size and SHA-256 hash.

The side-car follows its PDF in every case:

- Renaming, moving, archiving or deleting the PDF or its folder in Libera does the same to the side-car. Copying the PDF copies it, because the outline describes the bytes the copy shares.
- **Renamed or moved while the outline is being generated.** The save checks that the PDF at the path is still the file the outline was made from. If it moved, the outline is saved for the PDF with the same bytes, and the agent is told. If it was deleted or changed, nothing is saved.
- **Renamed, moved or deleted outside Libera** (Finder, Explorer, a sync client): see below. This works the same way for annotations and definitions.
- **Shared notebooks.** When the collab host moves or removes a PDF, for a collaborator or for this user, the PDF's side-cars on this computer follow it.

## Annotations

The Annotations tab lists the PDF's highlights, notes, shapes and drawings in page order. The tab shows how many there are, and **Search annotations** filters them by text or by page ("p. 4"). Press Enter to go to the first match, or Escape to clear the search. Click an annotation to show it. Right-click a highlight to **Quote and cite** it. The tab appears in the rail only while a PDF is the active tab, with the contextual-tab mark used by app pages such as Spending. Unlike a page's tab, it does not open by itself. When another kind of tab becomes active, the panel goes back to the one you used before.

## PDFs changed outside Libera

A PDF's side-cars (annotations and comment threads, the generated outline, definitions cards) are stored by the PDF's path. On every library refresh, Libera looks for side-cars whose PDF is gone. It then:

- moves each such side-car to the PDF with the same bytes, when exactly one PDF in the notebook without that kind of side-car has them. This handles a rename or move in Finder or Explorer. Libera compares sizes first, so it hashes only PDFs whose size matches.
- otherwise, after 30 seconds, moves the side-car to `<notebook>/.libera/orphaned-sidecars/<kind>/`. A different PDF later saved under the old name therefore does not inherit someone else's notes. If the original PDF comes back within 90 days (from the trash, under any name), its side-cars are put back.

Annotation side-cars now record the PDF's size and hash when they are saved. Older ones get them once, in the background. An older side-car whose PDF went missing before that can come back only under its old name.

## Implementation

- `src/lib/pdf-outline.ts`: entry and file types, the browser events, numbering, title matching, chunk planning, table of contents detection, stitching, verification, and the rows the tree shows.
- `src/lib/agent/skills/generate-pdf-outline.ts`: the skill, GenerateOutline (with the subagents and SubmitOutline), AmendOutline, saving with the rename check, and the finish pass.
- `src/lib/storage/pdf-outlines.ts`: the bookmarks (pdf.js, remembered by file signature), page text with type sizes, and the side-car. `src/app/api/pdf-outline/route.ts`: `GET ?path=` and `DELETE ?path=`.
- `src/lib/storage/pdf-sidecars.ts`: re-attaching and setting aside side-cars (`reconcilePdfSidecars`, called from `tree.ts`), shared notebook moves (`followSharedPdfChanges`, also through `src/app/api/pdf-sidecars/route.ts` from the host's tree-changed events), and finding a PDF by its bytes. `src/lib/storage/pdf-identity.ts`: the cached size and hash.
- `src/components/libera/pdf-outline-panel.tsx`: the Outline view for PDFs and the palette commands. `src/components/libera/pdf-annotations-panel.tsx`: the Annotations tab. `page-tabs.ts`: the contextual rail tab.

## Checks

```
node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/pdf-outline.test.ts scripts/editor/pdf-outline-panel.test.ts scripts/editor/outline-panel.test.ts
```

The tests cover numbering, title matching, chunking, table of contents detection, stitching, every verification problem, and amend operations. With a scripted model, they cover a GenerateOutline run: a heading sent back and fixed, a chunk shifted, a chunk that failed and was filled in later, and AmendOutline. They also cover reading bookmarks from a real PDF, the refusals (bookmarks, scans), a PDF renamed or deleted during generation, the side-car following Libera's renames, copies, folder renames and deletes, side-cars re-attached after a rename outside Libera, set aside after a delete, not inherited by a new PDF and restored with the old one, and a shared notebook's moves and removals. The panel tests cover the bookmarks tree and navigation, generating and showing an AI outline, and the contextual tab's rules.
