import { factorySpace } from 'micromark-factory-space';
import type { Plugin } from 'unified';
import type { Root } from 'mdast';
import type { Construct, State, TokenType } from 'micromark-util-types';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import { mathMarkerPairs, escapedAt, type MathMarkerSettings, type MathMarkerPair } from './math-markers';
import 'mdast-util-math';

// Tokenize before Markdown escapes/links/emphasis can consume a delimiter or LaTeX.
// Code spans, fenced code and indented code keep their native Markdown precedence.
export const remarkMathMarkers: Plugin<[MathMarkerSettings?], Root> = function (settings = {}) {
  const data = this.data();
  const pairs = mathMarkerPairs(settings);
  const extension: { text: Record<number, Construct[]>; flow: Record<number, Construct[]> } = { text: {}, flow: {} };
  const fromMarkdown: FromMarkdownExtension = { enter: {}, exit: {} };
  pairs.forEach((pair, index) => {
    const name = `liberaMath${index}` as TokenType;
    const construct = mathConstruct(pair, name, pairs);
    const group = pair.display ? extension.flow : extension.text;
    (group[pair.open.charCodeAt(0)] ??= []).push(construct);
    fromMarkdown.enter![name] = function (token) {
      const raw = this.sliceSerialize(token);
      const value = raw.slice(pair.open.length, -pair.close.length).trim();
      this.enter({ type: pair.display ? 'math' : 'inlineMath', value,
        data: { hName: 'code', hProperties: { className: ['language-math', pair.display ? 'math-display' : 'math-inline'] }, hChildren: [{ type: 'text', value }] },
      }, token);
    };
    fromMarkdown.exit![name] = function (token) { this.exit(token); };
  });
  (data.micromarkExtensions ??= []).push(extension);
  (data.fromMarkdownExtensions ??= []).push(fromMarkdown);
};

function mathConstruct(pair: MathMarkerPair, name: TokenType, pairs: MathMarkerPair[]): Construct {
  return {
    name,
    concrete: pair.display,
    tokenize(effects, ok, nok) {
      const interrupt = this.interrupt;
      let opening = 0;
      let body = '';
      const finish: State = code => {
        if (pair.display && code !== null && code !== -5 && code !== -4 && code !== -3 && code !== 32 && code !== -2) return nok(code);
        effects.exit(name);
        return pair.display ? factorySpace(effects, ok, "whitespace")(code) : ok(code);
      };
      const content: State = code => {
        if (code === null || (!pair.display && code < 0 && code !== -2 && code !== -1)) return nok(code);
        // A shorter opener cannot steal a longer configured marker.
        if (!body && pairs.some(other => other.open.startsWith(pair.open) && other.open.length > pair.open.length && other.open.charCodeAt(pair.open.length) === code)) return nok(code);
        body += code < 0 ? (code === -2 ? '\t' : code === -1 ? '' : '\n') : String.fromCharCode(code);
        if (code === -5 || code === -4 || code === -3) {
          effects.enter('lineEnding'); effects.consume(code); effects.exit('lineEnding');
        } else { effects.enter("liberaMathData" as TokenType); effects.consume(code); effects.exit("liberaMathData" as TokenType); }
        if (body.endsWith(pair.close) && !escapedAt(body, body.length - pair.close.length)) {
          if (!body.slice(0, -pair.close.length).trim()) return nok;
          if (!pair.display) return finish;
          return effects.check({ partial: true, tokenize(checkEffects, yes, no) {
            const tail: State = next => {
              return next === null || next === -5 || next === -4 || next === -3 ? yes(next) : no(next);
            };
            return factorySpace(checkEffects, tail, "whitespace");
          } }, finish, nok);
        }
        return content;
      };
      const start: State = code => {
        if (opening === pair.open.length) return interrupt ? ok(code) : content(code);
        if (code !== pair.open.charCodeAt(opening)) return nok(code);
        if (opening === 0) effects.enter(name);
        opening++;
        effects.enter("liberaMathData" as TokenType);
        effects.consume(code);
        effects.exit("liberaMathData" as TokenType);
        return start;
      };
      return start;
    },
  };
}
