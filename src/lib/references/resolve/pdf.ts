import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractIdentifiers, normalizeDoi } from "../identifiers";
import { parseName } from "../names";
import { normalizeEntryInput } from "../normalize";
import type { CslItem, CslName, FieldProvenance, ReferenceAttachment, ReferenceEntryInput } from "../types";
import { extractionToInput, extractPdfFields, lookupWithWeb, type LlmExtraction } from "./llm";
import { lookupArxiv, lookupDoi, onlineAllowed, searchBibliographic, type ResolveEnvironment } from "./lookup";
import { titleSimilarityInText, TITLE_IN_TEXT_THRESHOLD } from "./match";
import { combineInputs, compactInput, fillFieldProvenance } from "./record";
import { isAbortError } from "./http";

// PDF resolution (docs/references/plan.md §4.4 step 3). Inputs: the text of
// pages 1–2 from the shared PDF text cache and the document metadata (Info
// dictionary and XMP). An identifier is accepted only when the resolved
// title is printed on the first pages; otherwise it belongs to a cited work
// and the next identifier is tried. Without one, the model (or, with AI off,
// the metadata and first lines) gives title, authors and year, which are
// searched in Crossref and OpenAlex and scored in match.ts.

export type PdfDocumentMetadata = {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  /** DOIs named in XMP, Subject or Keywords, in that order. */
  dois: string[];
};

export type PdfPages = { pages: { pageNumber: number; text: string }[] };

export type PdfResolveDeps = {
  /** Text pages of a library-relative PDF (defaults to readPdfTextCache). */
  readText?: (relativePath: string) => Promise<PdfPages>;
  /** Document metadata of a library-relative PDF (defaults to pdf.js). */
  readMetadata?: (relativePath: string) => Promise<PdfDocumentMetadata>;
};

export type PdfResolution = {
  candidate: ReferenceEntryInput;
  /** How the candidate was found. */
  method: "identifier" | "search" | "web" | "extracted" | "no-text-layer";
};

/** Fewer visible characters than this on pages 1–2 means there is no text layer. */
const MIN_TEXT_CHARS = 40;
const MAX_IDENTIFIERS_TRIED = 6;
const PDF_TEXT_CONFIDENCE = 0.3;
const PDF_METADATA_CONFIDENCE = 0.4;
const FILE_NAME_CONFIDENCE = 0.2;

// Resolve pdfjs-dist from the running server bundle, as pdf-text-cache does.
const nodeRequire = eval("require") as NodeRequire;

