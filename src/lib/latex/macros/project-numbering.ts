import { latexParser as parser } from "../codemirror/latex-parser";
import { resolveRelativeNotebookPath } from "../project";
import { bodyStartOf, readLatexDefinitions, readLatexInputs, type LatexDefinitions } from "./definitions";
import { computeLatexNumbering, type LabelTarget, type NumberingStart } from "./numbering";

/* Where a chapter's counters start (docs/latex-visual-editor-plan.md §7.7): the
 * main file's body is numbered up to the `\input` or `\include` of the
 * chapter, with the files it includes before that in place, so a chapter's
 * first section is "3", not "1". */

/** Files read at most, to keep the work bounded on large projects. */
const MAX_FILES = 40;

export async function chapterNumberingStart(
  filePath: string,
  rootPath: string,
  readText: (path: string) => Promise<string>,
  baseDefinitions?: LatexDefinitions,
): Promise<NumberingStart | null> {
  if (filePath === rootPath) return null;
  const rootText = await readText(rootPath);
  if (!rootText) return null;
  const defs = baseDefinitions ?? readLatexDefinitions(rootText);
  let reads = 0;
  /**
   * The body with its includes expanded (and theirs, a few levels deep): up to the chapter when `stop` is its path
   * (`found` then says it was reached), or all of it.
   */
  const expand = async (text: string, from: number, depth: number, stop: string | null = filePath): Promise<{ text: string; found: boolean }> => {
    let out = "";
    let at = from;
    for (const input of readLatexInputs(text)) {
      if (input.pos < from) continue;
      const name = /\.(?:tex|ltx)$/i.test(input.path) ? input.path : `${input.path}.tex`;
      // TeX finds every input from the directory it runs in: the main file's, whichever file names it.
      const resolved = resolveRelativeNotebookPath(rootPath, name);
      out += text.slice(at, input.pos);
      at = input.pos + text.slice(input.pos).indexOf("}") + 1;
      if (stop !== null && resolved === stop) return { text: out, found: true };
      if (!resolved || depth >= 3 || reads >= MAX_FILES) continue;
      reads++;
      const included = await readText(resolved);
      const inner = await expand(included, 0, depth + 1, stop);
      out += `\n${inner.text}\n`;
      if (inner.found) return { text: out, found: true };
    }
    return { text: out + text.slice(at), found: false };
  };
  const prefix = await expand(rootText, bodyStartOf(rootText), 0);
  if (!prefix.found) return null;
  const tree = parser.parse(prefix.text);
  const numbering = computeLatexNumbering(tree, (from, to) => prefix.text.slice(from, to), defs);
  // The whole document, for the numbers of labels in the other chapters (a chapter's `\cref{thm:spanner}` to another).
  reads = 0;
  const whole = await expand(rootText, bodyStartOf(rootText), 0, null);
  const all = computeLatexNumbering(parser.parse(whole.text), (from, to) => whole.text.slice(from, to), defs);
  const labels = [...all.labels].map(([key, target]): [string, LabelTarget] => [key, { ...target, pos: -1 }]);
  return { counters: numbering.counters, appendix: numbering.appendix, mainmatter: numbering.mainmatter, labels };
}
