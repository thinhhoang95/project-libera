import { randomUUID } from "node:crypto";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { getFileType } from "@/lib/storage/file-types";
import { addReviewThreads } from "@/lib/storage/markdown-reviews";
import {
  CommentSyntaxError, describePlacement, locateComments, parseReviewCopy, placeComments, rebaseComments, renderReviewCopy,
  type CommentPlacement, type DraftComment,
} from "../review-comments";
import {
  closestLines, findEditTarget, lineOfOffset, missingFileError, ok, plural, readCurrentText, requireString, resolve, ToolError,
  type AgentSkill, type AgentTool, type ToolContext,
} from "../tools";
import { finishSuggestedEdits, suggestEditTool } from "../suggest-edit";

// Review comments, written the way a model edits text: LeaveComment is Edit
// on a review copy of the document, where the model adds ":::comment" blocks
// beneath paragraphs. The file never changes. When the model finishes a
// reply, the copies are compiled into the Comments panel's threads, or the
// model is told which comments to fix.

const NAME = "leave-review-comments";

// Review comments live in Libera's local review store, which collaborators
// never see. On a shared document they would be private notes posing as
// review comments, so the skill is off there until shared comment threads
// (Phase 2, M2.3) can carry them with an AI actor.
const SHARED_UNAVAILABLE = "Review comments are not available for documents in shared notebooks yet: Libera's review comments are stored only on this computer, so collaborators would never see them. Shared comments arrive in a later update. Give your review in your reply instead (quote the passages you comment on), and tell the user why.";

function sharedNotice(filePath: string) {
  return `${filePath} is in a shared notebook. ${SHARED_UNAVAILABLE}`;
}

type ReviewCopy = { path: string; fileType: "markdown" | "latex"; original: string; comments: DraftComment[] };

function reviewCopies(context: ToolContext) {
  let copies = context.skillState.get(NAME) as Map<string, ReviewCopy> | undefined;
  if (!copies) {
    copies = new Map();
    context.skillState.set(NAME, copies);
  }
  return copies;
}

function sameComment(left: DraftComment, right: DraftComment) {
  return left.offset === right.offset && left.text === right.text;
}

/** Lines around a region of the review copy, without line numbers: the copy's lines are not the file's. */
function region(text: string, start: number, end: number) {
  const lines = text.split(/\r?\n/);
  const first = Math.max(0, lineOfOffset(text, start) - 4);
  const last = Math.min(lines.length, lineOfOffset(text, end) + 3, first + 40);
  return lines.slice(first, last).join("\n");
}

