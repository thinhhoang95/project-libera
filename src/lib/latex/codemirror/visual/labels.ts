import { Facet, type EditorState } from "@codemirror/state";
import { VISUAL_ENGLISH } from "./labels-en";

/* The editor's own words in the Visual mode: tooltips, placeholders' notes, menus and prompts. The text of the
 * document itself (figure and theorem names, the abstract's heading) is not here: it follows the document's language.
 *
 * Widgets are not React, so the React side installs a translator with the `visualTranslator` facet. Keys are
 * `<group>.<key>`, with the groups `widgets`, `tableEdit` and `drawingPreview` (the message namespaces
 * `lib.latex.codemirror.visual.*`). Without one (tests, headless use) the English in `labels-en.ts` is shown. */

export type VisualTranslatorValues = Record<string, string | number>;
export type VisualTranslator = (key: string, values?: VisualTranslatorValues) => string;

export const visualTranslator = Facet.define<VisualTranslator, VisualTranslator | null>({ combine: (values) => values.at(-1) ?? null });

/** Fills `{name}` arguments and the plain `{n, plural, =0 {…} one {…} other {…}}` messages of `labels-en.ts`. */
export function formatEnglish(template: string, values: VisualTranslatorValues = {}) {
  return template
    .replace(/\{(\w+), plural,((?:\s*(?:=\d+|\w+)\s*\{[^{}]*\})+)\s*\}/g, (_match, key: string, branches: string) => {
      const count = Number(values[key]);
      const options = [...branches.matchAll(/(=\d+|\w+)\s*\{([^{}]*)\}/g)];
      const chosen = options.find((option) => option[1] === `=${count}`) ?? options.find((option) => option[1] === (count === 1 ? "one" : "other")) ?? options.find((option) => option[1] === "other");
      return (chosen?.[2] ?? "").replace(/#/g, String(count));
    })
    .replace(/\{(\w+)\}/g, (_match, key: string) => String(values[key] ?? ""))
    .replace(/'([{}])'/g, "$1");
}

export const englishText: VisualTranslator = (key, values) => formatEnglish(VISUAL_ENGLISH[key] ?? key, values);

/** The translator to use for an editor's state. */
export function visualText(state: EditorState): VisualTranslator {
  return state.facet(visualTranslator) ?? englishText;
}
