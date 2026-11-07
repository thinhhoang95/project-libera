import type { SyntaxNode, Tree } from "@lezer/common";
import { hashString } from "../../macros/core";
import type { LatexDefinitions } from "./definitions";

/* Numbers as the PDF will show them (docs/latex-visual-editor-plan.md §7.7):
 * one pass over the headings, equations, figures, tables, theorems,
 * footnotes and counter commands of the tree, in document order, with each
 * \label bound to the last number stepped before it in its environment. */

export type NumberingKind = "section" | "equation" | "figure" | "table" | "theorem" | "footnote" | "item";

export type NumberingEntry = {
  /** Start of the construct: the sectioning command, the environment, the footnote. */
  pos: number;
  kind: NumberingKind;
  number: string | null;
  /** Equation numbers per row of an `align`-like environment (null: not numbered). */
  rows?: Array<string | null>;
  level?: number;
  /** Theorem environment name. */
  env?: string;
};

export type LabelTarget = { number: string; kind: NumberingKind | "page"; pos: number; env?: string; title?: string };

export type LatexNumbering = {
  entries: NumberingEntry[];
  labels: Map<string, LabelTarget>;
  /** Counter values at the end, to continue in a file included after this one. */
  counters: Record<string, number>;
  appendix: boolean;
  /** Equal for equal numbering, so number widgets can tell when to update. */
  fingerprint: string;
};

export const EMPTY_NUMBERING: LatexNumbering = { entries: [], labels: new Map(), counters: {}, appendix: false, fingerprint: "" };

const SECTION_LEVELS: Record<string, number> = { Book: -2, Part: -1, Chapter: 0, Section: 1, SubSection: 2, SubSubSection: 3, Paragraph: 4, SubParagraph: 5 };
const SECTION_COUNTERS = ["chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"];
const CHAPTER_CLASSES = /^(?:book|report|memoir|scrbook|scrreprt|amsbook|thesis|ut-thesis|mitthesis)$/;
const NUMBERED_EQUATIONS = new Set(["equation", "multline"]);
const NUMBERED_ROWS = new Set(["align", "alignat", "flalign", "gather", "eqnarray", "IEEEeqnarray", "subeqnarray"]);
const MATH_CONTAINERS = new Set(["DollarMath", "BracketMath", "ParenMath", "EquationEnvironment", "EquationArrayEnvironment", "Math"]);

function roman(value: number) {
  const numerals: Array<[number, string]> = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  for (const [amount, numeral] of numerals) while (value >= amount) { out += numeral; value -= amount; }
  return out;
}

function alph(value: number) {
  let out = "";
  for (let n = value; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(97 + ((n - 1) % 26)) + out;
  return out;
}

export function formatCounterValue(value: number, style: "arabic" | "roman" | "Roman" | "alph" | "Alph") {
  // Out of range for letters and numerals (TeX would stop with an error): shown as a number, without the work.
  if (style === "arabic" || !Number.isSafeInteger(value) || value < 1 || ((style === "roman" || style === "Roman") && value > 4999)) return String(value);
  if (style === "roman") return roman(value);
  if (style === "Roman") return roman(value).toUpperCase();
  if (style === "alph") return alph(value);
  return alph(value).toUpperCase();
}

type Read = (from: number, to: number) => string;

/** The name in `\begin{name}` of an environment node. */
export function environmentName(node: SyntaxNode, read: Read) {
  const begin = node.getChild("BeginEnv");
  const group = begin?.getChild("EnvNameGroup");
  if (!group) return null;
  return read(group.from + 1, group.to - 1).trim();
}

/** Splits an align-like body into rows at `\\` outside braces and nested environments. */
export function splitMathRows(body: string) {
  const rows: string[] = [];
  let depth = 0;
  let environments = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "%") { const end = body.indexOf("\n", i); i = end < 0 ? body.length : end; continue; }
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === "\\") {
      if (body.startsWith("\\begin", i)) environments++;
      else if (body.startsWith("\\end", i)) environments--;
      else if (body[i + 1] === "\\" && depth === 0 && environments === 0) {
        rows.push(body.slice(start, i));
        i++;
        // `\\[2pt]` and `\\*` belong to the break.
        if (body[i + 1] === "*") i++;
        const spacing = /^\s*\[[^\]]*\]/.exec(body.slice(i + 1));
        if (spacing) i += spacing[0].length;
        start = i + 1;
        continue;
      }
      i++;
    }
  }
  rows.push(body.slice(start));
  return rows;
}

