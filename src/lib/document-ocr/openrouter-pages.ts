import { readFileSync } from "node:fs";
import type { AiReasoningEffort } from "@/lib/ai-preferences";
import { extractFigurePlaceholders, type MarkdownHeading } from "@/lib/document-ocr/markdown-pages";
import { mathMarkerSystemInstruction, type MathMarkerSettings } from "@/lib/math-markers";
import { createOpenRouterCompletion, getOpenRouterApiKey, normalizeMarkdownOutput } from "@/lib/openrouter";

// Preferences → AI → Convert PDF to Markdown. Read from the desktop config
// file on each request, like Where Was I, so a change applies without a
// restart; the environment Electron passes to the server is the fallback.

export const DEFAULT_PDF_TO_MARKDOWN_MODEL = "openai/gpt-6-luna";
const EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

export type PdfToMarkdownSettings = {
  engine: "local" | "openrouter";
  model: string;
  reasoningEffort: AiReasoningEffort;
  /** OpenRouter pages read at the same time. */
  concurrency: number;
  /** Tidy heading levels across pages once every page is in. */
  cleanup: boolean;
};

export function getPdfToMarkdownSettings(): PdfToMarkdownSettings {
  let stored: { engine?: unknown; model?: unknown; reasoningEffort?: unknown; concurrency?: unknown; cleanup?: unknown } | undefined;
  const configPath = process.env.LIBERA_CONFIG_PATH;
  if (configPath) {
    try {
      stored = (JSON.parse(readFileSync(configPath, "utf8")) as { aiFunctions?: { pdfToMarkdown?: typeof stored } }).aiFunctions?.pdfToMarkdown;
    } catch { /* Fall back to the environment. */ }
  }
  const engine = typeof stored?.engine === "string" ? stored.engine : process.env.LIBERA_PDF_TO_MARKDOWN_ENGINE;
  const model = (typeof stored?.model === "string" ? stored.model : process.env.LIBERA_AI_PDF_TO_MARKDOWN_MODEL)?.trim();
  const effort = typeof stored?.reasoningEffort === "string" ? stored.reasoningEffort : process.env.LIBERA_AI_PDF_TO_MARKDOWN_REASONING_EFFORT;
  const concurrency = Number(stored?.concurrency ?? process.env.LIBERA_PDF_TO_MARKDOWN_CONCURRENCY);
  const cleanup = typeof stored?.cleanup === "boolean" ? stored.cleanup : process.env.LIBERA_PDF_TO_MARKDOWN_CLEANUP !== "false";
  return {
    engine: engine === "openrouter" ? "openrouter" : "local",
    model: model && !/\s/.test(model) ? model : DEFAULT_PDF_TO_MARKDOWN_MODEL,
    reasoningEffort: effort && EFFORTS.has(effort) ? effort as AiReasoningEffort : "low",
    concurrency: Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 16 ? concurrency : 6,
    cleanup,
  };
}

export function openRouterPdfReadingAvailable() {
  return !!getOpenRouterApiKey();
}

function pageSystemPrompt(mathMarkers: MathMarkerSettings) {
  return [
    "You transcribe one page of a PDF into Markdown. The page is one of many; the pages are read separately and joined afterwards, so transcribe only this page.",
    "Write the page's text exactly as printed, in reading order (columns left to right). Do not summarize, translate, correct, comment or add anything.",
    "Leave out running headers, running footers, page numbers and line numbers.",
    "If the page starts in the middle of a sentence or paragraph, start with that text as it is, with no heading before it. If it ends in the middle of a sentence or a hyphenated word, end exactly there.",
    "Headings: use # levels that follow the document's structure, not the font size alone: # for the document or chapter title, ## for sections (1, 2, …), ### for subsections (1.1), #### for 1.1.1, and so on. Keep section numbers as printed.",
    "Paragraphs are separated by one blank line; join the lines of a paragraph into one line and rejoin words hyphenated at line ends.",
    "Lists as Markdown lists, code as fenced code blocks, tables as GitHub tables. If a table continues from an earlier page and this page shows no header row for it, write its rows without a header row or separator line.",
    "Footnotes: write each reference as [^PAGE-N] and each footnote at the end of the page as [^PAGE-N]: text, where PAGE is the page number you are given and N the printed footnote mark.",
    "Figures, charts and photos: write ![caption](figure:x,y,width,height), where the four numbers are the figure's box as fractions of the page width and height from the top-left corner, with two decimals, and the caption is the printed caption or a short description. Do not transcribe text inside the figure.",
    mathMarkerSystemInstruction(mathMarkers),
    "Write mathematics as LaTeX. Answer with the Markdown only, without a code fence around it.",
  ].join("\n");
}