const leaveCommentTool: AgentTool = {
  name: "LeaveComment",
  kind: "comment",
  description: `Adds, changes or removes review comments in a Markdown or LaTeX file. Follow the ${NAME} skill's instructions.

Usage:
- Works like Edit, but on your review copy of the file; the file itself never changes. old_string is exact text from the file, or from your review copy including earlier comment blocks as LeaveComment showed them. new_string is the same text with ":::comment" blocks added, changed, moved or removed. Everything other than comment blocks must stay the same.
- A comment block is a line ":::comment", the comment, and a line ":::", directly beneath the paragraph it is about.
- Read the file before commenting on it. old_string must occur exactly once in the review copy.
- Comments become the user's review comments when you finish your reply.`,
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Library path of the Markdown or LaTeX file." },
      old_string: { type: "string", description: "Exact text to find in your review copy, e.g. the last line of the paragraph you comment on." },
      new_string: { type: "string", description: "The same text with comment blocks added, changed or removed." },
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  },
  describe: (args) => `Commenting on ${String(args.file_path ?? "a file")}`,
  async run(args, context) {
    const resolved = await resolve(context, requireString(args, "file_path"));
    if (isSharedNotebookPath(resolved.path)) throw new ToolError(sharedNotice(resolved.path));
    const oldString = requireString(args, "old_string", { allowEmpty: true });
    const newString = requireString(args, "new_string", { allowEmpty: true });
    const fileType = getFileType(resolved.path);
    if (fileType !== "markdown" && fileType !== "latex") throw new ToolError(`${resolved.path} is not a Markdown or LaTeX file. Review comments work only on .md and .tex files; give feedback on other files in your reply.`);
    const current = await readCurrentText(context, resolved);
    if (!current) return missingFileError(context, resolved);
    if (!context.fileState.has(resolved.path)) throw new ToolError(`Read ${resolved.path} before commenting on it.`);
    const copies = reviewCopies(context);
    let copy = copies.get(resolved.path);
    if (!copy) {
      let existing = 0;
      try { existing = parseReviewCopy(current.content).comments.length; } catch { existing = 1; }
      if (existing) throw new ToolError(`${resolved.path} itself contains ":::comment" lines, so review comments cannot be written into it. Give your feedback in your reply instead.`);
      copy = { path: resolved.path, fileType, original: current.content, comments: [] };
    } else if (copy.original !== current.content) {
      // The file changed since the last comment, e.g. the agent edited it.
      copy = { ...copy, original: current.content, comments: rebaseComments(copy.comments, copy.original, current.content) };
    }
    if (!oldString) throw new ToolError("old_string is empty. Put the last line of the paragraph you are commenting on in old_string, and repeat it in new_string followed by your :::comment block.");
    if (oldString === newString) throw new ToolError("old_string and new_string are identical; nothing changes.");

    const before = renderReviewCopy(copy.original, copy.comments);
    const target = findEditTarget(before, oldString, newString);
    if (!target.matches.length) {
      throw new ToolError(`old_string was not found in your review copy of ${resolved.path}. Copy it from your latest Read of the file, without line numbers, or from a comment block as LeaveComment showed it.${closestLines(before, oldString)}`);
    }
    if (target.matches.length > 1) {
      throw new ToolError(`old_string matches ${target.matches.length} places in ${resolved.path}. Include more of the surrounding text so it matches only the place you mean.`);
    }
    const match = target.matches[0];
    const after = before.slice(0, match.index) + target.newString + before.slice(match.index + match.length);
    let comments: DraftComment[];
    try { comments = locateComments(copy.original, after); }
    catch (error) {
      if (error instanceof CommentSyntaxError) throw new ToolError(`Nothing was changed. ${error.message}`);
      throw error;
    }
    const previous = copy.comments;
    copies.set(resolved.path, { ...copy, comments });

    const placements = placeComments(copy.original, comments, copy.fileType);
    const added = placements.filter((placement) => !previous.some((earlier) => sameComment(earlier, placement)));
    const removed = previous.filter((earlier) => !comments.some((comment) => sameComment(earlier, comment))).length - added.length;
    const otherProblems = placements.filter((placement) => placement.problem && !added.includes(placement));
    const problems = placements.filter((placement) => placement.problem).length;
    const rendered = renderReviewCopy(copy.original, comments);
    const shown = added.flatMap((placement) => {
      const index = rendered.indexOf(`:::comment\n${placement.text}\n:::`);
      return index < 0 ? [] : [index];
    });
    const text = [
      `Updated your review copy of ${resolved.path}; it has ${plural(comments.length, "comment")}.${removed > 0 ? ` Removed ${plural(removed, "comment")}.` : ""}`,
      ...added.map((placement) => `- ${describePlacement(copy.original, placement)}`),
      ...(otherProblems.length ? ["Other comments to fix:", ...otherProblems.map((placement) => `- ${describePlacement(copy.original, placement)}`)] : []),
      problems ? "Fix the comments with problems before you finish." : "They become review comments for the user when you finish your reply.",
      target.note ?? "",
      shown.length ? `Review copy now:\n${region(rendered, Math.min(...shown), Math.max(...shown))}` : "",
    ].filter(Boolean).join("\n");
    const result = problems ? `${plural(problems, "comment")} to fix`
      : added.length ? `${plural(added.length, "comment")} placed`
      : removed > 0 ? `${plural(removed, "comment")} removed` : "Updated";
    return ok(text, result, added.map((placement) => placement.text).join("\n\n—\n\n") || undefined);
  },
};

function listProblems(placements: CommentPlacement[], original: string) {
  return placements.filter((placement) => placement.problem).map((placement) => `- ${describePlacement(original, placement)}`);
}

