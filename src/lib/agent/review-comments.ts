import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { textChange, type ReviewRange } from "@/lib/markdown-review";

// The agent leaves review comments the way a person marks up a draft: it
// writes ":::comment" blocks into the document, directly beneath the paragraph
// each one is about. Those blocks live only in a review copy. Compiling the
// copy maps each block back to the original text and anchors it to the block
// above it, or explains what is wrong so the model can fix it.

/** A comment in the review copy; `offset` is where it sits in the original text. */
export type DraftComment = { offset: number; text: string };

export type CommentPlacement = DraftComment & { number: number; anchor?: ReviewRange; problem?: string };

export class CommentSyntaxError extends Error {}

const OPEN = /^[ \t]*:::[ \t]*comment\b[ \t]*(.*?)[ \t]*$/i;
const CLOSE = /^[ \t]*:::[ \t]*$/;
const MAX_COMMENT_CHARS = 20_000;

/** Split a review copy into its document text and its comment blocks, in order. */
export function parseReviewCopy(copy: string): { segments: string[]; comments: string[] } {
  const lines = copy.split(/\r?\n/);
  const segments: string[] = [];
  const comments: string[] = [];
  let text: string[] = [];
  let body: string[] | null = null;
  let opened = 0;
  const finish = (lineNumber: number) => {
    const comment = body!.join("\n").trim();
    if (!comment) throw new CommentSyntaxError(`The comment opened on line ${lineNumber} of your review copy is empty. Write the comment between ":::comment" and ":::", or remove the block.`);
    if (comment.length > MAX_COMMENT_CHARS) throw new CommentSyntaxError(`The comment opened on line ${lineNumber} is too long (${comment.length.toLocaleString("en")} characters). Keep comments under ${MAX_COMMENT_CHARS.toLocaleString("en")} characters.`);
    segments.push(text.join("\n"));
    comments.push(comment);
    text = [];
    body = null;
  };
  lines.forEach((line, index) => {
    const open = OPEN.exec(line);
    if (body) {
      if (open) throw new CommentSyntaxError(`The comment opened on line ${opened} is not closed before the next ":::comment" on line ${index + 1}. End every comment with a line containing only ":::".`);
      if (CLOSE.test(line)) finish(opened);
      else body.push(line);
      return;
    }
    if (open) {
      opened = index + 1;
      const rest = open[1];
      // A one-line form, ":::comment Text :::", is unambiguous; accept it.
      if (/:::$/.test(rest)) { body = [rest.replace(/[ \t]*:::$/, "")]; finish(opened); }
      else body = rest ? [rest] : [];
      return;
    }
    if (/:::[ \t]*comment\b/i.test(line)) {
      throw new CommentSyntaxError(`":::comment" must start its own line, but line ${index + 1} of your review copy has text before it: “${line.trim().slice(0, 80)}”. Put the comment block on the lines after the paragraph.`);
    }
    text.push(line);
  });
  if (body) throw new CommentSyntaxError(`The comment opened on line ${opened} of your review copy has no closing ":::" line. End every comment with a line containing only ":::".`);
  segments.push(text.join("\n"));
  return { segments, comments };
}

const isSpace = (character: string) => /\s/.test(character);
// One character to one character, so offsets survive the comparison.
const sameCharacter = (left: string, right: string) => left === right
  || (/[‘’‚‛']/.test(left) && /[‘’‚‛']/.test(right))
  || (/[“”„‟"]/.test(left) && /[“”„‟"]/.test(right));

function lineAt(text: string, offset: number) {
  let line = 1;
  for (let index = text.indexOf("\n"); index !== -1 && index < offset; index = text.indexOf("\n", index + 1)) line++;
  return line;
}

/** The line around `offset`, or a window of it near `offset` when the line is long. */
function excerpt(text: string, offset: number) {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  let start = lineStart;
  if (offset - start > 40) {
    start = offset - 30;
    while (start < offset && !isSpace(text[start - 1])) start++;
  }
  const lineEnd = text.indexOf("\n", offset);
  const line = text.slice(start, lineEnd < 0 ? text.length : lineEnd).trim();
  if (!line) return "the end of the document";
  return `“${start > lineStart ? "…" : ""}${line.length > 70 ? `${line.slice(0, 70)}…` : line}”`;
}

/**
 * Map the comments of a review copy back to offsets in `original`. Whitespace
 * and quote style may differ; any other change to the document text is an
 * error, because comments must never alter what they comment on.
 */
export function locateComments(original: string, copy: string): DraftComment[] {
  const { segments, comments } = parseReviewCopy(copy);
  const located: DraftComment[] = [];
  let position = 0;
  const skipSpace = () => { while (position < original.length && isSpace(original[position])) position++; };
  segments.forEach((segment, index) => {
    for (let cursor = 0; cursor < segment.length; cursor++) {
      const character = segment[cursor];
      if (isSpace(character)) continue;
      skipSpace();
      if (position >= original.length || !sameCharacter(original[position], character)) {
        const where = position >= original.length ? "after the end of the document" : `on line ${lineAt(original, position)}, where the document has ${excerpt(original, position)}`;
        throw new CommentSyntaxError(`Only :::comment blocks may be added, moved or removed; the rest of the text must stay exactly as it is. Your new_string changes the document ${where}, but your text has ${excerpt(segment, cursor)}. Repeat the document text exactly and add only comment blocks.`);
      }
      position++;
    }
    if (index < comments.length) located.push({ offset: position, text: comments[index] });
  });
  skipSpace();
  if (position < original.length) {
    throw new CommentSyntaxError(`Only :::comment blocks may be added, moved or removed, but your new_string leaves out document text from line ${lineAt(original, position)} on: ${excerpt(original, position)}. Repeat the document text exactly and add only comment blocks.`);
  }
  return located;
}

