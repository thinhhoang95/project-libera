/** Marks a copy as Libera's own Markdown. Chromium keeps custom types for pastes
 * within the app, so the LaTeX editor can convert a short copy its text-only
 * detection would leave raw. Its own module: the LaTeX editor reads it without
 * loading the Markdown editor's schema (markdown-clipboard.ts). */
export const LIBERA_MARKDOWN_MIME = "application/x-libera-markdown";