function stripTitle(text: string) {
  return text.replace(/\\(?:textbf|textit|emph|texttt|textsc|mathrm|mbox|textrm|textsf)\s*/g, "").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

/** What a label after `\refstepcounter{counter}` refers to: `\refstepcounter{table}` makes a table label. */
function counterKind(counter: string): NumberingKind {
  if (SECTION_COUNTERS.includes(counter) || counter === "part") return "section";
  if (counter === "equation" || counter === "figure" || counter === "table" || counter === "footnote") return counter;
  if (/^enum(?:i|ii|iii|iv)$/.test(counter)) return "item";
  return "theorem";
}

export type NumberingStart = {
  /** Counter values where the file is included (a chapter of a main file). */
  counters: Record<string, number>;
  appendix: boolean;
};

export type NumberingOptions = { start?: NumberingStart | null };

/** Numbers the document. `read` gives the text of a range of the document `tree` belongs to. */
export function computeLatexNumbering(tree: Tree, read: Read, defs: LatexDefinitions, options: NumberingOptions = {}): LatexNumbering {
  const chapters = CHAPTER_CLASSES.test(defs.documentClass ?? "");
  const secnumdepth = chapters ? 2 : 3;
  const counters = new Map<string, number>(Object.entries(options.start?.counters ?? {}));
  const within = new Map<string, string>([...defs.counterWithin]);
  if (chapters) for (const name of ["equation", "figure", "table", "footnote"]) if (!within.has(name)) within.set(name, "chapter");
  for (const theorem of defs.theorems.values()) if (theorem.within && theorem.counter === theorem.name) within.set(theorem.name, theorem.within);
  for (let i = 1; i < SECTION_COUNTERS.length; i++) within.set(SECTION_COUNTERS[i], SECTION_COUNTERS[i - 1]);
  if (!chapters) within.delete("section");
  // A counter numbered within itself, directly or through others (`\numberwithin{equation}{equation}`), is
  // an error in TeX: drop the edge that closes the cycle so stepping and formatting stay finite.
  for (const counter of [...within.keys()]) {
    const seen = new Set<string>([counter]);
    for (let parent = within.get(counter); parent !== undefined; parent = within.get(parent)) {
      if (seen.has(parent)) { within.delete(counter); break; }
      seen.add(parent);
    }
  }
  let appendix = options.start?.appendix ?? false;

  const value = (name: string) => counters.get(name) ?? 0;
  const reset = (name: string) => {
    for (const [counter, parent] of within) if (parent === name) { counters.set(counter, 0); reset(counter); }
  };
  const step = (name: string) => { counters.set(name, value(name) + 1); reset(name); };
  const format = (name: string): string => {
    const own = name === "part" ? formatCounterValue(value(name), "Roman")
      : appendix && ((chapters && name === "chapter") || (!chapters && name === "section")) ? formatCounterValue(value(name), "Alph")
        : String(value(name));
    const parent = within.get(name);
    // \thesubsection is \thesection.\arabic{subsection}, and so on; a section in a chapter class starts with the chapter.
    if (!parent || (parent === "chapter" && !chapters)) return own;
    return `${format(parent)}.${own}`;
  };

  const entries: NumberingEntry[] = [];
  const labels = new Map<string, LabelTarget>();
  // The label target: sections set it globally; environments push a scope.
  let globalTarget: LabelTarget | null = null;
  const scopes: Array<{ node: number; target: LabelTarget | null }> = [];
  const currentTarget = () => scopes.length ? scopes[scopes.length - 1].target : globalTarget;
  const setTarget = (target: LabelTarget) => { if (scopes.length) scopes[scopes.length - 1].target = target; else globalTarget = target; };
  const lists: Array<{ enumerate: boolean; count: number; depth: number }> = [];

  const argumentText = (node: SyntaxNode, index = 0) => {
    let seen = 0;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === "TextArgument" || child.name === "ShortTextArgument") {
        if (seen++ === index) return read(child.from + 1, child.to - 1);
      }
    }
    return null;
  };

  tree.iterate({
    enter(ref) {
      const name = ref.name;
      const node = ref.node;
      if (name === "Comment" || name === "VerbatimEnvironment" || name === "TikzPictureEnvironment") return false;
      if (name in SECTION_LEVELS) {
        const command = node.getChild("SectioningCommand");
        if (!command) return;
        const level = SECTION_LEVELS[name];
        const ctrl = command.firstChild;
        const starred = !!ctrl && (read(ctrl.from, ctrl.to).endsWith("*") || read(ctrl.to, ctrl.to + 1) === "*");
        const counter = level === -1 ? "part" : level === -2 ? null : SECTION_COUNTERS[level];
        const titleNode = command.getChild("SectioningArgument");
        const title = titleNode ? stripTitle(read(titleNode.from + 1, titleNode.to - 1)) : "";
        let number: string | null = null;
        if (counter && !starred && (level <= secnumdepth || level < 0)) {
          step(counter);
          number = format(counter);
        }
        entries.push({ pos: command.from, kind: "section", number, level });
        if (number) setTarget({ number, kind: "section", pos: command.from, title });
        return;
      }
      if (name === "UnknownCommand") {
        const ctrl = node.firstChild;
        if (!ctrl || ctrl.name !== "CtrlSeq") return;
        const command = read(ctrl.from, ctrl.to);
        if (command === "\\appendix") {
          appendix = true;
          const top = chapters ? "chapter" : "section";
          counters.set(top, 0);
          reset(top);
        } else if (command === "\\setcounter" || command === "\\addtocounter") {
          const counter = argumentText(node, 0)?.trim();
          const amount = Number(argumentText(node, 1)?.trim());
          if (counter && Number.isFinite(amount)) counters.set(counter, command === "\\setcounter" ? amount : value(counter) + amount);
        } else if (command === "\\stepcounter" || command === "\\refstepcounter") {
          const counter = argumentText(node, 0)?.trim();
          if (counter) {
            step(counter);
            if (command === "\\refstepcounter") setTarget({ number: format(counter), kind: counterKind(counter), pos: node.from, env: counter });
          }
        } else if (command === "\\footnotemark") {
          // A bare \footnotemark steps the counter; one with [n] does not.
          if (read(ctrl.to, ctrl.to + 1) !== "[") step("footnote");
        }
        return;
      }
      if (name === "FootnoteCommand") {
        step("footnote");
        entries.push({ pos: node.from, kind: "footnote", number: format("footnote") });
        return;
      }
      if (name === "EquationEnvironment" || name === "EquationArrayEnvironment") {
        // Inner environments (aligned, cases, matrices) are part of an outer formula.
        for (let parent = node.parent; parent; parent = parent.parent) if (MATH_CONTAINERS.has(parent.name)) return false;
        const env = environmentName(node, read) ?? "";
        const base = env.replace(/\*$/, "");
        const starred = env.endsWith("*");
        const content = node.getChild("Content");
        const body = content ? read(content.from, content.to) : "";
        if (name === "EquationEnvironment") {
          let number: string | null = null;
          const tag = /\\tag\*?\s*\{([^}]*)\}/.exec(body);
          if (tag) number = tag[1];
          else if (NUMBERED_EQUATIONS.has(base) && !starred && !/\\(?:nonumber|notag)\b/.test(body)) { step("equation"); number = format("equation"); }
          entries.push({ pos: node.from, kind: "equation", number, rows: [number] });
          for (const match of body.matchAll(/\\label\s*\{([^}]*)\}/g)) if (number) labels.set(match[1].trim(), { number, kind: "equation", pos: node.from });
        } else {
          const numbered = NUMBERED_ROWS.has(base) && !starred;
          const rows = splitMathRows(body).map((row) => {
            const tag = /\\tag\*?\s*\{([^}]*)\}/.exec(row);
            let number: string | null = null;
            if (tag) number = tag[1];
            else if (numbered && !/\\(?:nonumber|notag)\b/.test(row)) { step("equation"); number = format("equation"); }
            for (const match of row.matchAll(/\\label\s*\{([^}]*)\}/g)) if (number) labels.set(match[1].trim(), { number, kind: "equation", pos: node.from });
            return number;
          });
          entries.push({ pos: node.from, kind: "equation", number: rows.find((row) => row !== null) ?? null, rows });
        }
        return false;
      }
      if (name === "DollarMath" || name === "BracketMath" || name === "ParenMath") return false;
      if (name === "FigureEnvironment" || name === "TableEnvironment") {
        // The number is stepped by \caption (below), so a \label before it refers to the section.
        scopes.push({ node: node.from, target: currentTarget() });
        return;
      }
      if (name === "Caption") {
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (parent.name !== "FigureEnvironment" && parent.name !== "TableEnvironment") continue;
          const env = environmentName(parent, read) ?? "";
          if (env === "subfigure" || env === "subtable") return false;
          const kind: NumberingKind = parent.name === "FigureEnvironment" ? "figure" : "table";
          step(kind);
          const number = format(kind);
          entries.push({ pos: parent.from, kind, number });
          setTarget({ number, kind, pos: parent.from });
          return false;
        }
        return false;
      }
      if (name === "Environment") {
        const env = environmentName(node, read) ?? "";
        scopes.push({ node: node.from, target: currentTarget() });
        const theorem = defs.theorems.get(env);
        if (theorem) {
          let number: string | null = null;
          if (theorem.numbered) {
            const counter = theorem.counter;
            step(counter);
            number = format(counter);
          }
          entries.push({ pos: node.from, kind: "theorem", number, env });
          if (number) setTarget({ number, kind: "theorem", pos: node.from, env });
        }
        return;
      }
      if (name === "ListEnvironment") {
        const env = environmentName(node, read) ?? "";
        lists.push({ enumerate: env === "enumerate", count: 0, depth: lists.filter((list) => list.enumerate).length + (env === "enumerate" ? 1 : 0) });
        scopes.push({ node: node.from, target: currentTarget() });
        return;
      }
      if (name === "Item") {
        const list = lists[lists.length - 1];
        if (list?.enumerate && !node.getChild("OptionalArgument")) {
          list.count++;
          const style = (["arabic", "alph", "roman", "Alph"] as const)[Math.min(3, list.depth - 1)];
          const number = formatCounterValue(list.count, style);
          setTarget({ number, kind: "item", pos: node.from });
        }
        return;
      }
      if (name === "Label") {
        const argument = node.getChild("LabelArgument");
        if (!argument) return false;
        const key = read(argument.from, argument.to).replace(/^\{|\}$/g, "").trim();
        const target = currentTarget();
        if (key && target) labels.set(key, target);
        return false;
      }
      return;
    },
    leave(ref) {
      const name = ref.name;
      if (name === "FigureEnvironment" || name === "TableEnvironment" || name === "Environment" || name === "ListEnvironment") {
        if (scopes.length && scopes[scopes.length - 1].node === ref.from) scopes.pop();
        if (name === "ListEnvironment") lists.pop();
      }
    },
  });

  const fingerprint = hashString(JSON.stringify([entries.map((entry) => [entry.pos, entry.number, entry.rows ?? null]), [...labels].map(([key, target]) => [key, target.number, target.kind])]));
  return { entries, labels, counters: Object.fromEntries(counters), appendix, fingerprint };
}

