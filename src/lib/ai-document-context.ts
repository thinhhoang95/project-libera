/** The whole-document context optionally sent with AI Rewrite and Write with AI.
 * `before` and `after` are the Markdown on either side of the selection or
 * insertion point; the prompt marks that spot so the model knows where it is. */
export type AiDocumentContext = { before: string; after: string };

export const MAX_DOCUMENT_CONTEXT_LENGTH = 200_000;
export const INSERTION_MARKER = "<<INSERT HERE>>";
export const SELECTION_START_MARKER = "<<SELECTION START>>";
export const SELECTION_END_MARKER = "<<SELECTION END>>";

/** Read the optional context from a request body, keeping the text nearest the
 * marked spot when the document exceeds the limit. */
export function readDocumentContext(body: { before?: unknown; after?: unknown }, limit = MAX_DOCUMENT_CONTEXT_LENGTH): AiDocumentContext | null {
  if (typeof body.before !== "string" || typeof body.after !== "string") return null;
  if (!body.before.trim() && !body.after.trim()) return null;
  const after = body.after.slice(0, Math.max(limit - body.before.length, Math.floor(limit / 4)));
  const before = body.before.slice(Math.max(0, body.before.length - (limit - after.length)));
  return { before, after };
}

/** Longest AI Rewrite / Write with AI thread before a request starts a new one. */
export const MAX_AI_EDIT_TURNS = 20;

/** How a cached AI Rewrite / Write with AI thread shares the document (see src/lib/ai-edit.ts). */
export const AI_EDIT_THREAD_RULES = `* Several requests on the same document may follow one another in this conversation. The document is shared once, with the first request. It changes afterwards: your earlier results may have been applied, and the user may have edited it. Later requests therefore show only the current text around the selection or insertion point; trust it over the earlier copy of the document. Answer only the latest request.`;

export function formatDocumentContext(context: AiDocumentContext, marked: string) {
  return `<document>
${context.before}${marked}${context.after}
</document>`;
}
