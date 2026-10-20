/**
 * Turning Markdown (a selection, a chat reply, a PDF quote) into text a speech
 * model reads naturally, and splitting it into passages that are synthesized
 * one after another, so speech starts after the first sentence instead of
 * after the whole reply. Shared by the browser and the server.
 */

/** The most text one request to /api/tts may carry. */
export const MAX_TTS_REQUEST_CHARS = 1200;
/** Passages are packed up to about this size, at sentence ends where possible. */
const TARGET_CHUNK_CHARS = 320;
/** The first passage is kept short, so speech starts quickly. */
const FIRST_CHUNK_CHARS = 160;

/** Plain text to speak for Markdown: no markup, code, math, links' URLs or footnote marks. */
export function speechTextFromMarkdown(markdown: string) {
  let text = markdown.replace(/\r\n?/g, "\n");
  // Front matter, HTML comments and tags.
  text = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  // Fenced code and display math are announced rather than spelled out.
  text = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[^\n]*|$)/gm, "\n(code omitted)\n");
  text = text.replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]/g, " (equation) ");
  text = text.replace(/<\/?[a-zA-Z][^>\n]*>/g, " ");
  // Images keep their description; links keep their text; bare URLs are dropped.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  text = text.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "");
  text = text.replace(/\[\^[^\]]+\]/g, "");
  text = text.replace(/\bhttps?:\/\/\S+/g, "");
  // Pandoc citations such as [@key, p. 3].
  text = text.replace(/\[(?:[^\]]*@[\w:.-]+[^\]]*)\]/g, "");
  // Inline math and code: keep the content of short code, drop TeX.
  text = text.replace(/\\\((.+?)\\\)/g, " ");
  text = text.replace(/(^|[^\\$])\$(?!\s)([^$\n]+?)\$(?!\d)/g, "$1 ");
  text = text.replace(/`([^`\n]+)`/g, "$1");
  // Block markers: headings, quotes, list bullets, task boxes, tables, rules.
  text = text.replace(/^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/gm, (_, heading: string) => `${heading}${/[.!?:]$/.test(heading) ? "" : "."}`);
  text = text.replace(/^ {0,3}>\s?/gm, "");
  text = text.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "");
  text = text.replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*\|?\s*$/gm, "");
  text = text.replace(/\s*\|\s*/g, ", ");
  text = text.replace(/^\s*(?:[-*_]\s*){3,}$/gm, "");
  // Emphasis, strikethrough and highlight marks.
  text = text.replace(/(\*\*|__)(.+?)\1/g, "$2");
  text = text.replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2");
  text = text.replace(/~~(.+?)~~|==(.+?)==/g, (_, a?: string, b?: string) => a ?? b ?? "");
  // Escapes and entities.
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!|~>$])/g, "$1");
  text = text.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"");
  // Lines that end without punctuation (list items, table rows) get a pause.
  text = text.split("\n").map((line) => line.trim()).filter(Boolean)
    .map((line) => /[.!?:;,…)"'”’]$/.test(line) ? line : `${line}.`)
    .join("\n");
  return text.replace(/[ \t]+/g, " ").replace(/ +([.,;:!?])/g, "$1").trim();
}

/** Plain text to speak for LaTeX: no comments, math, references or markup commands, keeping their text. */
export function speechTextFromLatex(latex: string) {
  let text = latex.replace(/\r\n?/g, "\n");
  text = text.replace(/(^|[^\\])%.*$/gm, "$1");
  // Display math and verbatim are announced; figures, tables and code environments are skipped.
  text = text.replace(/\\begin\{(equation|align|gather|multline|eqnarray|displaymath)\*?\}[\s\S]*?\\end\{\1\*?\}/g, " (equation) ");
  text = text.replace(/\\begin\{(verbatim|lstlisting|minted|tikzpicture|tabular|tabularx)\*?\}[\s\S]*?\\end\{\1\*?\}/g, " ");
  text = text.replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]/g, " (equation) ");
  text = text.replace(/\\\((.+?)\\\)|(^|[^\\])\$[^$\n]+\$/g, "$2 ");
  // References and bookkeeping commands disappear with their arguments.
  text = text.replace(/~?\\(?:cite[a-zA-Z]*|ref|eqref|autoref|cref|Cref|pageref|label|includegraphics|bibliography|bibliographystyle|usepackage|documentclass|input|include|hspace|vspace|newcommand|renewcommand)\*?(?:\[[^\]]*\])*(?:\{[^{}]*\})*/g, "");
  text = text.replace(/\\(?:begin|end)\{[^}]*\}(?:\[[^\]]*\])?/g, "\n\n");
  // Sectioning ends with a pause; markup commands keep their text.
  text = text.replace(/\\(?:part|chapter|section|subsection|subsubsection|paragraph|caption)\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g, "\n\n$1.\n\n");
  for (let pass = 0; pass < 3; pass += 1) text = text.replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g, "$1");
  text = text.replace(/\\item\b(?:\[[^\]]*\])?/g, "\n\n");
  text = text.replace(/\\\\|\\(?:newline|par)\b/g, "\n\n");
  text = text.replace(/\\[a-zA-Z]+\*?/g, " ");
  text = text.replace(/\\([&%$#_{}])/g, "$1").replace(/[{}]/g, "").replace(/~/g, " ").replace(/``|''/g, "\"");
  // Source lines wrap within a paragraph; only blank lines (and the breaks above) end one.
  const paragraphs = text.split(/\n[ \t]*\n/).map((paragraph) => paragraph.replace(/\s+/g, " ").trim()).filter(Boolean);
  return speechTextFromPlain(paragraphs.join("\n"));
}

/** Plain text, code included: only whitespace is tidied, and lines become pauses. */
export function speechTextFromPlain(text: string) {
  return text.replace(/\r\n?/g, "\n").split(/\n/).map((line) => line.replace(/[ \t]+/g, " ").trim()).filter(Boolean)
    .map((line) => /[.!?:;,…)"'”’]$/.test(line) ? line : `${line}.`)
    .join("\n");
}

export type SpeechFormat = "markdown" | "latex" | "plain";

/** Text to speak, by what the source is written in. */
export function speechText(source: string, format: SpeechFormat = "markdown") {
  return format === "latex" ? speechTextFromLatex(source) : format === "plain" ? speechTextFromPlain(source) : speechTextFromMarkdown(source);
}

/** Sentences, keeping their closing punctuation and any quote after it. */
function sentences(paragraph: string) {
  const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "sentence" })
    : null;
  if (segmenter) return Array.from(segmenter.segment(paragraph), (part) => part.segment.trim()).filter(Boolean);
  return paragraph.match(/[^.!?。！？]+(?:[.!?。！？]+["'”’)]*|$)/g)?.map((part) => part.trim()).filter(Boolean) ?? [paragraph];
}

/** A sentence longer than a request, split at commas and then at spaces. */
function splitLong(sentence: string, limit: number): string[] {
  if (sentence.length <= limit) return [sentence];
  const parts: string[] = [];
  let rest = sentence;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
    const at = cut > limit / 3 ? cut + 1 : window.lastIndexOf(" ") > limit / 3 ? window.lastIndexOf(" ") : limit;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Passages to synthesize in order: whole sentences packed together, never
 * across paragraphs, the first one short so playback starts quickly.
 */
export function speechChunks(text: string, target = TARGET_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  for (const paragraph of text.split(/\n+/).map((line) => line.trim()).filter(Boolean)) {
    let current = "";
    for (const sentence of sentences(paragraph).flatMap((part) => splitLong(part, MAX_TTS_REQUEST_CHARS))) {
      const limit = chunks.length ? target : FIRST_CHUNK_CHARS;
      if (current && current.length + 1 + sentence.length > limit) {
        chunks.push(current);
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
    }
    if (current) chunks.push(current);
  }
  return chunks;
}
