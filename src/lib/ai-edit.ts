import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAiFunctionOptions, getAiRewriteCustomInstruction } from "@/lib/ai-preferences";
import { AI_EDIT_THREAD_RULES, formatDocumentContext, INSERTION_MARKER, MAX_AI_EDIT_TURNS, readDocumentContext, SELECTION_END_MARKER, SELECTION_START_MARKER, type AiDocumentContext } from "@/lib/ai-document-context";
import { createOpenRouterCompletion, normalizeMarkdownOutput, type OpenRouterMessage } from "@/lib/openrouter";
import { latexEditPrompt, normalizeLatexOutput } from "@/lib/latex/ai-prompts";
import type { TokenUsage } from "@/lib/chat-token-usage";

/**
 * AI Rewrite and Write with AI share one system prompt so a run of requests
 * on one document can continue as one cached thread:
 *
 *   system     instructions for both actions (stable across documents)
 *   user 1     the whole document with the spot marked, and the request
 *   assistant  the result
 *   user n     only the current text around the spot, and the request
 *
 * The client keeps the turns exactly as the server built them and sends them
 * back, so every follow-up repeats a byte-identical prefix the provider can
 * read from its cache. The document is sent once; later turns stay short.
 */
export type AiEditAction = "rewrite" | "write";
export type AiEditTurn = { user: string; assistant: string };
export type AiEditThreadResult = { id: string; caching: boolean; turn: AiEditTurn; usage?: TokenUsage };

const MAX_THREAD_LENGTH = 600_000;
/** Characters of current text shown on each side of the spot in follow-up turns. */
const EXCERPT_RADIUS = 1_500;

export class AiEditRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** A thread from a request body. `turns` is empty for a new thread. */
function readThread(value: unknown): { id: string; turns: AiEditTurn[] } | undefined {
  if (value === undefined) return undefined;
  const thread = value as { id?: unknown; turns?: unknown } | null;
  if (typeof thread?.id !== "string" || !/^[\w-]{8,64}$/.test(thread.id) || !Array.isArray(thread.turns)) throw new AiEditRequestError("Invalid AI thread.", 400);
  const turns = thread.turns as unknown[];
  if (turns.length > MAX_AI_EDIT_TURNS) throw new AiEditRequestError("The AI thread is too long. Start a new one.", 413);
  let length = 0;
  for (const turn of turns) {
    const { user, assistant } = (turn ?? {}) as { user?: unknown; assistant?: unknown };
    if (typeof user !== "string" || typeof assistant !== "string") throw new AiEditRequestError("Invalid AI thread.", 400);
    length += user.length + assistant.length;
  }
  if (length > MAX_THREAD_LENGTH) throw new AiEditRequestError("The AI thread is too long. Start a new one.", 413);
  return { id: thread.id, turns: turns as AiEditTurn[] };
}

async function markdownEditPrompt(customInstruction: string) {
  const formatterPrompt = await readFile(path.join(process.cwd(), "prompts", "system_prompt_ai_formatter.md"), "utf8");
  return `${formatterPrompt}

Editing mode override:

Each request is either an AI Rewrite or a Write with AI request.

AI Rewrite:

* Rewrite the selected Markdown according to the user's rewrite instruction.
* The rewrite instruction may change wording, length, tone, structure, or emphasis.
* The rules above that say to preserve original content exactly and not rewrite are overridden only as needed to satisfy the user's rewrite instruction.
* When the document is provided, the selected Markdown is the part between ${SELECTION_START_MARKER} and ${SELECTION_END_MARKER}. Use the rest of the document only as context (topic, tone, terminology, notation, heading levels, what comes before and after) and return only the replacement for the selected part, without the markers.

Write with AI:

* Write new Markdown content according to the user's instruction. It will be inserted into the user's document at the marked insertion point.
* The rules above about preserving the original text and not inventing content do not apply: you are writing new content, not formatting existing text.
* When the document is provided, the new content goes at ${INSERTION_MARKER}. Use the document only as context: match its topic, tone, language, terminology, heading levels, and notation, and make the new content fit between what comes before and after the marker. Do not repeat the surrounding content unless the instruction asks for it, and do not output the marker.

For both:

* Keep all output-format rules from the formatter prompt: return only Markdown content, no explanations, no introductions, no closing remarks, and no code fences around the whole response.
* Preserve Markdown validity and keep links, images, math delimiters, tables, and code syntax correct unless the instruction explicitly asks to change them.
${AI_EDIT_THREAD_RULES}${customInstruction ? `

User-configured custom instructions for every AI Rewrite and Write with AI request:
${customInstruction}` : ""}`;
}

