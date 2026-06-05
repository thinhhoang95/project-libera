# Markdown Slides

Markdown Slides is a Libera Markdown mode for writing a slide deck as a single
Markdown file. A deck stays inside the normal notebook filesystem, uses normal
Markdown rendering for slide content, and can be previewed as individual 16:9
sheets or presented full screen.

## File naming

Libera detects a slide deck by filename:

```text
my-talk.slides.md
my-talk.slides.markdown
```

These files are still Markdown files internally. They use the same storage,
saving, downloading, image insertion, math rendering, and workspace link
behavior as other Markdown notes.

Files named `my-talk.md` or `my-talk.markdown` continue to render as regular
Markdown notes, even if their content contains slide metadata or `---`
separators.

## Creating a deck

Use **New slides** from a notebook action menu, notebook home, or the empty
workspace state. Libera opens the normal creation dialog in slide mode and
defaults the name to:

```text
Untitled.slides.md
```

If you type a name without the slide marker, Libera normalizes it:

```text
Lecture 01        -> Lecture 01.slides.md
Lecture 01.md     -> Lecture 01.slides.md
Lecture 01.markdown -> Lecture 01.slides.markdown
Lecture 01.slides -> Lecture 01.slides.md
```

New decks start with a minimal default template:

```markdown
$title = "Untitled"
$subtitle = ""
$author = []
$affiliation = []
$date = ""
$template = "default"
$fontsize = 21
---
$title = "First Slide"

Start your slide content here.
```

## Deck structure

A slide deck has two parts:

1. A title slide block before the first `---`
2. One or more content slide blocks after `---` separators

Example:

```markdown
$title = "Presentation Title"
$subtitle = "Optional Presentation Subtitle"
$author = ["Slide Author 1", "Slide Author 2"]
$affiliation = ["Affiliation of Author 1", "Affiliation of Author 2"]
$date = "01/01/2024"
$template = "default"
$fontsize = 21
---
$title = "Slide Title"

This is the first slide.

- Bullet one
- Bullet two
---
$title = "Second Slide"

This is the second slide.
```

The block before the first separator is the title slide. Its metadata configures
the whole deck and is also rendered by the default template as the first visible
slide. If that block includes body Markdown after its metadata lines, the body is
rendered on the title slide.

Every block after a separator is a normal content slide.

## Separators

A slide separator is a line containing only:

```markdown
---
```

Separators inside fenced code blocks are ignored:

````markdown
---
$title = "Code Example"

```text
---
This line is rendered as code, not treated as a slide separator.
```
````

Empty slide blocks are ignored unless they contain a title or content.

## Metadata syntax

Metadata uses dollar assignments:

```markdown
$key = JSON_LITERAL
```

The value must be valid JSON. Strings need double quotes, arrays use JSON array
syntax, and booleans or numbers use normal JSON literals.

Valid examples:

```markdown
$title = "Aerospace Systems"
$subtitle = "Flight Mechanics and Design"
$author = ["Nguyen An", "Tran Binh"]
$affiliation = ["VLU", "VLU"]
$date = "2026-06-05"
$template = "default"
$fontsize = 21
$draft = true
$duration = 20
```

Invalid examples:

```markdown
$title = Aerospace Systems
$author = ['Nguyen An']
```

Invalid metadata does not stop the deck from rendering. Libera shows a compact
warning above the slide preview and continues with the metadata it could parse.

## Deck metadata

Supported deck-level fields:

| Field | Type | Purpose |
| --- | --- | --- |
| `$title` | string | Deck title shown on the title slide and used as a fallback footer label. |
| `$subtitle` | string | Optional subtitle shown under the cover slide title. |
| `$author` | string or string array | Author list shown on the title slide and bottom-right slide footer. |
| `$affiliation` | string or string array | Affiliation list shown on the title slide. |
| `$date` | string | Date shown on the title slide. |
| `$template` | string | Built-in template id. Defaults to `"default"`. |
| `$fontsize` | number | Base font size for slide body Markdown across the deck. Defaults to `21`. |

Unknown fields are preserved by the parser for future templates, but the current
default template does not display them.

## Slide metadata

Supported slide-level fields:

| Field | Type | Purpose |
| --- | --- | --- |
| `$title` | string | Slide title shown at the top of the slide sheet. |
| `$fontsize` | number | Base font size for this slide's body Markdown, overriding the deck font size. |

Unknown slide metadata is preserved for templates. It is not displayed by the
default template.

Slide metadata must appear at the top of the slide block, before the slide
content:

```markdown
---
$title = "Methods"
$fontsize = 18

The slide body starts here.
```

Once regular Markdown content starts, later `$key = ...` lines are treated as
content rather than metadata.

## Markdown content

Slide body content uses the same renderer as regular Markdown notes:

- GitHub-flavored Markdown
- Tables
- Inline and block math through KaTeX
- Images
- Workspace-relative Markdown links
- External links

Example with math and an image:

```markdown
---
$title = "Lift Equation"

$$
L = \frac{1}{2}\rho V^2 S C_L
$$

![Wing section](wing-section.png)
```

