import { markdownLineEnding } from "micromark-util-character";
import type { Code, Construct, State, TokenizeContext, TokenType } from "micromark-util-types";
import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import type { Root } from "mdast";
import type { Plugin } from "unified";
import { CITATION_MAX_LENGTH, citationFrontMatterEnd, parseCitationContent } from "./references/citation-syntax";
import type { Citation } from "./references/types";

// Bracketed citations, `[see @key, p. 12]`, as a micromark text construct.
// Extension constructs run before micromark's own, so this one is tried at
// `[` ahead of `labelStartLink` and falls back cleanly (nok) whenever the
// bracket is not a citation: links, references, images and footnotes then
// parse exactly as before. Code, math and HTML never reach it, because their
// constructs claim the text first. The grammar is the one in
// references/citation-syntax.ts, and the two are tested against the same
// table (CITATION_SYNTAX_CASES) for identical results and offsets.

/** mdast leaf for a citation. `value` is the source text, so `toString` (e.g. image alt text) keeps it. */
export type LiberaCitationNode = {
  type: "liberaCitation";
  citation: Citation;
  value: string;
  position?: Root["position"];
  data: { hName: "libera-cite"; hProperties: { "data-citation": string } };
};

const CITATION = "liberaCitation" as TokenType;
const MARKER = "liberaCitationMarker" as TokenType;
const DATA = "liberaCitationData" as TokenType;

function isAsciiPunctuation(code: Code) {
  return code !== null && ((code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126));
}

function tokenizeCitation(this: TokenizeContext, effects: Parameters<Construct["tokenize"]>[0], ok: State, nok: State): State {
  const last = this.events[this.events.length - 1];
  // A `[…]:` at the start of a line would be a link reference definition.
  const atLineStart = this.previous === null || markdownLineEnding(this.previous) || (last?.[0] === "exit" && last[1].type === "linePrefix");
  let start = 0;
  let depth = 0;
  let lineBreaks = 0;
  let content = "";
  let inData = false;

  const data = (code: Code) => {
    if (!inData) { effects.enter(DATA); inData = true; }
    content += code === -2 ? "\t" : code === -1 ? "" : String.fromCharCode(code as number);
    effects.consume(code);
  };
  const endData = () => {
    if (inData) { effects.exit(DATA); inData = false; }
  };

  const after: State = (code) => {
    if (code === 40 || code === 91) return nok(code);
    if (code === 58 && atLineStart) return nok(code);
    if (!parseCitationContent(content)) return nok(code);
    effects.exit(CITATION);
    return ok(code);
  };

  const inside: State = (code) => {
    if (code === null || this.now().offset - start >= CITATION_MAX_LENGTH) return nok(code);
    if (markdownLineEnding(code)) {
      if (++lineBreaks > 1) return nok(code);
      endData();
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      content += "\n";
      return inside;
    }
    if (code === 93 && depth === 0) {
      endData();
      effects.enter(MARKER);
      effects.consume(code);
      effects.exit(MARKER);
      return after;
    }
    if (code === 91) depth += 1;
    else if (code === 93) depth -= 1;
    data(code);
    return code === 92 ? escape : inside;
  };

  const escape: State = (code) => {
    if (!isAsciiPunctuation(code)) return inside(code);
    data(code);
    return inside;
  };

  return (code) => {
    if (code !== 91 || this.previous === 33) return nok(code);
    start = this.now().offset;
    effects.enter(CITATION);
    effects.enter(MARKER);
    effects.consume(code);
    effects.exit(MARKER);
    return inside;
  };
}

const citationConstruct: Construct = { name: "liberaCitation", tokenize: tokenizeCitation };

const fromMarkdown: FromMarkdownExtension = {
  enter: {
    [CITATION](token) {
      const raw = this.sliceSerialize(token);
      const parsed = parseCitationContent(raw.slice(1, -1));
      const citation: Citation = { items: parsed?.items ?? [], raw };
      const node: LiberaCitationNode = {
        type: "liberaCitation",
        citation,
        value: raw,
        data: { hName: "libera-cite", hProperties: { "data-citation": JSON.stringify(citation) } },
      };
      this.enter(node as never, token);
    },
  },
  exit: {
    [CITATION](token) {
      this.exit(token);
    },
  },
};

type TreeNode = {
  type: string;
  value?: string;
  children?: TreeNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  citation?: Citation;
  data?: LiberaCitationNode["data"];
};

/**
 * Settle citations against the whole source: `raw` becomes the exact source
 * slice (container prefixes included on multi-line tokens), and citations in
 * link text or YAML front matter turn back into text, matching scanCitations.
 */
function finishCitations(tree: TreeNode, source: string | null) {
  const frontMatterEnd = source ? citationFrontMatterEnd(source) : 0;
  const visit = (parent: TreeNode, inLink: boolean) => {
    const children = parent.children;
    if (!children) return;
    let demoted = false;
    children.forEach((child, index) => {
      if (child.type !== "liberaCitation") {
        visit(child, inLink || child.type === "link" || child.type === "linkReference");
        return;
      }
      const start = child.position?.start.offset ?? 0;
      const end = child.position?.end.offset ?? 0;
      const raw = source ? source.slice(start, end) : child.value ?? "";
      if (inLink || start < frontMatterEnd) {
        children[index] = { type: "text", value: raw, position: child.position };
        demoted = true;
      } else if (source && child.citation && child.data) {
        child.citation.raw = raw;
        child.value = raw;
        child.data.hProperties["data-citation"] = JSON.stringify(child.citation);
      }
    });
    if (!demoted) return;
    const merged: TreeNode[] = [];
    for (const child of children) {
      const previous = merged[merged.length - 1];
      if (previous?.type === "text" && child.type === "text" && previous.position && child.position) {
        previous.value = `${previous.value ?? ""}${child.value ?? ""}`;
        previous.position = { start: previous.position.start, end: child.position.end };
      } else merged.push(child.type === "text" ? { ...child } : child);
    }
    parent.children = merged;
  };
  visit(tree, false);
}

/**
 * Parse `[@key]` citations into `liberaCitation` leaves rendered as
 * `<libera-cite data-citation="…">`. Use after remark-parse so the source is
 * available to settle `raw`; otherwise the source is read from the file.
 */
export const remarkCitations: Plugin<[], Root> = function () {
  const data = this.data();
  (data.micromarkExtensions ??= []).push({ text: { 91: citationConstruct } });
  (data.fromMarkdownExtensions ??= []).push(fromMarkdown);
  const parse = this.parser;
  if (parse) {
    this.parser = (document, file) => {
      const tree = parse(document, file);
      finishCitations(tree as unknown as TreeNode, String(document));
      return tree;
    };
    return;
  }
  return (tree, file) => {
    finishCitations(tree as unknown as TreeNode, typeof file.value === "string" ? file.value : null);
  };
};