/** The entry of a construct starting at `pos`, by binary search. */
export function numberingEntryAt(numbering: LatexNumbering, pos: number, kind?: NumberingKind) {
  const { entries } = numbering;
  let low = 0;
  let high = entries.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const entry = entries[middle];
    if (entry.pos === pos) {
      // Several kinds can start at one position (a footnote in a heading is not one); look around for the kind.
      if (!kind || entry.kind === kind) return entry;
      for (let i = middle - 1; i >= 0 && entries[i].pos === pos; i--) if (entries[i].kind === kind) return entries[i];
      for (let i = middle + 1; i < entries.length && entries[i].pos === pos; i++) if (entries[i].kind === kind) return entries[i];
      return null;
    }
    if (entry.pos < pos) low = middle + 1; else high = middle - 1;
  }
  return null;
}

const CREF_NAMES: Record<string, [string, string, string, string]> = {
  section: ["section", "sections", "Section", "Sections"],
  equation: ["eq.", "eqs.", "Equation", "Equations"],
  figure: ["fig.", "figs.", "Figure", "Figures"],
  table: ["table", "tables", "Table", "Tables"],
  footnote: ["footnote", "footnotes", "Footnote", "Footnotes"],
  item: ["item", "items", "Item", "Items"],
  theorem: ["theorem", "theorems", "Theorem", "Theorems"],
};

