import { createHash, randomUUID } from "node:crypto";
import { collectMarkdownMacros, MACRO_BLOCK_LANGUAGE } from "@/lib/markdown-macros";
import { getConfiguredMarkdownPreferences } from "@/lib/markdown-preferences-config";
import { mathMarkerPairs } from "@/lib/math-markers";
import { getFileType } from "@/lib/storage/file-types";
import { readDefinitionsSource, supportsDefinitions, writeDefinitions } from "@/lib/storage/definitions";
import { readPdfTextCache } from "@/lib/storage/pdf-text-cache";
import {
  DEFINITION_KINDS,
  DEFINITIONS_VERSION,
  MAX_DEFINITION_ENTRIES,
  MAX_DEFINITION_MEANING_CHARS,
  MAX_DEFINITION_QUOTE_CHARS,
  MAX_DEFINITION_TERM_CHARS,
  definitionKey,
  normalizeDefinitionEntry,
  type DefinitionEntry,
} from "@/lib/definitions";
import { checkDefinitionCards, uncoveredDefinitionPassages, type DefinitionSource } from "@/lib/definitions-validation";
import { missingFileError, ok, plural, readCurrentText, requireString, resolve, ToolError, type AgentSkill, type AgentTool, type ToolContext } from "../tools";
import { statLibraryPath, type ResolvedPath } from "../library";

// Definitions and notation: the agent reads a document through and saves a
// card for every term, symbol and standing convention it introduces, into the
// document's side-car (storage/definitions.ts). The Definitions tab of the
// Outlines panel shows them, searchable. The document never changes, so this
// works in every permission mode, including Read Only.
//
// Like the other skills, the model's work is checked and sent back:
// SaveDefinitions rejects cards whose math KaTeX cannot typeset or whose
// excerpt is not in the document (definitions-validation.ts), and the finish
// pass names passages that look like definitions but have no card.

export const DEFINITIONS_SKILL = "extract-definitions";

const MAX_ENTRIES_PER_CALL = 300;
/** Times the finish pass sends uncovered passages back before it settles. */
const COVERAGE_ROUNDS = 2;
const UNCOVERED_LISTED = 15;

const instructions = `
# Extracting definitions and notation

You build a glossary of a document for a reader who wants to follow it without first memorising every symbol: one card for each **definition** (a named concept: "a function is *Lipschitz* if…"), **notation** (a symbol or operator: $\\mathcal{F}_t$, $\\|\\cdot\\|_{op}$, $[n]$) and **convention** (a standing assumption or usage rule: "throughout, $G$ is a finite group", "vectors are columns", "$\\log$ is natural"). SaveDefinitions writes the cards to a side-car file beside the document; the document itself never changes.

## How to work

1. Read the whole document, in order. Long text files: Read with offset and limit, window after window. PDFs: Read pages "1-20", then "21-40", and so on, until the last page. Do not skim or stop early: notation introduced in an appendix or a proof counts too.
2. Save as you go. After every few windows, call **SaveDefinitions** with the cards from the part you just read. The first call of this run replaces the document's previous cards; later calls add to them, and a card with the same kind, term and location replaces the earlier one (send it again to correct it). For a short document, one call at the end is enough.
3. SaveDefinitions checks every card. Cards it rejects are not saved: fix exactly what it reports and send only those cards again. When you finish, Libera may list passages that look like definitions but have no card; read them, and save cards for those that are, or say in your reply why they are not.
4. When you have read it all and saved the last cards, reply in one or two sentences: how many cards, and anything notable (notation that changes meaning partway, symbols used but never defined). Do not list the cards; the user reads them in the Definitions tab.

## Each card

- **term**: the name or symbol exactly as the reader sees it. Symbols in math markers, e.g. \`$\\mathcal{F}_t$\`, \`$f \\ast g$\`. Named concepts in words, the defined word as written ("Lipschitz continuity", "regret"). One card per concept; when a name and a symbol go together ("the *filtration* $(\\mathcal{F}_t)$"), make one card with the symbol as the term and the name in aliases.
- **kind**: definition, notation or convention.
- **meaning**: what it means in this document, self-contained, in one to four sentences of Markdown. Give the defining formula when there is one, the type of the object (a set, a map from … to …, a random variable), and the standing assumptions it carries. Use the document's own symbols, and say what each symbol in the formula is. Do not explain textbook background the document does not give.
- **aliases**: plain words a reader might search for: the spoken name of a symbol ("script F", "filtration", "convolution"), abbreviations, other spellings. Leave out the term itself.
- **location**: where it is introduced, as the document labels it: "Definition 2.3", "§1.2 Setup", "Eq. (4)". Leave it out when there is no label. An overloaded symbol gets one card per meaning, each with its own location.
- **quote**: a short exact excerpt (5–25 words) from the passage that introduces it, copied character for character from what Read showed, without the line numbers (keep the LaTeX source as written in a Markdown or LaTeX file), so Libera can jump to it.
- **line** (Markdown, LaTeX) or **page** (PDF): where it is introduced. Required for a PDF card.

## Math

Cards are shown with KaTeX, which only knows standard LaTeX. Write all math inside the configured math markers (never bare \\commands in text), inline math inside sentences. In a LaTeX or PDF document, write out the document's own macros (\\newcommand, \\DeclareMathOperator) as the standard LaTeX they stand for; in a Markdown note you may use the note's Markdown macros (a \`libera-macro\` block), which Libera expands. Include notation the document uses without defining only when its meaning is clear from the document; then say "used without definition".

## Rules

- Never invent a definition; every card must come from the document.
- Do not include ordinary words, theorem statements, or results; only what the reader needs to decode the text.
- Do not change the document, and do not ask before starting: the user asked for the cards.
`;