Relative images are resolved against the slide deck file, the same way they are
for normal Markdown notes.

## Font size

Set `$fontsize` in the title slide block to control body Markdown across the
whole deck:

```markdown
$title = "Large Type Deck"
$fontsize = 18
---
$title = "Overview"

This slide uses the deck font size.
```

Set `$fontsize` in an individual slide block to override the deck value:

```markdown
---
$title = "Dense Appendix"
$fontsize = 12

This slide uses a smaller base font size.
```

The value must be a positive JSON number. Libera applies it to Markdown body
content only. Template chrome such as slide titles, title-slide metadata,
counters, and footers stays fixed.

In the default template, fixed chrome sizes are:

- Cover slide title: 48pt
- Cover slide subtitle: 32pt
- Cover slide metadata/body chrome outside the title: 24pt
- Content slide title: 32pt
- Header and footer chrome: at least 18pt

## Preview behavior

When a `.slides.md` file is open, the editor remains on the left and the preview
pane changes from document preview to slide preview.

The preview pane shows:

- Each slide as a separate fixed-width sheet with natural content height
- Deck warnings above the sheets, if any exist
- The currently remembered slide outlined in the preview
- Markdown content spanning the slide interior with the same left margin as the title

All preview sheets use the same width in the preview canvas. Slide height is
automatic, so larger fonts or longer content can expand the sheet and remain
visible in the preview.

Slide sheets always use a light presentation theme, even when the Libera app is
in dark mode. This keeps slide background, text, code blocks, and borders
consistent between preview and presentation. The default template renders slide
text in black regardless of the surrounding app theme.

Regular `.md` files keep the existing Markdown preview behavior, including
editor/preview scroll sync and double-click source positioning.

Slide decks intentionally do not use editor/preview scroll sync in this first
version. The source text and slide sheets have different structures, so scroll
sync would be misleading.

## Fullscreen presentation

For regular Markdown notes, the toolbar fullscreen button still enters preview
only mode.

For slide decks, the same toolbar button becomes **Present slides**. It opens a
slide presenter using the current unsaved editor draft. Saving is not required
before presenting.

The presenter asks the browser or Electron shell for fullscreen. If fullscreen
is not available, it falls back to an app-filling overlay.

In presentation mode, the active slide uses the largest fixed 16:9 rectangle
that fits inside the fullscreen viewport. The presenter does not reserve layout
space for a header bar or side navigation; slide count, navigation, and exit
controls float over the slide.

## Presenter controls

Keyboard controls:

| Key | Action |
| --- | --- |
| Space | Next slide |
| Enter | Next slide |
| ArrowRight | Next slide |
| PageDown | Next slide |
| ArrowLeft | Previous slide |
| PageUp | Previous slide |
| Backspace | Previous slide |
| Home | First slide |
| End | Last slide |
| Escape | Exit presentation |

The presenter uses keyboard navigation for slide changes. A visible exit button
is available in the bottom-right corner.

Libera remembers the active slide index in the open tab view state. If you leave
the presenter and return later, the same tab can reopen at the last slide.

## Templates

Version 1 ships with one built-in template:

```markdown
$template = "default"
```

The default template provides:

- A fixed-width white slide sheet with natural height in preview
- A fixed 16:9 slide sheet fitted to the viewport in presentation mode
- A title slide rendered from the first block before `---`
- A fixed 32pt slide title header
- Body content aligned with the slide title and spanning the slide interior
- A footer with the slide title on the left and author names on the right
- A slide counter

If `$template` is missing, Libera uses `default`.

If `$template` names an unknown template, Libera shows a warning and falls back
to `default`.

User-editable template folders and arbitrary raw HTML templates are not part of
the first version.

## Warnings and diagnostics

Warnings appear above the slide preview. Common warnings include:

- Invalid metadata value
- Invalid metadata line
- Unknown template id

Content before the first separator is rendered on the title slide:

```markdown
$title = "Title Slide Example"

This text appears on the title slide.
---
$title = "First Visible Slide"

This text appears on the next slide.
```

## Complete example

```markdown
$title = "Markdown Slides in Libera"
$subtitle = "A single-file deck format"
$author = ["A. Researcher", "B. Engineer"]
$affiliation = ["Libera Lab", "Libera Lab"]
$date = "2026-06-05"
$template = "default"
---
$title = "Motivation"

Write a presentation as one Markdown file.

- Easy to edit
- Easy to version
- Uses normal Libera Markdown rendering
---
$title = "Equation Support"

Inline math works: $E = mc^2$.

Block math works too:

$$
\nabla \cdot \vec{V} = 0
$$
---
$title = "Workspace Assets"

Images and local links resolve like normal Markdown notes.

![Diagram](diagram.png)

[Open supporting note](supporting-note.md)
```

## Current limitations

The first version intentionally keeps the feature small:

- No PDF export
- No speaker notes
- No animations or fragments
- No per-slide layout metadata
- No custom user template folders
- No raw HTML template loading

These can be added later without changing the `.slides.md` file convention.
