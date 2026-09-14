import { factorySpace } from "micromark-factory-space";
import { markdownSpace } from "micromark-util-character";
import type { Construct, State, TokenType } from "micromark-util-types";
import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import type { Root } from "mdast";
import type { Plugin } from "unified";
import { MARKDOWN_HIGHLIGHT_COLORS } from "./markdown-colors";

// A container tokenizer keeps nested Markdown and original source offsets intact.
// Code fences and code spans retain their normal precedence.
export const remarkMarkdownBoxes: Plugin<[], Root> = function () {
  const data = this.data();
  const document: Record<number, Construct[]> = {};
  const fromMarkdown: FromMarkdownExtension = { enter: {}, exit: {} };
  for (const color of MARKDOWN_HIGHLIGHT_COLORS) {
    const name = `liberaBox${color.shortcut}` as TokenType;
    const construct: Construct = {
      name,
      tokenize(effects, ok, nok) {
        const container = this.containerState!;
        const after: State = (code) => {
          // Leave the existing >>> highlight grammar alone.
          if (code === 62) return nok(code);
          if (markdownSpace(code)) {
            effects.enter("blockQuotePrefixWhitespace");
            effects.consume(code);
            effects.exit("blockQuotePrefixWhitespace");
            effects.exit("blockQuotePrefix");
            return ok;
          }
          effects.exit("blockQuotePrefix");
          return ok(code);
        };
        const marker: State = (code) => {
          if (code !== 62) return nok(code);
          effects.consume(code);
          effects.exit("blockQuoteMarker");
          return after;
        };
        return (code) => {
          if (code === null || String.fromCharCode(code).toLowerCase() !== color.shortcut) return nok(code);
          if (!container.open) {
            effects.enter(name, { _container: true });
            container.open = true;
          }
          effects.enter("blockQuotePrefix");
          effects.enter("blockQuoteMarker");
          effects.consume(code);
          return marker;
        };
      },
      continuation: {
        tokenize(effects, ok, nok) {
          return factorySpace(effects, effects.attempt(construct, ok, nok), "linePrefix", 4);
        },
      },
      exit(effects) { effects.exit(name); },
    };
    document[color.shortcut.charCodeAt(0)] = [construct];
    document[color.shortcut.toUpperCase().charCodeAt(0)] = [construct];
    fromMarkdown.enter![name] = function (token) {
      this.enter({ type: "blockquote", children: [], data: { hProperties: { "data-box-color": color.shortcut } } }, token);
    };
    fromMarkdown.exit![name] = function (token) { this.exit(token); };
  }
  (data.micromarkExtensions ??= []).push({ document });
  (data.fromMarkdownExtensions ??= []).push(fromMarkdown);
};
