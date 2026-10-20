import type { AgentSkill } from "../tools";
import { finishLiveBlocks, LIVE_BLOCKS_CHECK, LIVE_BLOCKS_GUIDE } from "./live-blocks";

// Making and editing Markdown Slides decks (*.slides.md): the format, layouts,
// columns, builds and notes, and the three live blocks (charts, Mermaid
// diagrams, live HTML; shared with visualization-interactivity-in-markdown in
// live-blocks.ts). The agent writes decks with Edit and Write; its finish pass
// sends back the deck's warnings and broken ```chart blocks to fix.

export const SLIDE_DECK_SKILL = "slide-deck";

const instructions = `
# Making and editing slide decks

A Libera slide deck is one Markdown file named \`*.slides.md\`. It opens in the source editor with the slides beside it; each slide is laid out on a fixed 16:9 canvas (540 pixels high) and scaled to fit, so the preview, the presentation and the PDF match. You write decks with Edit and Write like any note. You cannot see the slides, so keep each one simple enough to fit, and rely on the check described at the end.

## How to work

1. Editing a deck: Read the whole file first. Keep its settings, theme, title style and the way it writes slides; change only what the user asked for.
2. New deck: Write a file named \`<Name>.slides.md\` in the current notebook (a name without \`.slides.md\` is a normal note, not a deck). Turning a note or document into a deck: Read it, then write a new deck next to it unless the user asks you to replace it.
3. Plan the talk before writing: a title slide, then one idea per slide, with section dividers for a long deck. Put detail in speaker notes, not on the slide.
4. Choose the visual for each idea: bullets, a table, an image, a chart for numbers, a Mermaid diagram for a process, structure or timeline, live HTML only for something interactive.
5. After writing, tell the user what the deck contains and that they can present it with **Present slides** or check it in the preview beside the source.

## Structure

\`\`\`markdown
$title = Results from the field
$subtitle = Spring survey
$author = ["Ada Lovelace", "Grace Hopper"]
$date = October 2026
$theme = light
---
## What we measured

- Response time
- Error rate

--

- This bullet appears on the next click

???
Speaker notes: only the presenter sees these.
---
$layout = section
## Part 2: Results
\`\`\`

- A line with only \`---\` starts a new slide. The block above the first \`---\` holds the deck settings and becomes the title slide (from $title, $subtitle, $author, $affiliation, $date).
- A slide's leading \`#\` or \`##\` heading is its title. Use \`##\`, one per slide. Do not add a second heading of the same level as a title.
- \`$key = value\` lines go at the very top of a block, or right under the title heading. Values are plain text (\`$theme = night\`) or JSON (\`"text"\`, \`21\`, \`true\`, \`["a", "b"]\`).
- \`--\` on its own line, after a blank line, is a build step: what follows appears on the next click.
- \`|||\` on its own line starts a new column (see Columns).
- \`???\` on its own line starts the speaker notes: the rest of that slide. Never on the slide or in the PDF.
- \`<!-- … -->\` comments out text, even whole slides. Markers inside code fences are ignored.
- Never put \`---\` in a slide for a horizontal rule: it starts a new slide.

## Settings

Deck (in the first block): \`$theme\` (light, dark, paper, night), \`$accent\` (a CSS color), \`$aspect\` (16:9, 16:10, 4:3), \`$fontsize\` (body text in canvas pixels, 21 by default), \`$footer\` (text, or false), \`$paginate\` (false hides slide numbers), \`$transition\` (fade, slide, none), \`$fit\` (false turns off shrink-to-fit).

Slide: \`$title\`, \`$layout\`, \`$columns\`, \`$fontsize\`, \`$background\` (a CSS color), \`$fit\`, \`$hidden = true\` (kept in the file, left out of the presentation and the PDF: for backup slides).

## Layouts

Choose with \`$layout\` at the top of the slide:

- \`default\`: title at the top, body centered vertically below it. Most slides.
- \`top\`: body starts right under the title. Dense slides, tables, code.
- \`center\`: everything centered. A statement, a quote, one big number ("**42%** of users…").
- \`section\`: a divider with a large title; any body is a muted subtitle.
- \`blank\`: no header, footer or padding; an image alone fills the slide. Full-bleed photos.

Keynote-style recipes: title + bullets = default; bullets beside a photo or diagram = two columns; three or four ideas side by side = three or four columns, each with a \`###\` heading and a line or two; agenda = a numbered list on a \`top\` slide; quote or big fact = \`center\`; chapter break = \`section\`; photo = \`blank\`.

## Columns

\`\`\`markdown
---
$columns = [2, 3]
## Bullets beside a diagram

- Point one
- Point two

|||

![Workflow](images/workflow.png)
\`\`\`

Any number of columns; equal widths unless \`$columns\` lists relative widths. Charts, diagrams and live HTML take their column's width. A build step before \`|||\` makes the next column appear on a click.

## Fitting

There is no scrolling. A slide with too much content shrinks to fit, down to about half size, and then is flagged as overfull. Keep slides short: about six bullets of one line, or a table of up to about seven rows. Split long content over several slides, or use \`$layout = top\` with a smaller \`$fontsize\`. Prefer real slides to tiny text.

## Content

Slides render Markdown as notes do: lists, tables, links, code, math with the notebook's markers, Libera's highlights and colored boxes, and images relative to the deck (\`![Alt](images/photo.png)\`). An image alone in a paragraph is centered. Citations work as in notes ([@key], keys from the notebook's References only, never invented); they are numbered across the deck, and \`:::bibliography\` on a slide places the reference list.

${LIVE_BLOCKS_GUIDE}
## Live blocks on slides

- Under a slide title there is room for a chart about 220–280 pixels high; set \`height\` to fit.
- A wide slide suits \`flowchart LR\`; a diagram in a narrow column suits \`flowchart TD\`. A diagram is never taller than the slide body; a tall one shrinks on its own.
- Charts, diagrams and live HTML take the width of their column.
- In the presentation, keys pressed inside live HTML still move the slides, unless focus is in a text field.
${LIVE_BLOCKS_CHECK}`;

export const slideDeckSkill: AgentSkill = {
  name: SLIDE_DECK_SKILL,
  description: "Make or edit a Markdown Slides deck (*.slides.md): the slide syntax, settings, layouts, columns, build steps, speaker notes, and charts, Mermaid diagrams and interactive HTML on slides. Use when the user asks for a presentation, slides or a deck, to turn a note or document into slides, or to change, restyle or add to a .slides.md file.",
  instructions,
  finishPass: finishLiveBlocks,
};
