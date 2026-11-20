# Table column widths

Columns of a table in the Visual (TipTap) editor can be resized by dragging
the border between two columns. Markdown tables have no attributes, so the
widths are kept in the note's [macro block](markdown-macros.md), as a magic
comment in the style of TeX's `% !TEX program = xelatex`:

````markdown
```libera-macro
\R = $\mathbb{R}$
% !table-widths = [[120, 240, null], [], [80]]
```
````

- One entry per table, in document order. Pipe tables and the HTML tables
  written for merged cells both count.
- One width per column in CSS pixels; `null` (or `0`) is an automatic column,
  `[]` a table without custom widths. Trailing automatic columns and tables
  are left out, and the line is removed when nothing is set.
- The value is a JSON array on one line. `% !table-widths: [...]` and
  spacing variations are read too.
- The macro parser reads the line as a comment: it is not a definition, not
  a problem, and it is hidden wherever macro blocks are (preview, PDF export,
  **Expand macros**, which drops the widths with the block).

The first macro block that has the line holds it. When resizing a column, the
Visual editor writes the line into that block, else into the note's first
macro block, else into a new block at the top of the note (after any YAML
front matter). A new block holding only the line starts folded. A block that
held nothing but the line is removed once no widths are left.

## Where it is read and written

| Place | Code | Behavior |
| --- | --- | --- |
| Visual editor, loading | `tiptap-markdown.ts` (`LiberaMarkdown`) | Parsed tables get each cell's `colwidth` from the entry. |
| Visual editor, editing | `tiptap-table-widths.ts` | A resize, or adding, deleting or moving a table, rewrites the line in the same undo step. A table rewritten from Markdown (an AI edit, a paste) keeps its entry while the number of tables stays the same. |
| Visual editor, outside changes | `tiptap-table-widths.ts` | Undo/redo, editing the line in the macro block, a reload from the Source editor and a collaborator's edit apply the line to the tables. They never write it, so two editors never race to. |
| Preview, PDF export | `table-widths.ts` (`remarkTableWidths`), `markdown-renderer.tsx` | Each table gets a `<colgroup>`. A table whose columns all have widths is exactly that wide; otherwise it fills the line, and automatic columns share the rest. |

Slide decks (`*.slides.md`) render each slide on its own, so their columns are not resizable.

## Limits

- Entries follow their position, not the table's content. Adding a table
  above others in the Source editor shifts the entries until the line is
  edited. The Visual editor keeps them in step on its own.
- Tables are counted as written in the note. A table that a text macro
  produces is counted by the preview but not by the Visual editor.
- Widths are pixels, so a table wider than the page scrolls in the editor and
  the preview. The LaTeX export does not read them.
