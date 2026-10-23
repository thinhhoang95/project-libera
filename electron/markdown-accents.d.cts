export type MarkdownHeadingColor = "none" | "blue" | "indigo" | "teal" | "green" | "purple" | "rose" | "orange" | "spectrum" | "custom";
export type MarkdownHeadingPalette = { h1: string; h2: string; h3: string; h4: string; h5: string; lists: string };
export const MARKDOWN_HEADING_COLORS: readonly MarkdownHeadingColor[];
export const DEFAULT_MARKDOWN_HEADING_COLOR: MarkdownHeadingColor;
export const DEFAULT_MARKDOWN_HEADING_PALETTE: Readonly<MarkdownHeadingPalette>;
export function normalizeMarkdownHeadingColor(value: unknown): MarkdownHeadingColor;
export function normalizeMarkdownHeadingPalette(value: unknown): MarkdownHeadingPalette;
export function normalizeMarkdownBoldLeadIns(value: unknown): boolean;