/** Current text on either side of the spot, cut at line breaks where possible. */
function excerpt(context: AiDocumentContext, marked: string) {
  let before = context.before.slice(-EXCERPT_RADIUS);
  let after = context.after.slice(0, EXCERPT_RADIUS);
  if (before.length < context.before.length) before = before.slice(Math.max(0, before.indexOf("\n") + 1));
  if (after.length < context.after.length) after = after.slice(0, Math.max(after.lastIndexOf("\n"), 0)) || after;
  return `<excerpt>
${before}${marked}${after}
</excerpt>`;
}

function userMessage(action: AiEditAction, language: string, prompt: string, text: string, context: AiDocumentContext | null, followUp: boolean) {
  const marked = action === "rewrite" ? `${SELECTION_START_MARKER}${text}${SELECTION_END_MARKER}` : INSERTION_MARKER;
  const spot = action === "rewrite" ? `the selected ${language} marked` : "the insertion point marked";
  const location = !context ? ""
    : followUp ? `Current text around the spot, with ${spot}:\n${excerpt(context, marked)}\n\n`
    : `Full document, with ${spot}:\n${formatDocumentContext(context, marked)}\n\n`;
  return action === "rewrite"
    ? `${location}Rewrite instruction:\n${prompt}\n\nSelected ${language}:\n${text}`
    : `${location}${followUp ? "Write with AI instruction" : "Instruction"}:\n${prompt}`;
}

export async function runAiEdit(action: AiEditAction, body: { prompt?: string; text?: string; before?: string; after?: string; format?: string; thread?: unknown }) {
  const latex = body.format === "latex";
  const language = latex ? "LaTeX" : "Markdown";
  const thread = readThread(body.thread);
  const options = getAiFunctionOptions(action);
  // Without prompt caching a thread only resends history at full price.
  const turns = options.promptCaching ? thread?.turns ?? [] : [];
  const customInstruction = getAiRewriteCustomInstruction().trim();
  const user = userMessage(action, language, body.prompt?.trim() ?? "", body.text ?? "", readDocumentContext(body), turns.length > 0);
  const messages: OpenRouterMessage[] = [
    { role: "system", content: latex ? latexEditPrompt(customInstruction) : await markdownEditPrompt(customInstruction) },
    ...turns.flatMap((turn) => [{ role: "user" as const, content: turn.user }, { role: "assistant" as const, content: turn.assistant }]),
    { role: "user", content: user },
  ];
  const sessionId = options.promptCaching ? thread?.id : undefined;
  const result = await createOpenRouterCompletion(messages, { ...options, ...(sessionId ? { sessionId } : {}) });
  // One line per request, like document chat, so a thread's cache reads are visible.
  const cached = result.usage?.cachedTokens;
  console.info(`[ai-edit] action=${action} model=${options.model} thread=${sessionId?.slice(0, 8) ?? "-"} turn=${turns.length + 1} provider=${result.generation?.provider ?? "unknown"} input=${result.usage?.inputTokens ?? "?"} cached=${cached ?? "unreported"}`);
  const output = latex ? normalizeLatexOutput(result.content) : normalizeMarkdownOutput(result.content);
  const threadResult: AiEditThreadResult | undefined = thread
    ? { id: thread.id, caching: options.promptCaching, turn: { user, assistant: output }, ...(result.usage ? { usage: result.usage } : {}) }
    : undefined;
  return { output, thread: threadResult };
}
