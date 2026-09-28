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

export function formatDocumentContext(context: AiDocumentContext, marked: string) {
  return `<document>
${context.before}${marked}${context.after}
</document>`;
}
