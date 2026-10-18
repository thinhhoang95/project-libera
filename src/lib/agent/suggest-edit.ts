import { randomUUID } from "node:crypto";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { getFileType } from "@/lib/storage/file-types";
import { addAgentSuggestions } from "@/lib/storage/markdown-reviews";
import { anchorAt, mapAnchor, reviewBlocks, type ReviewAnchor, type ReviewRange } from "@/lib/markdown-review";
import {
  closestLines, findEditTarget, lineOfOffset, missingFileError, ok, optionalString, plural, quoted, readCurrentText, requireString, resolve, ToolError,
  type AgentTool, type ToolContext,
} from "./tools";

// Suggested edits: the agent proposes a concrete rewrite of a passage without
// changing the file. SuggestEdit records it in the run's state; when the agent
// finishes its reply, finishSuggestedEdits saves each one as a pending agent
// suggestion in the document's review, where the user accepts, rejects or
// asks for a revision. Any skill can offer the tool; add the finish helper to
// the skill's finishPass.

/** skillState key for pending suggestions, shared by every skill that offers SuggestEdit. */
export const SUGGEST_EDIT_STATE = "suggest-edit";

type PendingSuggestion = { anchor: ReviewAnchor; after: string; reason: string; comment?: string };
type PendingFile = { path: string; original: string; suggestions: PendingSuggestion[] };

function pendingFiles(context: ToolContext) {
  let files = context.skillState.get(SUGGEST_EDIT_STATE) as Map<string, PendingFile> | undefined;
  if (!files) {
    files = new Map();
    context.skillState.set(SUGGEST_EDIT_STATE, files);
  }
  return files;
}

/** Remap a file's pending suggestions onto its current text; those whose passage changed are returned separately. */
function rebase(file: PendingFile, text: string) {
  if (file.original === text) return { kept: file.suggestions, lost: [] as PendingSuggestion[] };
  const kept: PendingSuggestion[] = [];
  const lost: PendingSuggestion[] = [];
  for (const suggestion of file.suggestions) {
    const anchor = mapAnchor(suggestion.anchor, file.original, text);
    if (anchor.state === "attached" && text.slice(anchor.start, anchor.end) === suggestion.anchor.quote) kept.push({ ...suggestion, anchor });
    else lost.push(suggestion);
  }
  return { kept, lost };
}

/** Blocks a passage may lie in: Markdown blocks, or blank-line separated paragraphs for LaTeX. */
function blockRanges(text: string, fileType: "markdown" | "latex"): ReviewRange[] {
  if (fileType === "markdown") return reviewBlocks(text).filter((block) => block.type !== "definition");
  const blocks: ReviewRange[] = [];
  let cursor = 0;
  for (const match of [...text.matchAll(/\n[ \t]*\n/g), null]) {
    const end = match ? match.index : text.length;
    const raw = text.slice(cursor, end);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) blocks.push({ start: cursor + lead, end: cursor + lead + trimmed.length });
    if (match) cursor = match.index + match[0].length;
  }
  return blocks;
}

/**
 * A passage the review can anchor and both editors can preview: inside one
 * block, or a run of whole blocks. Returns why not, or null.
 */
export function passageProblem(text: string, range: ReviewRange, fileType: "markdown" | "latex") {
  const blocks = blockRanges(text, fileType).filter((block) => block.start < range.end && block.end > range.start);
  if (!blocks.length) return "before is only blank lines or space between paragraphs. Include text from the paragraph you want to change.";
  if (blocks.length === 1) return null;
  if (range.start <= blocks[0].start && range.end >= blocks.at(-1)!.end) return null;
  return "before spans parts of several paragraphs or blocks. Suggest one edit per paragraph, or make before cover whole paragraphs.";
}