type DefinitionsRunState = { saved: Map<string, DefinitionEntry[]>; coverageRounds: number; reminded: boolean };

function runState(context: ToolContext): DefinitionsRunState {
  let state = context.skillState.get(DEFINITIONS_SKILL) as DefinitionsRunState | undefined;
  if (!state) {
    state = { saved: new Map(), coverageRounds: 0, reminded: false };
    context.skillState.set(DEFINITIONS_SKILL, state);
  }
  return state;
}

/** The document as the agent reads it: an open editor's draft, the shared document, the file, or a PDF's text. */
async function readSource(context: ToolContext, resolved: ResolvedPath): Promise<{ source: DefinitionSource; text?: { content: string; fromDraft: boolean; shared?: unknown } }> {
  if (getFileType(resolved.path) === "pdf") {
    try { return { source: { kind: "pdf", pages: (await readPdfTextCache(resolved.path)).pages } }; }
    catch (error) { throw new ToolError(`Could not extract text from ${resolved.path}: ${error instanceof Error ? error.message : "unknown error"}.`); }
  }
  const text = await readCurrentText(context, resolved);
  if (!text) return missingFileError(context, resolved);
  const macros = text.content.includes(MACRO_BLOCK_LANGUAGE) ? collectMarkdownMacros(text.content) : undefined;
  return { source: { kind: "text", content: text.content, ...(macros?.macros.size ? { macros } : {}) }, text };
}

const entrySchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: [...DEFINITION_KINDS] },
    term: { type: "string", description: "The name or symbol as the reader sees it; math in math markers.", maxLength: MAX_DEFINITION_TERM_CHARS },
    meaning: { type: "string", description: "What it means in this document: Markdown, math in math markers.", maxLength: MAX_DEFINITION_MEANING_CHARS },
    aliases: { type: "array", items: { type: "string" }, description: "Plain words to search by: spoken names of symbols, synonyms." },
    location: { type: "string", description: "Where it is introduced, as the document labels it, e.g. \"Definition 2.3\"." },
    quote: { type: "string", description: "A short exact excerpt from the passage that introduces it.", maxLength: MAX_DEFINITION_QUOTE_CHARS },
    line: { type: "integer", description: "Markdown and LaTeX: 1-based line where it is introduced." },
    page: { type: "integer", description: "PDF: 1-based page where it is introduced." },
  },
  required: ["kind", "term", "meaning"],
  additionalProperties: false,
};

