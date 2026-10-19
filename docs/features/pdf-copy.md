# Copying PDF text as Markdown

Copying selected text in the PDF viewer, with Cmd/Ctrl+C or the selection
menu's Copy button, puts clean Markdown on the clipboard instead of the
browser's raw text. Pasting into the visual editor parses it into headings,
lists and paragraphs; the source editor receives the Markdown itself.

The text is rebuilt from page geometry in `src/lib/pdf-markdown.ts`:

- Pages are cut into columns and blocks (recursive XY-cut), so a selection that
  runs down one column and into the next is read in order.
- Lines join into paragraphs. A new paragraph starts at a larger vertical gap, a
  first-line indent, a short line ending a sentence, a font size change, or a
  list marker. Paragraphs continue across columns and pages when the previous
  line stops mid-sentence.
- Words hyphenated at a line end are rejoined. The hyphen stays for compounds
  (`state-of-the-art`), capitalized or numeric continuations (`COVID-19`), and
  a few prefixes such as `self-` and `non-`. Broken URLs join without a space.
- Rows in the top or bottom margin are dropped when they are page numbers or
  repeat at the same position on nearby pages (running headers and footers).
  Rotated text, such as an arXiv stamp in the margin, is ignored. Selecting only
  a header still copies it.
- Larger text becomes `#` to `###` headings, and a short line set entirely in
  bold becomes `####`. Bullets and numbered items become Markdown lists;
  references such as `[12]` keep their hanging indent as one paragraph.
- Bold and italic runs become `**`/`*` emphasis, except in math fonts and when
  a whole paragraph shares the style. Monospace lines become fenced code blocks.
- Markdown syntax in the PDF text (`*`, `$`, `#` at a paragraph start, tags) is
  escaped so it pastes literally. A phrase from inside one line pastes inline.

Tagged PDFs (Word exports, tagged LaTeX, PDF/UA) also supply their structure
tree. When most of a page's text is tagged, its paragraph, heading and list item
elements decide the breaks and heading levels, and content marked as an
artifact is dropped.

Copy events are synchronous, so the viewer records each rendered page's text
geometry and fonts as it draws (`PdfLayoutStore` in
`src/components/libera/pdf-copy.ts`) and reads pages around a selection ahead of
time. If a selected page has not been measured, the browser's plain text is
copied as before.

Not handled: tables (cells are read by column when their gaps look like
gutters), footnote markers (kept as plain digits), equations, and scanned PDFs
without a text layer.