/** pdf.js document metadata: Title, Author, Subject, Keywords and DOIs in XMP, Subject or Keywords. */
export async function readPdfDocumentMetadata(absolutePath: string): Promise<PdfDocumentMetadata> {
  const pdfjsPath = path.dirname(nodeRequire.resolve("pdfjs-dist/package.json"));
  const { GlobalWorkerOptions, VerbosityLevel, getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(pdfjsPath, "legacy", "build", "pdf.worker.mjs")).toString();
  const document = await getDocument({
    data: new Uint8Array(await readFile(absolutePath)),
    disableFontFace: true,
    standardFontDataUrl: pathToFileURL(`${path.join(pdfjsPath, "standard_fonts")}${path.sep}`).toString(),
    verbosity: VerbosityLevel.ERRORS,
  }).promise;
  try {
    const { info, metadata } = await document.getMetadata() as unknown as { info?: Record<string, unknown>; metadata?: { getAll?: () => Record<string, unknown> } | null };
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
    const xmp = metadata?.getAll?.() ?? {};
    const dois: string[] = [];
    const push = (value: unknown) => {
      for (const candidate of String(value ?? "").match(/10\.\d{4,9}\/[^\s"<>]+/g) ?? []) {
        const doi = normalizeDoi(candidate);
        if (doi && !dois.includes(doi)) dois.push(doi);
      }
    };
    for (const [key, value] of Object.entries(xmp)) if (/doi|identifier/i.test(key)) push(value);
    push(info?.Subject);
    push(info?.Keywords);
    const xmpTitle = text(xmp["dc:title"]);
    return {
      title: text(info?.Title) ?? xmpTitle,
      author: text(info?.Author) ?? text(xmp["dc:creator"]),
      subject: text(info?.Subject),
      keywords: text(info?.Keywords),
      dois,
    };
  } finally {
    await document.destroy();
  }
}

async function defaultReadText(relativePath: string): Promise<PdfPages> {
  const { readPdfTextCache } = await import("@/lib/storage/pdf-text-cache");
  return readPdfTextCache(relativePath);
}

async function defaultReadMetadata(relativePath: string) {
  const { filePathFromParts, splitFilePath } = await import("@/lib/storage/paths");
  const { notebook, pathParts } = splitFilePath(relativePath);
  return readPdfDocumentMetadata(filePathFromParts(notebook, pathParts));
}

/** A title from PDF metadata worth using: not a placeholder, file name or tool name. */
export function plausibleMetadataTitle(title: string | undefined) {
  const value = title?.replace(/\s+/g, " ").trim();
  if (!value || value.length < 6 || value.length > 400) return undefined;
  if (/^(untitled|document\d*|title|microsoft word\b|slide \d+|presentation\d*)/i.test(value)) return undefined;
  if (/\.(docx?|pdf|tex|dvi|indd|qxd|rtf|odt)\b/i.test(value)) return undefined;
  if (!/\s/.test(value) && value.length > 30) return undefined;
  if (!/\p{L}{3}/u.test(value)) return undefined;
  return value;
}

/** The first line on the page that looks like a title, for when no model is used. */
export function guessTitleFromText(text: string) {
  const lines = text.split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 20);
  for (const line of lines) {
    const words = line.split(" ");
    if (words.length < 3 || words.length > 30) continue;
    if (/(journal|proceedings|vol\.|volume|issn|doi|arxiv|https?:|www\.|©|copyright|received|accepted|published|preprint|abstract|university|department|@)/i.test(line)) continue;
    if (!/\p{Lu}/u.test(line.charAt(0))) continue;
    return line;
  }
  return undefined;
}

export function titleFromFileName(relativePath: string) {
  const name = relativePath.split("/").pop() ?? relativePath;
  return name.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim() || name;
}

/** DOIs and arXiv IDs on a page, in the order they appear. */
export function identifiersInOrder(text: string) {
  const found = extractIdentifiers(text);
  const lower = text.toLowerCase();
  const items = [
    ...found.all.doi.filter((doi) => !doi.startsWith("10.48550/arxiv.")).map((value) => ({ kind: "doi" as const, value })),
    ...found.all.arxiv.map((value) => ({ kind: "arxiv" as const, value })),
  ];
  return items
    .map((item) => ({ ...item, position: lower.indexOf(item.value.toLowerCase()) }))
    .sort((a, b) => (a.position < 0 ? Infinity : a.position) - (b.position < 0 ? Infinity : b.position));
}

function fieldsInput(csl: CslItem, provenance: FieldProvenance, attachment: ReferenceAttachment, status: "unresolved" | "needs-review"): ReferenceEntryInput {
  const fields: Record<string, FieldProvenance> = {};
  for (const field of Object.keys(csl)) fields[field] = provenance;
  return compactInput({ ...fillFieldProvenance(normalizeEntryInput({ csl, provenance: fields, attachments: [attachment] }), () => provenance), status });
}

function withAttachment(input: ReferenceEntryInput, attachment: ReferenceAttachment, status: "needs-review" | "unresolved"): ReferenceEntryInput {
  return compactInput({ ...input, attachments: [...(input.attachments ?? []), attachment], status });
}

/** The PDF's own title and authors as competing values, for the confirmation card. */
function pdfEvidence(metadata: PdfDocumentMetadata, retrievedAt: string): ReferenceEntryInput | null {
  const title = plausibleMetadataTitle(metadata.title);
  if (!title) return null;
  const csl: CslItem = { type: "document", title };
  const provenance: Record<string, FieldProvenance> = { title: { source: "pdf-metadata", confidence: PDF_METADATA_CONFIDENCE, retrievedAt } };
  const authors = metadata.author?.split(/\s*(?:;|,\s*(?=\S+\s+\S)|\band\b|&)\s*/).map((name) => parseName(name)).filter((name: CslName) => Object.keys(name).length > 0);
  if (authors?.length) {
    csl.author = authors;
    provenance.author = { source: "pdf-metadata", confidence: PDF_METADATA_CONFIDENCE, retrievedAt };
  }
  return { csl, provenance };
}

/** Resolve one PDF in the library to a candidate entry with the PDF attached. */
export async function resolvePdfFile(relativePath: string, env: ResolveEnvironment, deps: PdfResolveDeps = {}): Promise<PdfResolution> {
  const retrievedAt = env.ctx.now().toISOString();
  const attachment: ReferenceAttachment = { kind: "pdf", path: relativePath };
  const { pages } = await (deps.readText ?? defaultReadText)(relativePath);
  let metadata: PdfDocumentMetadata = { dois: [] };
  try {
    metadata = await (deps.readMetadata ?? defaultReadMetadata)(relativePath);
  } catch (error) {
    if (isAbortError(error)) throw error;
    // Metadata is a hint only; the text is what counts.
  }
  const page1 = pages[0]?.text ?? "";
  const page2 = pages[1]?.text ?? "";
  const metadataTitle = plausibleMetadataTitle(metadata.title);
  const fileTitle = titleFromFileName(relativePath);

  if ((page1 + page2).replace(/\s+/g, "").length < MIN_TEXT_CHARS) {
    env.warnings.push("No text layer: this PDF looks scanned. Convert it with PDF to Markdown (OCR), then resolve it again.");
    const csl: CslItem = { type: "document", title: metadataTitle ?? fileTitle };
    const provenance: FieldProvenance = { source: "pdf-metadata", confidence: metadataTitle ? PDF_METADATA_CONFIDENCE : FILE_NAME_CONFIDENCE, retrievedAt };
    return { candidate: fieldsInput(csl, provenance, attachment, "unresolved"), method: "no-text-layer" };
  }

  const titleOnPages = (title: string | undefined) => Math.max(titleSimilarityInText(title, page1), page2 ? titleSimilarityInText(title, page2) : 0) >= TITLE_IN_TEXT_THRESHOLD;
  const evidence = pdfEvidence(metadata, retrievedAt);
  const tried = new Set<string>();
  const tryIdentifier = async (kind: "doi" | "arxiv", value: string) => {
    const key = `${kind}:${value.toLowerCase()}`;
    if (tried.has(key) || tried.size >= MAX_IDENTIFIERS_TRIED) return null;
    tried.add(key);
    const input = kind === "doi" ? await lookupDoi(value, env) : await lookupArxiv(value, env);
    if (!input) return null;
    if (titleOnPages(input.csl.title)) return input;
    env.warnings.push(`${kind === "doi" ? "DOI" : "arXiv ID"} ${value} names another work (probably a cited reference); it was skipped.`);
    return null;
  };

  // 1. Identifiers: metadata DOIs first, then page 1 and page 2 in reading order.
  if (onlineAllowed(env)) {
    const identifiers = [
      ...metadata.dois.map((value) => ({ kind: "doi" as const, value })),
      ...identifiersInOrder(page1),
      ...identifiersInOrder(page2),
    ];
    for (const { kind, value } of identifiers) {
      const input = await tryIdentifier(kind, value);
      if (input) {
        const candidate = evidence ? combineInputs(input, [evidence]) : input;
        return { candidate: withAttachment(candidate, attachment, "needs-review"), method: "identifier" };
      }
    }
  }

  // 2. Title, authors and year: from the model, or from metadata and the first lines.
  let extraction: LlmExtraction | null = null;
  let extractionInput: ReferenceEntryInput | null = null;
  if (env.aiAvailable) {
    try {
      extraction = await extractPdfFields(page1.length < 400 ? `${page1}\n\n${page2}` : page1, { fileName: relativePath.split("/").pop() ?? relativePath, metadataTitle, metadataAuthor: metadata.author }, { ctx: env.ctx, complete: env.complete });
      if (extraction.found) extractionInput = extractionToInput(extraction, { source: "llm", confidence: 0.5, retrievedAt });
      else extraction = null;
    } catch (error) {
      if (isAbortError(error) || env.ctx.signal?.aborted) throw error;
      env.warnings.push(`The model could not read the first page: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!extractionInput) {
    const title = metadataTitle ?? guessTitleFromText(page1);
    if (title) {
      const csl: CslItem = { type: "document", title };
      const source = metadataTitle ? "pdf-metadata" : "pdf-text";
      const confidence = metadataTitle ? PDF_METADATA_CONFIDENCE : PDF_TEXT_CONFIDENCE;
      const provenance: Record<string, FieldProvenance> = { title: { source, confidence, retrievedAt }, type: { source, confidence, retrievedAt } };
      const authors = metadataTitle ? pdfEvidence(metadata, retrievedAt)?.csl.author : undefined;
      if (authors?.length) {
        csl.author = authors;
        provenance.author = { source: "pdf-metadata", confidence: PDF_METADATA_CONFIDENCE, retrievedAt };
      }
      extractionInput = compactInput(normalizeEntryInput({ csl, provenance }));
    }
  }

  if (extractionInput && onlineAllowed(env)) {
    // Identifiers the model saw that the scan missed.
    for (const [kind, value] of [["doi", extraction?.doi], ["arxiv", extraction?.arxiv]] as const) {
      if (!value) continue;
      const input = await tryIdentifier(kind, value);
      if (input) return { candidate: withAttachment(combineInputs(input, [extractionInput, ...(evidence ? [evidence] : [])]), attachment, "needs-review"), method: "identifier" };
    }
    const title = extractionInput.csl.title!;
    const authors = extractionInput.csl.author ?? [];
    const year = extraction?.year;
    const queryString = [title, authors[0]?.family ?? authors[0]?.literal, year].filter(Boolean).join(" ");
    const match = await searchBibliographic(queryString, { title, authors, year }, env);
    if (match) {
      return { candidate: withAttachment(combineInputs(match.input, [extractionInput, ...(evidence ? [evidence] : [])]), attachment, "needs-review"), method: "search" };
    }
  }

  // 3. Nothing authoritative: the web, when the job or request allows it.
  if (env.aiAvailable && env.webSearch && extractionInput) {
    try {
      const description = [
        `Title: ${extractionInput.csl.title}`,
        extractionInput.csl.author?.length ? `Authors: ${extractionInput.csl.author.map((name) => name.literal ?? [name.given, name.family].filter(Boolean).join(" ")).join("; ")}` : "",
        extraction?.year ? `Year: ${extraction.year}` : "",
        `First page:\n${page1.slice(0, 1_500)}`,
      ].filter(Boolean).join("\n");
      const web = await lookupWithWeb(description, { ctx: env.ctx, complete: env.complete });
      if (web.input) return { candidate: withAttachment(combineInputs(web.input, [extractionInput]), attachment, "needs-review"), method: "web" };
    } catch (error) {
      if (isAbortError(error) || env.ctx.signal?.aborted) throw error;
      env.warnings.push(`Web search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (extractionInput) return { candidate: withAttachment(extractionInput, attachment, "unresolved"), method: "extracted" };
  const provenance: FieldProvenance = { source: "pdf-metadata", confidence: FILE_NAME_CONFIDENCE, retrievedAt };
  return { candidate: fieldsInput({ type: "document", title: fileTitle }, provenance, attachment, "unresolved"), method: "extracted" };
}
