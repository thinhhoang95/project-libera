# Table column widths

Columns of a table in the Visual (TipTap) editor can be resized by dragging
the border between two columns. Markdown tables have no attributes, so the
widths are kept in the document's front matter:

```markdown
---
table-widths: [[120, 240, null], [], [80]]
---
```

- One entry per table, in document order. Pipe tables and the HTML tables
  written for merged cells both count.
- One width per column in CSS pixels; `null` (or `0`) is an automatic column,
  `[]` a table without custom widths. Trailing automatic columns and tables
  are left out, and the line is removed when nothing is set.
- The value is a JSON array on one line (also valid YAML). Other front matter
  keys, such as `citation-style`, are left as they are.

## Where it is read and written

| Place | Code | Behavior |
| --- | --- | --- |
| Visual editor, loading | `tiptap-markdown.ts` (`LiberaMarkdown`) | Parsed tables get each cell's `colwidth` from the entry. |
| Visual editor, editing | `tiptap-table-widths.ts` | A resize, or adding, deleting or moving a table, rewrites the line in the same undo step. A table rewritten from Markdown (an AI edit, a paste) keeps its entry while the number of tables stays the same. |
| Visual editor, outside changes | `tiptap-table-widths.ts` | Undo/redo, a reload from the Source editor and a collaborator's edit apply the front matter to the tables. They never write it, so two editors never race to. |
| Preview, PDF export | `table-widths.ts` (`remarkTableWidths`), `markdown-renderer.tsx` | Each table gets a `<colgroup>`. A table whose columns all have widths is exactly that wide; otherwise it fills the line, and automatic columns share the rest. |

Slide decks (`*.slides.md`) cannot have front matter, so their columns are not resizable.

## Limits

- Entries follow their position, not the table's content. Adding a table
  above others in the Source editor shifts the entries until the line is
  edited. The Visual editor keeps them in step on its own.
- Widths are pixels, so a table wider than the page scrolls in the editor and
  the preview. The LaTeX export does not read them.