/** What a reference command shows for a label: `\ref` "2.1", `\eqref` "(3)", `\cref` "fig. 1", `\Cref` "Figure 1", `\autoref` "Figure 1". */
export function referenceText(command: string, targets: Array<LabelTarget | null>, defs: LatexDefinitions, keys: string[]) {
  const name = command.replace(/^\\/, "").replace(/\*$/, "");
  const numbers = targets.map((target, index) => target?.number ?? `??${keys[index] ? "" : ""}`);
  const first = targets[0];
  if (name === "eqref") return numbers.map((number) => `(${number})`).join(", ");
  if (name === "pageref" || name === "vpageref") return targets.map((target) => (target?.kind === "page" ? target.number : "?")).join(", ");
  if (name === "nameref") return first?.title ?? numbers[0];
  if (name === "cref" || name === "Cref" || name === "autoref" || name === "Autoref" || name === "cpageref") {
    const capital = name !== "cref";
    const kind = first?.kind ?? "section";
    const theorem = kind === "theorem" && first?.env ? defs.theorems.get(first.env) : null;
    const custom = defs.crefNames.get(capital ? `${theorem?.name ?? kind}:capital` : theorem?.name ?? kind) ?? defs.crefNames.get(theorem?.name ?? kind);
    const builtin = CREF_NAMES[kind === "page" ? "section" : kind] ?? CREF_NAMES.section;
    const plural = targets.length > 1;
    let label = custom ? (plural ? custom.plural : custom.singular)
      : theorem ? theorem.title + (plural ? "s" : "")
        : name.startsWith("auto") || name.startsWith("Auto") ? builtin[2] : builtin[(capital ? 2 : 0) + (plural ? 1 : 0)];
    if (capital && label) label = label[0].toUpperCase() + label.slice(1);
    const list = kind === "equation" && !name.startsWith("auto") && !name.startsWith("Auto") ? numbers.map((number) => `(${number})`) : numbers;
    return `${label} ${list.length > 2 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list.join(" and ")}`;
  }
  return numbers.join(", ");
}
