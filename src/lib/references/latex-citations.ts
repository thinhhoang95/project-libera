import { randomInt } from "node:crypto";
import type { ElementContent } from "hast";
import { bibliographyItems, isLabelledBibliography, loadNotebookStyle } from "@/lib/references/bibliography-export";
import { citedKeys, scanCitations } from "@/lib/references/citation-syntax";
import { citationEntriesForDocument, formatCitationDocument, loadCitationFormatter, sanitizeCitationHtml } from "@/lib/references/format";
import { encodeLatex } from "@/lib/references/latex-text";
import { emptyReferenceLibrary } from "@/lib/references/library-ops";
import type { ReferenceLibrary } from "@/lib/references/types";
import { readReferenceLibrary } from "@/lib/storage/references";

// Citations in the LLM-driven Markdown → LaTeX export (docs/references/plan.md
// §4.6, phase 2). Before chunking, each citation token is formatted with the
// notebook's library and style and replaced by an opaque placeholder: capital
// letters only, so it is one word that latex-chunks.ts never splits (it
// splits paragraphs only at whitespace) and that needs no escaping. A
// `:::bibliography` marker gets a placeholder too. The model is told to copy
// placeholders verbatim; after each chunk is converted, they are replaced by
// the formatted citations as LaTeX. A placeholder the model dropped or altered
// makes the chunk be asked for again, and on the last attempt the citation is
// inserted at the end of the block it was in, so no citation is ever lost.
// The bibliography is appended after the last chunk (or put at the marker):
// `thebibliography` for numeric styles, otherwise a starred References
// section with one paragraph per entry.

export type LatexCitationPlan = {
  /** The Markdown with placeholders in place of citations (and of the bibliography marker). */
  markdown: string;
  /** Placeholder → LaTeX for the citation. */
  citations: Map<string, string>;
  /** The bibliography marker's placeholder, when the document has one. */
  bibliographyPlaceholder: string | null;
  /** The References section as LaTeX; empty when nothing resolved. */
  bibliography: string;
  /** Matches any placeholder of this export. */
  pattern: RegExp;
  /** The random letters every placeholder of this export contains. */
  nonce: string;
};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const INDEX_LETTERS = 4;
const MAX_CITATIONS = LETTERS.length ** INDEX_LETTERS;
const BIBLIOGRAPHY_MARKER = /^:::bibliography[ \t]*\r?\n[ \t]*:::[ \t]*$/m;

function randomLetters(count: number) {
  return Array.from({ length: count }, () => LETTERS[randomInt(LETTERS.length)]).join("");
}

function indexLetters(index: number) {
  let text = "";
  for (let value = index, digit = 0; digit < INDEX_LETTERS; digit += 1, value = Math.floor(value / LETTERS.length)) {
    text = LETTERS[value % LETTERS.length] + text;
  }
  return text;
}

/** Text for LaTeX: encodeLatex for the prose, and the characters it leaves alone (math, angle brackets, bars) escaped too. */
export function escapeLatexText(text: string) {
  return text.split(/([$<>|])/).map((part) => {
    switch (part) {
      case "$": return "\\$";
      case "<": return "\\textless{}";
      case ">": return "\\textgreater{}";
      case "|": return "\\textbar{}";
      default: return part ? encodeLatex(part.replace(/\s+/g, " "), "bibtex") : "";
    }
  }).join("");
}

/** Sanitized citeproc nodes → LaTeX: italics as \emph, bold, super- and subscripts, small caps; other markup unwrapped. */
export function nodesToLatex(nodes: ElementContent[]): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") output += escapeLatexText(node.value);
    else if (node.type === "element") {
      const inner = nodesToLatex(node.children);
      if (!inner) continue;
      switch (node.tagName) {
        case "i": case "em": output += `\\emph{${inner}}`; break;
        case "b": case "strong": output += `\\textbf{${inner}}`; break;
        case "sup": output += `\\textsuperscript{${inner}}`; break;
        case "sub": output += `\\textsubscript{${inner}}`; break;
        case "span": output += node.properties.style ? `\\textsc{${inner}}` : inner; break;
        default: output += inner;
      }
    }
  }
  return output;
}

/** Formatted citation HTML (sanitized by format.ts) → LaTeX. */
export function citationHtmlToLatex(html: string) {
  return nodesToLatex(sanitizeCitationHtml(html).children as ElementContent[]).trim();
}

/** The bibliography as LaTeX: thebibliography for numeric styles, a References section otherwise. */
export function bibliographyHtmlToLatex(html: string) {
  const items = bibliographyItems(html);
  if (!items.length) return "";
  if (isLabelledBibliography(items)) {
    const widest = String(items.length).replace(/\d/g, "9");
    const entries = items.map((item, index) => `\\bibitem{libera-ref-${index + 1}} ${nodesToLatex(item.body).trim()}`);
    return `\\begin{thebibliography}{${widest}}\n${entries.join("\n\n")}\n\\end{thebibliography}`;
  }
  const hanging = /\bcsl-hanging-indent\b/.test(html);
  const prefix = hanging ? "\\noindent\\hangindent=2em\\hangafter=1 " : "\\noindent ";
  const entries = items.map((item) => `${prefix}${nodesToLatex(item.body).trim()}\\par`);
  return `\\section*{References}\n\n${entries.join("\n\n")}`;
}

/** The notebook of a library-relative document path ("Notebook/dir/file.md"), or null. */
export function notebookOfDocument(documentPath: string) {
  const notebook = documentPath.split("/")[0]?.trim();
  return notebook || null;
}

async function libraryFor(notebook: string | null): Promise<ReferenceLibrary> {
  if (!notebook) return emptyReferenceLibrary();
  return readReferenceLibrary(notebook);
}