const RETRIES = 2;

/**
 * Read one page, given as a one-page PDF (or a page image when the PDF could
 * not be split), into Markdown with figure placeholders.
 */
export async function readPageWithOpenRouter(
  page: { data: Uint8Array; contentType: string; pageNumber: number },
  { mathMarkers = {}, signal }: { mathMarkers?: MathMarkerSettings; signal?: AbortSignal } = {},
) {
  const settings = getPdfToMarkdownSettings();
  const encoded = `data:${page.contentType};base64,${Buffer.from(page.data).toString("base64")}`;
  const attachment = page.contentType === "application/pdf"
    ? { type: "file" as const, file: { filename: `page-${page.pageNumber}.pdf`, file_data: encoded } }
    : { type: "image_url" as const, image_url: { url: encoded } };

  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      const result = await createOpenRouterCompletion([
        { role: "system", content: pageSystemPrompt(mathMarkers) },
        { role: "user", content: [{ type: "text", text: `Transcribe page ${page.pageNumber}.` }, attachment] },
      ], { model: settings.model, reasoning: { effort: settings.reasoningEffort }, maxTokens: 16_000, signal });
      const markdown = normalizeMarkdownOutput(result.content.trim()).replace(/\[\^PAGE-/g, `[^${page.pageNumber}-`);
      if (!markdown.trim() && attempt < RETRIES) continue;
      return { ...extractFigurePlaceholders(markdown), incomplete: result.finishReason === "length" };
    } catch (error) {
      // Rate limits and provider hiccups are common with many pages at once.
      if (signal?.aborted || attempt >= RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1) ** 2));
    }
  }
}

const HEADINGS_PROMPT = [
  "You get the headings of one document, which was converted to Markdown one page at a time, so the levels chosen on different pages may disagree.",
  "Each line is: index, page, current level, heading text.",
  "Return JSON {\"levels\": [...]} with one integer per heading, in the same order: its correct Markdown level from 1 to 6, or 0 when it is not a real heading of the document (a running header or repeated page title, a figure or table label, a line of body text).",
  "Use the numbering (1, 1.1, 1.1.1, A, A.1, Chapter 2, Part II) and the order of the headings: the same kind of heading gets the same level everywhere. The document title, if there is one, is level 1. A level never goes more than one deeper than the heading before it.",
  "Keep a level unchanged when nothing calls for a change. Answer with the JSON only.",
].join("\n");

/** New levels for the document's headings, or null when the model's answer does not fit. */
export async function tidyHeadingLevels(headings: MarkdownHeading[], signal?: AbortSignal) {
  if (headings.length < 2) return null;
  const settings = getPdfToMarkdownSettings();
  const list = headings.map((heading, index) => `${index}\tp${heading.page}\t${heading.level}\t${heading.text.slice(0, 200)}`).join("\n");
  const result = await createOpenRouterCompletion([
    { role: "system", content: HEADINGS_PROMPT },
    { role: "user", content: list },
  ], { model: settings.model, reasoning: { effort: settings.reasoningEffort }, signal });
  try {
    const json = result.content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    const levels = (JSON.parse(json) as { levels?: unknown }).levels;
    if (!Array.isArray(levels) || levels.length !== headings.length) return null;
    return levels.every((level) => Number.isInteger(level) && level >= 0 && level <= 6) ? levels as number[] : null;
  } catch {
    return null;
  }
}
