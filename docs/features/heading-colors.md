# Heading and lead-in colors

Libera can color the headings of a note, and the bold words that open a paragraph or list item, so the structure of a long note shows at a glance. The colors are display only: the Markdown file is never changed.

```markdown
## Method

**Step one.** Collect the samples.

- **Calibration:** run it twice.
1. **Setup** the instrument.
```

With the default blue accent, `Method` is blue, and so are `Step one.`, `Calibration:`, `Setup` and the bullet and number markers.

## Where it shows

The colors apply in:

- the **Visual** editor;
- the rendered Markdown **preview**, beside the Source editor and in the preview window.

They do not apply in the Source editor, in PDF and LaTeX exports, or in Markdown slides. Exports keep their normal black text.

## Choosing a color

Open Preferences → **Markdown** → **Accent color** and pick a **Heading color**:

| Choice | Effect |
| --- | --- |
| Blue (default), Indigo, Teal, Green, Purple, Rose, Orange | One color for every heading, list marker and lead-in |
| Spectrum | A color for each heading level: H1 indigo, H2 blue, H3 teal, H4 green, H5 and smaller slate. List markers and lead-ins use the H2 blue |
| Custom… | Pick your own colors (below) |
| None | Headings stay plain |

Every color has a lighter shade that is used in the dark theme, so text stays readable. Changes apply to open notes straight away.

### Custom colors

Choosing **Custom…** shows six color pickers: Heading 1, 2, 3, 4, Heading 5 and smaller, and **Bullets, numbers and lead-ins**. They start as the Spectrum colors, and **Reset to Spectrum** puts them back. Pick the colors for the light theme; in the dark theme Libera mixes each one halfway to white.

## Bold lead-ins

A lead-in is bold text that comes first in a paragraph or list item, after any `-`, `*`, `1.` or task checkbox:

```markdown
**Term:** an explanation follows.

- **Step one** do this.
- [ ] **Open task** do that.
1. **Setup** the instrument.
```

Bold in the middle of a sentence is not a lead-in and keeps the normal text color. In the Visual editor, the bold run at the start of a paragraph is colored, even when it is only part of the first sentence.

Lead-ins take the list color: the heading color for a single color, the H2 blue for Spectrum, and **Bullets, numbers and lead-ins** for Custom.

Turn them off with Preferences → Markdown → **Color bold lead-ins** while keeping colored headings. With **Heading color** set to None, lead-ins are not colored either.

## What keeps its own color

The accent never overrides a color you chose:

- text colored by hand, with `[color=#2563eb]…[/color]`, and any lead-in inside it;
- anything inside a colored box (a blockquote with a box color), which uses that box's readable foreground.

## Settings and environment

The settings are stored with the other Preferences and passed to the server as environment variables:

| Preference | Variable | Values |
| --- | --- | --- |
| Heading color | `LIBERA_MARKDOWN_HEADING_COLOR` | `none`, `blue`, `indigo`, `teal`, `green`, `purple`, `rose`, `orange`, `spectrum`, `custom` |
| Custom colors | `LIBERA_MARKDOWN_HEADING_PALETTE` | JSON with `h1`–`h5` and `lists`, each `#rrggbb` |
| Color bold lead-ins | `LIBERA_MARKDOWN_BOLD_LEAD_INS` | `1` (default) or `0` |

An unknown color name falls back to blue, and an invalid palette entry to its Spectrum value.

## How it works

- `electron/markdown-accents.cjs` defines the color names, the default palette and the normalizers, shared by Preferences and the Next server.
- `src/components/libera/use-markdown-accents.ts` sets `data-heading-color`, `data-bold-lead-ins` and the custom palette variables on the root element.
- `src/app/globals.css` maps each color to `--libera-heading-accent` (and `--libera-level-accent` per heading level for Spectrum and Custom), with a lighter shade under `.dark`.
- `src/lib/markdown-lead-in.ts` is a rehype plugin that gives the opening `<strong>` of a paragraph or list item the class `libera-lead-in` in rendered Markdown. It runs after sanitizing.
- `src/lib/tiptap-bold-lead-ins.ts` does the same for the Visual editor with ProseMirror decorations, so the document and the saved Markdown are untouched.