/** Compile every review copy: send problems back to the model, or save the comments to the review. */
async function finishComments(context: ToolContext, { final }: { final: boolean }): Promise<string | null> {
  const copies = context.skillState.get(NAME) as Map<string, ReviewCopy> | undefined;
  if (!copies?.size) return null;
  const compiled: { copy: ReviewCopy; placements: CommentPlacement[] }[] = [];
  for (const copy of [...copies.values()]) {
    if (!copy.comments.length) { copies.delete(copy.path); continue; }
    if (isSharedNotebookPath(copy.path)) {
      // Shared since the comments were drafted: never save them locally.
      copies.delete(copy.path);
      const id = `comments-${randomUUID()}`;
      context.emit({ type: "tool_started", id, name: "ReviewComments", summary: `Adding review comments to ${copy.path}` });
      context.emit({ type: "tool_finished", id, status: "error", result: "Not available in shared notebooks", detail: copy.comments.map((comment) => comment.text).join("\n\n—\n\n") });
      continue;
    }
    let current: { content: string } | null = null;
    try { current = await readCurrentText(context, await resolve(context, copy.path)); } catch { current = null; }
    if (!current) {
      copies.delete(copy.path);
      const id = `comments-${randomUUID()}`;
      context.emit({ type: "tool_started", id, name: "ReviewComments", summary: `Adding review comments to ${copy.path}` });
      context.emit({ type: "tool_finished", id, status: "error", result: "The file no longer exists", detail: copy.comments.map((comment) => comment.text).join("\n\n—\n\n") });
      continue;
    }
    const updated = { ...copy, original: current.content, comments: rebaseComments(copy.comments, copy.original, current.content) };
    copies.set(copy.path, updated);
    compiled.push({ copy: updated, placements: placeComments(updated.original, updated.comments, updated.fileType) });
  }

  const problems = compiled.flatMap(({ placements }) => placements.filter((placement) => placement.problem));
  if (problems.length && !final) {
    const report = compiled.flatMap(({ copy, placements }) => {
      const lines = listProblems(placements, copy.original);
      return lines.length ? [`${copy.path}:`, ...lines] : [];
    }).join("\n");
    const id = `comments-${randomUUID()}`;
    context.emit({ type: "tool_started", id, name: "ReviewComments", summary: "Checking review comments" });
    context.emit({ type: "tool_finished", id, status: "error", result: `${plural(problems.length, "comment")} to fix`, detail: report });
    return `Your review comments are not finished: ${plural(problems.length, "comment")} cannot be attached where you put ${problems.length === 1 ? "it" : "them"}.\n${report}\nFix each one with LeaveComment: move the :::comment block to directly beneath the paragraph it is about, or remove it. Then finish your reply again.`;
  }

  for (const { copy, placements } of compiled) {
    copies.delete(copy.path);
    const placed = placements.filter((placement, index) => placement.anchor && !placements.slice(0, index).some((earlier) =>
      earlier.anchor?.start === placement.anchor!.start && earlier.anchor?.end === placement.anchor!.end && earlier.text === placement.text));
    const dropped = placements.filter((placement) => placement.problem);
    const id = `comments-${randomUUID()}`;
    context.emit({ type: "tool_started", id, name: "ReviewComments", summary: `Adding review comments to ${copy.path}` });
    try {
      if (placed.length) await addReviewThreads(copy.path, copy.original, placed.map((placement) => ({ range: placement.anchor!, text: placement.text, author: "agent" as const })));
      context.emit({ type: "comments_added", path: copy.path, count: placed.length });
      context.emit({
        type: "tool_finished", id, status: dropped.length ? "error" : "ok",
        result: `${plural(placed.length, "comment")} added${dropped.length ? `; ${dropped.length} could not be placed` : ""}`,
        ...(dropped.length ? { detail: dropped.map((placement) => `${describePlacement(copy.original, placement)}\n\n${placement.text}`).join("\n\n—\n\n") } : {}),
      });
    } catch (error) {
      context.emit({ type: "tool_finished", id, status: "error", result: `Could not save the comments: ${error instanceof Error ? error.message : "unknown error"}`, detail: placed.map((placement) => placement.text).join("\n\n—\n\n") });
    }
  }
  return null;
}

/** Comments first: while some must be fixed, suggested edits wait, so the model can still revise them. */
async function finishPass(context: ToolContext, options: { final: boolean }): Promise<string | null> {
  const feedback = await finishComments(context, options);
  if (feedback) return feedback;
  return finishSuggestedEdits(context);
}

