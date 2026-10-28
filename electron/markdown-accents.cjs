// The heading accent saved before editor themes (editor-themes.cjs), which
// migrates it to the visual editor's theme: each name became a built-in theme,
// "custom" a theme of the user's own, and "none" the Plain theme. Bold lead-ins
// are still a preference of their own.
const MARKDOWN_HEADING_COLORS = ["none", "blue", "indigo", "teal", "green", "purple", "rose", "orange", "spectrum", "custom"];
const DEFAULT_MARKDOWN_HEADING_COLOR = "blue";

// The custom palette: H1–H4, H5 and smaller, and list markers with bold
// lead-ins. Starts as the Spectrum colors.
const DEFAULT_MARKDOWN_HEADING_PALETTE = Object.freeze({
  h1: "#4338ca", h2: "#1d4ed8", h3: "#0f766e", h4: "#15803d", h5: "#475569", lists: "#1d4ed8",
});

function normalizeMarkdownHeadingColor(value) {
  return MARKDOWN_HEADING_COLORS.includes(value) ? value : DEFAULT_MARKDOWN_HEADING_COLOR;
}

// Accepts the palette object or, from the environment, its JSON.
function normalizeMarkdownHeadingPalette(value) {
  let input = value;
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { input = null; }
  }
  const palette = {};
  for (const [key, fallback] of Object.entries(DEFAULT_MARKDOWN_HEADING_PALETTE)) {
    const color = input && typeof input === "object" ? input[key] : undefined;
    palette[key] = typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : fallback;
  }
  return palette;
}

// Bold text that opens a paragraph or list item takes the heading color too.
// On unless turned off; the environment passes it as "1" or "0".
function normalizeMarkdownBoldLeadIns(value) {
  return value !== false && value !== "0" && value !== "false";
}

module.exports = {
  MARKDOWN_HEADING_COLORS,
  DEFAULT_MARKDOWN_HEADING_COLOR,
  DEFAULT_MARKDOWN_HEADING_PALETTE,
  normalizeMarkdownHeadingColor,
  normalizeMarkdownHeadingPalette,
  normalizeMarkdownBoldLeadIns,
};