/**
 * Format a document's citations and replace them with placeholders. null
 * when the document has no citations: the export then runs exactly as
 * before. Without a notebook, citations are kept as their source text.
 */
export async function prepareLatexCitations(markdown: string, notebook: string | null): Promise<LatexCitationPlan | null> {
  const occurrences = scanCitations(markdown);
  if (!occurrences.length) return null;
  if (occurrences.length > MAX_CITATIONS) throw new Error(`The document has more than ${MAX_CITATIONS.toLocaleString("en-US")} citations.`);

  const library = await libraryFor(notebook);
  const [style] = await Promise.all([loadNotebookStyle(notebook ?? "", library.style), loadCitationFormatter()]);
  const formatted = formatCitationDocument({
    citations: occurrences.map((occurrence) => occurrence.citation),
    entries: citationEntriesForDocument(library, citedKeys(markdown)),
    style,
    format: "html",
  });

  // A nonce the document does not contain keeps placeholders apart from its own text.
  let nonce = randomLetters(6);
  while (markdown.includes(nonce)) nonce = randomLetters(6);
  const citations = new Map<string, string>();
  let output = "";
  let last = 0;
  occurrences.forEach((occurrence, index) => {
    const placeholder = `ZCITE${nonce}${indexLetters(index)}Z`;
    const latex = citationHtmlToLatex(formatted.citations[index]);
    // "[1]" right after \item or \\ would be read as an optional argument.
    citations.set(placeholder, latex.startsWith("[") ? `{${latex}}` : latex);
    output += markdown.slice(last, occurrence.start) + placeholder;
    last = occurrence.end;
  });
  output += markdown.slice(last);

  let bibliographyPlaceholder: string | null = null;
  if (BIBLIOGRAPHY_MARKER.test(output)) {
    bibliographyPlaceholder = `ZREFS${nonce}Z`;
    output = output.replace(BIBLIOGRAPHY_MARKER, bibliographyPlaceholder);
  }
  return {
    markdown: output,
    citations,
    bibliographyPlaceholder,
    bibliography: bibliographyHtmlToLatex(formatted.bibliography),
    pattern: new RegExp(`Z(?:CITE${nonce}[A-Z]{${INDEX_LETTERS}}|REFS${nonce})Z`, "g"),
    nonce,
  };
}

/** The instruction added to the export prompt when a document has citations. */
export const LATEX_CITATION_PROMPT = "Tokens of capital letters that start with ZCITE or ZREFS are citation and bibliography placeholders that Libera replaces after conversion. Copy every placeholder exactly as written, letter for letter, at the same place in the text: never translate, escape, split, reformat, wrap in a command or drop one. Do not add citations, \\cite commands or a bibliography of your own.";

/** Placeholders in a block's Markdown, in order. */
function placeholdersIn(text: string, plan: LatexCitationPlan) {
  return [...text.matchAll(plan.pattern)].map((match) => match[0]);
}

function replacement(placeholder: string, plan: LatexCitationPlan) {
  if (placeholder === plan.bibliographyPlaceholder) return plan.bibliography;
  return plan.citations.get(placeholder) ?? "";
}

export type RestoredLatexChunk = { body: string; missing: string[] };

/**
 * Replace the placeholders of a converted chunk with their LaTeX. `missing`
 * lists the placeholders of `blocks` the model's output lacks. With
 * `recover`, each missing citation is inserted at the end of its block
 * (before the block's end comment, or at the end of the chunk when the
 * comments are gone) instead of being reported only.
 */
export function restoreLatexCitations(
  body: string,
  blocks: { id: number; markdown: string }[],
  plan: LatexCitationPlan,
  { recover }: { recover: boolean },
): RestoredLatexChunk {
  // A placeholder whose case the model changed is still the placeholder.
  const upper = body.toUpperCase();
  const missing: { placeholder: string; block: number }[] = [];
  for (const block of blocks) {
    for (const placeholder of placeholdersIn(block.markdown, plan)) {
      if (!upper.includes(placeholder)) missing.push({ placeholder, block: block.id });
    }
  }
  if (missing.length && !recover) return { body, missing: missing.map((item) => item.placeholder) };

  let restored = body;
  if (missing.length) {
    const byBlock = new Map<number, string[]>();
    for (const { placeholder, block } of missing) byBlock.set(block, [...byBlock.get(block) ?? [], placeholder]);
    for (const [block, placeholders] of byBlock) {
      const insertion = placeholders.map((placeholder) => placeholder === plan.bibliographyPlaceholder ? `\n\n${placeholder}\n` : ` ${placeholder}`).join("");
      const marker = restored.search(new RegExp(`^[ \\t]*% LIBERA_BLOCK_${block}_END\\b`, "m"));
      // At the end of the block's content, before the blank lines and its end comment.
      let at = marker >= 0 ? marker : restored.length;
      while (at > 0 && /\s/.test(restored[at - 1])) at -= 1;
      restored = restored.slice(0, at) + insertion + restored.slice(at);
    }
  }
  // Function replacements: LaTeX is full of `$` and backslashes.
  restored = restored.replace(new RegExp(plan.pattern.source, "gi"), (placeholder) => replacement(placeholder.toUpperCase(), plan));
  // What is left of an altered placeholder (split, misspelt) is noise; its citation was put back above.
  restored = restored.replace(new RegExp(`[A-Za-z]*${plan.nonce}[A-Za-z]*`, "gi"), "");
  return { body: restored, missing: missing.map((item) => item.placeholder) };
}

/** The message that asks the model to redo a chunk that lost placeholders. */
export function missingPlaceholdersMessage(missing: string[]) {
  return `These citation placeholders are missing or were altered: ${missing.join(", ")}. Copy every placeholder from the blocks exactly, letter for letter, where it appears.`;
}