const instructions = `
# Leaving review comments

You review a document by writing comments into it, directly beneath the paragraphs they are about, with the LeaveComment tool, and you may propose concrete rewrites with SuggestEdit. When you finish your reply, Libera turns each comment into a review comment attached to the paragraph above it. The user then works through them one by one in the Comments panel: they can reply, resolve them, or have Agentic Review address them. Comments never change the file, so you can leave them in any permission mode, including Read Only.

## Comment syntax

A comment is a line \`:::comment\`, the comment itself, and a line \`:::\`, placed right after the last line of the paragraph it is about:

\`\`\`markdown
The Q3 budget is 40k, up from 25k last year.

:::comment
This contradicts the 35k in the summary table. Which figure is right?
:::

The next paragraph…
\`\`\`

- A comment attaches to the block directly above it: a paragraph, heading, list item, table, code or math block. To comment on a list item, put the comment right after that item. To comment on a whole list, put the comment after the paragraph that introduces it.
- Never put a comment inside a paragraph, table, code block or math block; put it after the block's last line.
- One point per comment. For several points about one paragraph, put several comment blocks beneath it.
- Comments are Markdown, but must not contain a line that is only \`:::\`.

## How to work

1. Read the whole document first; read long files in windows. Read other files only when the review needs them (for example, to check a claim against a source).
2. Add comments with LeaveComment. It works like Edit, but only on your review copy of the document. old_string is text from the document, usually the last line of the paragraph (enough to be unique). new_string is that same text followed by your comment block(s). Everything other than comment blocks must stay exactly as it is.
   For example: old_string \`up from 25k last year.\`, new_string \`up from 25k last year.\\n\\n:::comment\\nThis contradicts the 35k in the summary table.\\n:::\`
3. Comment on different places with separate LeaveComment calls; make them in one reply when you can.
4. To change, move or remove a comment, call LeaveComment with old_string containing the comment block as LeaveComment showed it, and new_string with it changed, moved or removed.
5. When you finish your reply, Libera checks every comment. If any is misplaced, it tells you which and why; fix them with LeaveComment and finish again.

## Suggesting concrete rewrites

When the fix is clear and local (a wrong figure, a broken sentence, an unsupported claim that should be softened), you may propose the rewrite itself with SuggestEdit instead of, or as well as, describing it in a comment. The user sees the change in the editor and accepts or rejects it with one click; the file never changes until they do.

- before is exact text from the document (within one paragraph, or whole paragraphs) and must occur once; after is your replacement; reason says why in a sentence or two.
- Pass comment to add a review comment on the same passage when the reasoning needs more room. Do not also leave a LeaveComment comment about the same point.
- Keep suggestions small and in the document's own style. Suggest only what the user asked about; for open questions or matters of judgement, leave a comment instead.

## What makes a good comment

- Be specific and actionable: say what is wrong, missing or unclear, and suggest a fix or ask the question that would resolve it. Quote the exact words when the problem is a phrase.
- Put substance first: errors, unsupported or contradictory claims, gaps in reasoning, unclear structure. Comment on style only when it gets in the way, or when the user asks.
- Follow the user's focus when they give one (for example "only check the maths"), and comment only on the files they asked about.
- Do not comment on every paragraph, and do not leave praise unless the user asks for it.
- Do not edit the document while reviewing unless the user also asked you to edit it.

## Your reply

After commenting, reply briefly: how many comments and suggested edits you left in which file, and the two or three most important points. Do not repeat every comment; the user reads them in the Comments panel.
`;

export const leaveReviewCommentsSkill: AgentSkill = {
  name: NAME,
  description: "Review a Markdown or LaTeX document by leaving comments on its paragraphs (and, where the fix is clear, suggested edits), which the user works through in the Comments panel. Use only when the user asks you to review a document, give feedback on it, or leave or add comments; not to answer questions about a document or to edit it.",
  instructions,
  tools: [leaveCommentTool, suggestEditTool],
  finishPass,
  unavailable: (context) => context.notebook && isSharedNotebookPath(context.notebook) ? `The current notebook "${context.notebook}" is shared. ${SHARED_UNAVAILABLE}` : null,
};