const saveDefinitionsTool: AgentTool = {
  name: "SaveDefinitions",
  kind: "comment",
  description: `Saves definitions and notation cards for a Markdown, LaTeX or PDF document, for the ${DEFINITIONS_SKILL} skill. The cards go to a side-car file the Definitions tab shows; the document never changes.

- The first call for a document in this run replaces its previous cards; later calls add to them. A card with the same kind, term and location as an earlier one replaces it.
- Every card is checked: its math must typeset in KaTeX, LaTeX must be inside math markers, and its quote (or line, or page) must be in the document. Rejected cards are not saved; the result says what to fix.
- At most ${MAX_ENTRIES_PER_CALL} cards per call; save in parts as you read.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Library path of the document, e.g. \"Research/paper.md\"." },
      entries: { type: "array", items: entrySchema, maxItems: MAX_ENTRIES_PER_CALL },
    },
    required: ["path", "entries"],
    additionalProperties: false,
  },
  describe: (args) => `Saving ${Array.isArray(args.entries) ? plural(args.entries.length, "card") : "cards"} for ${String(args.path ?? "the document")}`,
  async run(args, context) {
    const resolved = await resolve(context, requireString(args, "path"));
    if (!supportsDefinitions(resolved.path)) throw new ToolError(`${resolved.path} is not a Markdown, LaTeX or PDF document.`);
    const stats = await statLibraryPath(resolved);
    if (!stats?.isFile()) return missingFileError(context, resolved);
    if (!Array.isArray(args.entries) || !args.entries.length) throw new ToolError("entries must be a non-empty array of cards.");
    if (args.entries.length > MAX_ENTRIES_PER_CALL) throw new ToolError(`Send at most ${MAX_ENTRIES_PER_CALL} cards per call.`);

    const { source, text } = await readSource(context, resolved);
    const pairs = mathMarkerPairs(getConfiguredMarkdownPreferences());
    const problems: string[] = [];
    const candidates: { index: number; entry: DefinitionEntry }[] = [];
    for (const [index, raw] of args.entries.entries()) {
      const entry = normalizeDefinitionEntry(raw, randomUUID().slice(0, 8));
      if (entry) candidates.push({ index, entry: { ...entry, id: randomUUID().slice(0, 8) } });
      else problems.push(`entries[${index}]: a card needs a term and a meaning.`);
    }
    const checks = checkDefinitionCards(candidates.map((candidate) => candidate.entry), source, pairs);
    const accepted: DefinitionEntry[] = [];
    const notes: string[] = [];
    checks.forEach((check, position) => {
      const { index, entry } = candidates[position];
      notes.push(...check.notes);
      if (check.problems.length) {
        // Name the card by its term so the model finds it again.
        problems.push(`entries[${index}] (${entry.term.slice(0, 60)}):\n${check.problems.map((problem) => `  - ${problem}`).join("\n")}`);
      } else accepted.push(check.entry);
    });

    const state = runState(context);
    const first = !state.saved.has(resolved.path);
    // Nothing valid on the first call: keep the previous cards rather than replace them with none.
    if (first && !accepted.length) {
      return { text: `No cards were saved; the previous cards are unchanged. Fix these and call SaveDefinitions again:\n${problems.join("\n")}`, isError: true, result: `${plural(problems.length, "card")} rejected`, detail: problems.join("\n") };
    }
    const merged = new Map<string, DefinitionEntry>();
    for (const entry of [...(state.saved.get(resolved.path) ?? []), ...accepted]) {
      const key = definitionKey(entry);
      merged.delete(key);
      merged.set(key, entry);
    }
    const entries = [...merged.values()].slice(0, MAX_DEFINITION_ENTRIES);
    const identity = text && (text.fromDraft || text.shared)
      ? { size: Buffer.byteLength(text.content), contentHash: createHash("sha256").update(text.content).digest("hex") }
      : await readDefinitionsSource(resolved.path);
    await writeDefinitions(resolved.path, {
      version: DEFINITIONS_VERSION,
      documentPath: resolved.path,
      generatedAt: new Date().toISOString(),
      ...(context.model ? { model: context.model } : {}),
      source: identity,
      entries,
    });
    state.saved.set(resolved.path, entries);
    context.emit({ type: "definitions_saved", path: resolved.path, count: entries.length });

    const summary = `Saved ${plural(accepted.length, "card")}${first ? " (the previous cards were replaced)" : ""}; ${resolved.path} now has ${plural(entries.length, "card")}.`;
    const noteText = notes.length ? `\nNotes:\n${notes.map((note) => `- ${note}`).join("\n")}` : "";
    if (problems.length) {
      return {
        text: `${summary}\n\n${plural(problems.length, "card")} ${problems.length === 1 ? "was" : "were"} rejected and not saved. Fix these and send only those cards again:\n${problems.join("\n")}${noteText}`,
        isError: true,
        result: `${plural(accepted.length, "card")} saved, ${problems.length} rejected`,
        detail: problems.join("\n"),
      };
    }
    return ok(`${summary}${noteText}`, `${plural(entries.length, "card")} saved`);
  },
};

/**
 * When the model ends a reply: remind it once if it saved nothing, then send
 * back passages that look like definitions but have no card, at most
 * COVERAGE_ROUNDS times.
 */
async function finishPass(context: ToolContext, { final }: { final: boolean }) {
  const state = runState(context);
  if (final) return null;
  if (!state.saved.size) {
    if (state.reminded) return null;
    state.reminded = true;
    return "You loaded the extract-definitions skill but saved no cards. If the user asked for definitions or notation, read the document through and call SaveDefinitions; otherwise answer without it.";
  }
  if (state.coverageRounds >= COVERAGE_ROUNDS) return null;
  const reports: string[] = [];
  for (const [path, entries] of state.saved) {
    let source: DefinitionSource;
    try { source = (await readSource(context, await resolve(context, path))).source; }
    catch { continue; }
    const uncovered = uncoveredDefinitionPassages(source, entries);
    if (!uncovered.length) continue;
    const listed = uncovered.slice(0, UNCOVERED_LISTED).map((passage) => `- ${passage.line ? `line ${passage.line}` : `page ${passage.page}`}: “${passage.text}”`);
    const more = uncovered.length > UNCOVERED_LISTED ? `\n- …and ${uncovered.length - UNCOVERED_LISTED} more` : "";
    reports.push(`${path}:\n${listed.join("\n")}${more}`);
  }
  if (!reports.length) return null;
  state.coverageRounds++;
  return `These passages look like they introduce a definition, notation or convention, but no card points near them:\n\n${reports.join("\n\n")}\n\nRead them. Save cards (with an exact quote) for those that introduce something; skip those that do not, or that a card already covers under another term, and say so briefly in your reply.`;
}

export const extractDefinitionsSkill: AgentSkill = {
  name: DEFINITIONS_SKILL,
  description: "Build a document's glossary of definitions, notation and conventions as searchable cards in the Definitions tab (a side-car file; the document is unchanged). Use when the user asks to extract, list or collect the definitions, notation or symbols of a Markdown, LaTeX or PDF document.",
  instructions,
  tools: [saveDefinitionsTool],
  finishPass,
};