/** The review copy the model works on: the original text with each comment block inserted at its offset. */
export function renderReviewCopy(original: string, comments: DraftComment[]): string {
  const sorted = comments.map((comment, index) => ({ comment, index })).sort((left, right) => left.comment.offset - right.comment.offset || left.index - right.index);
  let copy = "";
  let cursor = 0;
  for (const { comment } of sorted) {
    copy += original.slice(cursor, comment.offset);
    copy += `${comment.offset > 0 ? "\n\n" : ""}:::comment\n${comment.text}\n:::`;
    if (comment.offset < original.length && original[comment.offset] !== "\n" && original[comment.offset] !== "\r") copy += "\n";
    cursor = comment.offset;
  }
  return copy + original.slice(cursor);
}

/** Move comment offsets onto a newer version of the original, e.g. after the agent edited the file. */
export function rebaseComments(comments: DraftComment[], before: string, after: string): DraftComment[] {
  if (before === after) return comments;
  const change = textChange(before, after);
  return comments.map((comment) => ({
    ...comment,
    offset: comment.offset <= change.start ? comment.offset : comment.offset >= change.oldEnd ? comment.offset + change.delta : change.newEnd,
  }));
}

type Block = ReviewRange & { type: string; leaf: boolean; depth: number };
type MarkdownNode = { type: string; children?: MarkdownNode[]; position?: { start?: { offset?: number }; end?: { offset?: number } } };

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const CONTAINERS = new Set(["blockquote", "list", "listItem", "footnoteDefinition"]);
const LEAVES = new Set(["paragraph", "heading", "code", "math", "table", "html", "thematicBreak", "definition", "yaml", "toml"]);
const BLOCK_NAMES: Record<string, string> = {
  paragraph: "paragraph", heading: "heading", code: "code block", math: "math block", table: "table", html: "HTML block",
  definition: "link definition", yaml: "front matter", toml: "front matter", thematicBreak: "rule",
};

function markdownBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const visit = (node: MarkdownNode, depth: number) => {
    for (const child of node.children ?? []) {
      const start = child.position?.start?.offset;
      const end = child.position?.end?.offset;
      if (start === undefined || end === undefined) continue;
      if (LEAVES.has(child.type)) blocks.push({ start, end, type: child.type, leaf: true, depth });
      else if (CONTAINERS.has(child.type)) { blocks.push({ start, end, type: child.type, leaf: false, depth }); visit(child, depth + 1); }
    }
  };
  visit(parser.parse(text) as MarkdownNode, 0);
  return blocks;
}

/** LaTeX and plain text: paragraphs are separated by blank lines. */
function plainBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const separator = /\n[ \t]*\r?\n/g;
  let cursor = 0;
  for (const match of [...text.matchAll(separator), null]) {
    const end = match ? match.index : text.length;
    const raw = text.slice(cursor, end);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) blocks.push({ start: cursor + lead, end: cursor + lead + trimmed.length, type: "paragraph", leaf: true, depth: 0 });
    if (match) cursor = match.index + match[0].length;
  }
  return blocks;
}

function describeLines(text: string, block: ReviewRange) {
  const first = lineAt(text, block.start);
  const last = lineAt(text, Math.max(block.start, block.end - 1));
  return first === last ? `line ${first}` : `lines ${first}-${last}`;
}

/**
 * Anchor each comment to the block that ends directly above it. A comment may
 * sit between blocks, or between the items of a list or quote, but never
 * inside a paragraph, heading, table, code or math block.
 */
export function placeComments(original: string, comments: DraftComment[], fileType: "markdown" | "latex"): CommentPlacement[] {
  const blocks = fileType === "markdown" ? markdownBlocks(original) : plainBlocks(original);
  const ordered = comments.map((comment, index) => ({ comment, index })).sort((left, right) => left.comment.offset - right.comment.offset || left.index - right.index);
  return ordered.map(({ comment }, index): CommentPlacement => {
    const number = index + 1;
    const offset = comment.offset;
    const inside = blocks.find((block) => block.leaf && block.start < offset && offset < block.end);
    if (inside) {
      const name = BLOCK_NAMES[inside.type] ?? "block";
      return { ...comment, number, problem: `is inside the ${name} on ${describeLines(original, inside)}. Move it below the ${name}'s last line (line ${lineAt(original, inside.end - 1)}).` };
    }
    // The blocks ending closest above. A comment after a list's last item is
    // about that item, as after any other item; otherwise take the outermost.
    const above = blocks.filter((block) => block.end <= offset && !original.slice(block.end, offset).trim());
    const end = Math.max(...above.map((block) => block.end));
    const closest = above.filter((block) => block.end === end);
    const items = closest.filter((block) => block.type === "listItem").sort((left, right) => right.depth - left.depth);
    const anchor = items[0] ?? closest.sort((left, right) => left.start - right.start)[0];
    if (!anchor) return { ...comment, number, problem: "has no paragraph directly above it. Put each comment directly beneath the paragraph it is about; put remarks about the whole document in your reply instead." };
    return { ...comment, number, anchor: { start: anchor.start, end: anchor.end } };
  });
}

/** One line about where a comment attaches, for tool results. */
export function describePlacement(original: string, placement: CommentPlacement) {
  const opening = `“${placement.text.replace(/\s+/g, " ").slice(0, 60)}${placement.text.length > 60 ? "…" : ""}”`;
  if (placement.problem) return `Comment ${placement.number} (${opening}) ${placement.problem}`;
  return `Comment ${placement.number} (${opening}) attaches to ${describeLines(original, placement.anchor!)}: ${excerpt(original, placement.anchor!.start)}`;
}