export const suggestEditTool: AgentTool = {
  name: "SuggestEdit",
  kind: "comment",
  description: `Proposes a concrete rewrite of a passage in a Markdown or LaTeX file, as a suggested edit the user accepts or rejects. The file itself never changes, so this works in every permission mode.

Usage:
- Read the file first. before is exact text from the file, without line numbers, and must occur exactly once; include more words to make it unique. after is the replacement ("" deletes the passage).
- Keep before within one paragraph (or other block), or make it cover whole paragraphs. Make the smallest change that fixes the problem, in the document's own style and syntax.
- reason says why, in a sentence or two; the user sees it next to the change. comment optionally adds a review comment on the passage with more detail.
- One call per change. Suggestions are saved for the user when you finish your reply; to change one, call SuggestEdit again with the same before.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Library path of the Markdown or LaTeX file." },
      before: { type: "string", description: "The exact passage to replace." },
      after: { type: "string", description: "The proposed replacement." },
      reason: { type: "string", description: "Why the change is needed, shown with the suggestion." },
      comment: { type: "string", description: "Optional review comment on the passage, linked to the suggestion." },
    },
    required: ["path", "before", "after", "reason"],
    additionalProperties: false,
  },
  describe: (args) => `Suggesting an edit to ${String(args.path ?? "a file")}`,
  async run(args, context) {
    const resolved = await resolve(context, requireString(args, "path"));
    if (isSharedNotebookPath(resolved.path)) {
      throw new ToolError(`${resolved.path} is in a shared notebook. Suggested edits are stored only on this computer, so collaborators would never see them; they are not available for shared documents yet. Describe the change in your reply instead.`);
    }
    const fileType = getFileType(resolved.path);
    if (fileType !== "markdown" && fileType !== "latex") throw new ToolError(`${resolved.path} is not a Markdown or LaTeX file. Suggested edits work only on .md and .tex files; describe other changes in your reply.`);
    const before = requireString(args, "before");
    const after = requireString(args, "after", { allowEmpty: true });
    const reason = requireString(args, "reason").trim().slice(0, 2_000);
    const comment = optionalString(args, "comment")?.trim().slice(0, 20_000);
    if (before === after) throw new ToolError("before and after are identical; there is nothing to suggest.");
    const current = await readCurrentText(context, resolved);
    if (!current) return missingFileError(context, resolved);
    if (!context.fileState.has(resolved.path)) throw new ToolError(`Read ${resolved.path} before suggesting edits to it.`);

    const target = findEditTarget(current.content, before, after);
    if (!target.matches.length) {
      throw new ToolError(`before was not found in ${resolved.path}. Copy it exactly from your latest Read, without line numbers.${closestLines(current.content, before)}`);
    }
    if (target.matches.length > 1) {
      const lines = target.matches.slice(0, 10).map((match) => lineOfOffset(current.content, match.index));
      throw new ToolError(`before matches ${target.matches.length} places in ${resolved.path} (lines ${lines.join(", ")}${target.matches.length > 10 ? ", …" : ""}). Include more of the surrounding text so it matches only the passage you mean.`);
    }
    const match = target.matches[0];
    const range = { start: match.index, end: match.index + match.length };
    const problem = passageProblem(current.content, range, fileType);
    if (problem) throw new ToolError(`Nothing was recorded: ${problem}`);
    const replacement = current.content.includes("\r\n") ? target.newString.replace(/\r?\n/g, "\r\n") : target.newString;
    const anchor = anchorAt(current.content, range);

    const files = pendingFiles(context);
    const existing = files.get(resolved.path);
    const { kept, lost } = existing ? rebase(existing, current.content) : { kept: [], lost: [] };
    // The same passage again replaces the earlier suggestion; any other overlap is refused.
    const others = kept.filter((item) => item.anchor.start !== anchor.start || item.anchor.end !== anchor.end);
    const overlapping = others.find((item) => item.anchor.start < anchor.end && item.anchor.end > anchor.start);
    if (overlapping) {
      throw new ToolError(`This passage overlaps your earlier suggestion for ${quoted(overlapping.anchor.quote)} (line ${lineOfOffset(current.content, overlapping.anchor.start)}). Change that suggestion by calling SuggestEdit with its before, or choose a passage that does not overlap.`);
    }
    const replaced = others.length !== kept.length;
    files.set(resolved.path, { path: resolved.path, original: current.content, suggestions: [...others, { anchor, after: replacement, reason, ...(comment ? { comment } : {}) }].sort((left, right) => left.anchor.start - right.anchor.start) });

    const line = lineOfOffset(current.content, range.start);
    const text = [
      `${replaced ? "Replaced your earlier suggestion" : "Recorded a suggested edit"} for ${resolved.path} at line ${line}. It becomes a pending suggestion the user can accept or reject when you finish your reply; the file is unchanged.`,
      lost.length ? `${plural(lost.length, "earlier suggestion")} for this file no longer match${lost.length === 1 ? "es" : ""} its text and ${lost.length === 1 ? "was" : "were"} dropped: ${lost.map((item) => quoted(item.anchor.quote)).join(", ")}.` : "",
      target.note ?? "",
    ].filter(Boolean).join("\n");
    return ok(text, replaced ? "Suggestion replaced" : "Suggestion recorded", `${anchor.quote}\n→\n${replacement || "(delete passage)"}`);
  },
};

function reportStep(context: ToolContext, summary: string, status: "ok" | "error", result: string, detail?: string) {
  const id = `suggestions-${randomUUID()}`;
  context.emit({ type: "tool_started", id, name: "SuggestedEdits", summary });
  context.emit({ type: "tool_finished", id, status, result, ...(detail ? { detail } : {}) });
}

function describeSuggestions(suggestions: PendingSuggestion[]) {
  return suggestions.map((item) => `${item.anchor.quote}\n→\n${item.after || "(delete passage)"}`).join("\n\n—\n\n");
}

/**
 * Saves the run's pending suggested edits to each document's review and
 * emits `suggestions_added` per file. Call it from a skill's finishPass; it
 * never sends feedback, so it returns null. Suggestions whose passage changed
 * during the run (the agent edited the file, say) are dropped and reported.
 */
export async function finishSuggestedEdits(context: ToolContext): Promise<null> {
  const files = context.skillState.get(SUGGEST_EDIT_STATE) as Map<string, PendingFile> | undefined;
  if (!files?.size) return null;
  for (const file of [...files.values()]) {
    files.delete(file.path);
    if (!file.suggestions.length) continue;
    const summary = `Adding suggested edits to ${file.path}`;
    if (isSharedNotebookPath(file.path)) {
      reportStep(context, summary, "error", "Not available in shared notebooks", describeSuggestions(file.suggestions));
      continue;
    }
    let current: { content: string } | null = null;
    try { current = await readCurrentText(context, await resolve(context, file.path)); } catch { current = null; }
    if (!current) {
      reportStep(context, summary, "error", "The file no longer exists", describeSuggestions(file.suggestions));
      continue;
    }
    const { kept, lost } = rebase(file, current.content);
    try {
      if (kept.length) {
        await addAgentSuggestions(file.path, current.content, kept.map((item) => ({
          range: { start: item.anchor.start, end: item.anchor.end }, after: item.after, reason: item.reason, runId: context.snapshots.runId,
          ...(item.comment ? { comment: item.comment } : {}),
        })));
      }
      context.emit({ type: "suggestions_added", path: file.path, count: kept.length });
      reportStep(context, summary, lost.length ? "error" : "ok",
        `${plural(kept.length, "suggested edit")} added${lost.length ? `; ${lost.length} no longer matched the text` : ""}`,
        lost.length ? describeSuggestions(lost) : undefined);
    } catch (error) {
      reportStep(context, summary, "error", `Could not save the suggested edits: ${error instanceof Error ? error.message : "unknown error"}`, describeSuggestions(kept));
    }
  }
  return null;
}
