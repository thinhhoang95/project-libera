import { hashString, readGroup, readOptional } from "../../macros/core";

/* The document's own definitions, read the way TeX would read them, for the
 * Visual mode (docs/latex-visual-editor-plan.md §7). Only forms whose meaning
 * is certain are kept; anything else is listed as not rendered, and its uses
 * stay as source. */

/** An xparse argument: mandatory, optional (with a default), or a star. */
export type XparseArgument = { type: "m" } | { type: "o" } | { type: "O"; default: string } | { type: "s" };

export type LatexMacro = {
  name: string;
  /** Arguments in total, the optional first one included. */
  arity: number;
  /** Default of the optional first argument (`\newcommand\x[2][default]`), or undefined when there is none. */
  optional?: string;
  /** xparse argument types, replacing `arity`/`optional`. */
  spec?: XparseArgument[];
  body: string;
  /** Only meaningful in math (`\DeclareMathOperator`). */
  mathOnly?: boolean;
  /** Where it was defined: -1 before the document body (preamble, other files), else its position in the open file. */
  pos: number;
  file?: string;
  fingerprint: string;
};

export type LatexEnvironmentDefinition = {
  name: string;
  arity: number;
  optional?: string;
  spec?: XparseArgument[];
  begin: string;
  end: string;
  pos: number;
};

export type TheoremStyle = "plain" | "definition" | "remark";
export type LatexTheoremDefinition = {
  name: string;
  title: string;
  /** The counter it steps: its own name, or the environment it shares one with. */
  counter: string;
  /** Counter it is reset by and numbered within (`[section]`). */
  within?: string;
  numbered: boolean;
  style: TheoremStyle;
};

export type LatexDefinitionNote = { pos: number; file?: string; name: string; message: string };

export type LatexDefinitions = {
  /** Every definition of each name, in reading order (later ones win from where they are). */
  macros: Map<string, LatexMacro[]>;
  environments: Map<string, LatexEnvironmentDefinition>;
  theorems: Map<string, LatexTheoremDefinition>;
  /** `\newcounter{c}[within]` and `\numberwithin{c}{within}`. */
  counterWithin: Map<string, string>;
  crefNames: Map<string, { singular: string; plural: string; capital?: boolean }>;
  documentClass: string | null;
  packages: string[];
  /** Definitions that are wrong (a body using `#3` with two arguments). */
  problems: LatexDefinitionNote[];
  /** Definitions in forms the Visual mode does not render. */
  unsupported: LatexDefinitionNote[];
  /** Equal for equal definitions, so renderers can keep what did not change. */
  fingerprint: string;
};

export function emptyLatexDefinitions(): LatexDefinitions {
  return {
    macros: new Map(), environments: new Map(), theorems: new Map(), counterWithin: new Map(), crefNames: new Map(),
    documentClass: null, packages: [], problems: [], unsupported: [], fingerprint: "",
  };
}

const DEFINITION = /\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|def|gdef|edef|xdef|let|DeclareMathOperator|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|newenvironment|renewenvironment|NewDocumentEnvironment|RenewDocumentEnvironment|newtheorem|theoremstyle|newcounter|numberwithin|crefname|Crefname|documentclass|usepackage|RequirePackage)(?![A-Za-z@])/g;

/** Whether `index` is inside a `%` comment on its line. */
function inComment(source: string, index: number) {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  for (let i = lineStart; i < index; i++) {
    if (source[i] === "\\") { i++; continue; }
    if (source[i] === "%") return true;
  }
  return false;
}

/** Skips spaces and `%` comments between a command's arguments (a blank line ends them). */
function skipSpace(source: string, index: number) {
  while (index < source.length) {
    const char = source[index];
    if (char === "%") {
      const end = source.indexOf("\n", index);
      if (end < 0) return source.length;
      index = end + 1;
      continue;
    }
    if (!/[ \t\r\n]/.test(char)) break;
    if (char === "\n" && /^\n[ \t]*\n/.test(source.slice(index, index + 40))) break;
    index++;
  }
  return index;
}

/** `{\name}` or `\name` (letters, or one other character). */
function readCommandName(source: string, index: number): { name: string; end: number } | null {
  index = skipSpace(source, index);
  if (source[index] === "{") {
    const group = readGroup(source, index);
    const match = group && /^\s*\\([A-Za-z@]+|.)\s*$/.exec(group.content);
    return match ? { name: match[1], end: group.end } : null;
  }
  const match = /^\\([A-Za-z@]+|.)/.exec(source.slice(index, index + 80));
  return match ? { name: match[1], end: index + match[0].length } : null;
}

function readGroupAt(source: string, index: number) {
  return readGroup(source, skipSpace(source, index));
}

function readOptionalAt(source: string, index: number) {
  return readOptional(source, skipSpace(source, index));
}

/** The highest `#n` in a body (`##` is a literal `#`). */
function highestParameter(body: string) {
  let highest = 0;
  for (const match of body.matchAll(/##|#([1-9])/g)) if (match[1]) highest = Math.max(highest, Number(match[1]));
  return highest;
}

/** xparse argument specifications; null when one is not supported. */
function parseXparseSpec(spec: string): XparseArgument[] | null {
  const args: XparseArgument[] = [];
  let index = 0;
  while (index < spec.length) {
    const char = spec[index];
    if (/\s|\+|!/.test(char)) { index++; continue; }
    if (char === "m") args.push({ type: "m" });
    else if (char === "o") args.push({ type: "o" });
    else if (char === "s") args.push({ type: "s" });
    else if (char === "O") {
      const group = readGroup(spec, index + 1);
      if (!group) return null;
      args.push({ type: "O", default: group.content });
      index = group.end;
      continue;
    } else return null;
    index++;
  }
  return args;
}

type ReadContext = { defs: LatexDefinitions; file?: string; offset: number; bodyStart: number; theoremStyle: TheoremStyle };

function effectivePos(context: ReadContext, index: number) {
  // Definitions in the preamble or in other files apply to the whole body.
  return context.file !== undefined || index < context.bodyStart ? -1 : context.offset + index;
}

function addMacro(context: ReadContext, macro: Omit<LatexMacro, "fingerprint">, mode: "new" | "renew" | "provide") {
  const existing = context.defs.macros.get(macro.name);
  if (mode === "provide" && existing?.length) return;
  const fingerprint = hashString(JSON.stringify([macro.name, macro.arity, macro.optional ?? null, macro.spec ?? null, macro.body, !!macro.mathOnly]));
  const list = existing ?? [];
  list.push({ ...macro, fingerprint });
  context.defs.macros.set(macro.name, list);
}

/**
 * Reads the definitions in `source` into `defs`. `bodyStart` is where the
 * document body begins in `source` (definitions after it apply from where
 * they are); `offset` is `source`'s position in the open file. `file` is set
 * for other files of the project, whose definitions apply everywhere.
 */
export function readLatexDefinitions(source: string, defs = emptyLatexDefinitions(), options: { file?: string; offset?: number; bodyStart?: number } = {}) {
  const context: ReadContext = {
    defs, file: options.file, offset: options.offset ?? 0,
    bodyStart: options.bodyStart ?? (options.file !== undefined ? source.length : bodyStartOf(source)),
    theoremStyle: "plain",
  };
  DEFINITION.lastIndex = 0;
  for (let match: RegExpExecArray | null; (match = DEFINITION.exec(source));) {
    const start = match.index;
    if (inComment(source, start)) continue;
    let index = start + match[0].length;
    const command = match[1];
    const note = (list: LatexDefinitionNote[], name: string, message: string) => list.push({ pos: context.offset + start, file: context.file, name, message });
    const starred = source[index] === "*";
    if (starred) index++;
    const pos = effectivePos(context, start);

    if (command === "newcommand" || command === "renewcommand" || command === "providecommand" || command === "DeclareRobustCommand") {
      const name = readCommandName(source, index);
      if (!name) continue;
      index = name.end;
      const count = readOptionalAt(source, index);
      let arity = 0;
      if (count) { arity = Number(count.content.trim()) || 0; index = count.end; }
      const optional = count ? readOptionalAt(source, index) : null;
      if (optional) index = optional.end;
      const body = readGroupAt(source, index);
      if (!body) { note(defs.problems, name.name, `\\${name.name} has no {…} body`); continue; }
      const highest = highestParameter(body.content);
      if (highest > arity) { note(defs.problems, name.name, `\\${name.name} uses #${highest} but takes ${arity} argument${arity === 1 ? "" : "s"}`); continue; }
      addMacro(context, { name: name.name, arity, optional: optional ? optional.content : undefined, body: body.content, pos, file: context.file },
        command === "renewcommand" ? "renew" : command === "providecommand" ? "provide" : "new");
      DEFINITION.lastIndex = body.end;
    } else if (command === "def" || command === "gdef" || command === "edef" || command === "xdef") {
      const name = readCommandName(source, index);
      if (!name || source[skipSpace(source, index)] === "{") continue;
      index = name.end;
      const open = source.indexOf("{", index);
      if (open < 0) continue;
      const parameters = source.slice(index, open);
      const body = readGroup(source, open);
      if (!body) { note(defs.problems, name.name, `\\${name.name} has no {…} body`); continue; }
      DEFINITION.lastIndex = body.end;
      if (command === "edef" || command === "xdef") { note(defs.unsupported, name.name, `\\${command} is expanded when it is defined`); continue; }
      if (!/^\s*(?:#[1-9]\s*)*$/.test(parameters)) { note(defs.unsupported, name.name, `\\${name.name} has delimited parameters`); continue; }
      const arity = (parameters.match(/#/g) ?? []).length;
      addMacro(context, { name: name.name, arity, body: body.content, pos, file: context.file }, "renew");
    } else if (command === "let") {
      const name = readCommandName(source, index);
      if (!name) continue;
      let after = skipSpace(source, name.end);
      if (source[after] === "=") after = skipSpace(source, after + 1);
      const target = /^\\([A-Za-z@]+|.)/.exec(source.slice(after, after + 80));
      if (!target) continue;
      const aliased = defs.macros.get(target[1])?.at(-1);
      addMacro(context, aliased ? { ...aliased, name: name.name, pos, file: context.file } : { name: name.name, arity: 0, body: `\\${target[1]}`, pos, file: context.file }, "renew");
    } else if (command === "DeclareMathOperator") {
      const name = readCommandName(source, index);
      if (!name) continue;
      const body = readGroupAt(source, name.end);
      if (!body) continue;
      addMacro(context, { name: name.name, arity: 0, body: `\\operatorname${starred ? "*" : ""}{${body.content}}`, mathOnly: true, pos, file: context.file }, "new");
      DEFINITION.lastIndex = body.end;
    } else if (/DocumentCommand$/.test(command)) {
      const name = readCommandName(source, index);
      if (!name) continue;
      const specGroup = readGroupAt(source, name.end);
      const body = specGroup && readGroupAt(source, specGroup.end);
      if (!specGroup || !body) { note(defs.problems, name.name, `\\${name.name} needs an argument specification and a body`); continue; }
      DEFINITION.lastIndex = body.end;
      const spec = parseXparseSpec(specGroup.content);
      if (!spec) { note(defs.unsupported, name.name, `\\${name.name} uses argument types other than m, o, O and s`); continue; }
      addMacro(context, { name: name.name, arity: spec.length, spec, body: body.content, pos, file: context.file },
        command.startsWith("Provide") ? "provide" : command.startsWith("New") ? "new" : "renew");
    } else if (command === "newenvironment" || command === "renewenvironment" || command === "NewDocumentEnvironment" || command === "RenewDocumentEnvironment") {
      const nameGroup = readGroupAt(source, index);
      if (!nameGroup) continue;
      const name = nameGroup.content.trim();
      index = nameGroup.end;
      let arity = 0;
      let optional: string | undefined;
      let spec: XparseArgument[] | undefined;
      if (command.endsWith("DocumentEnvironment")) {
        const specGroup = readGroupAt(source, index);
        if (!specGroup) continue;
        const parsed = parseXparseSpec(specGroup.content);
        if (!parsed) { note(defs.unsupported, name, `${name} uses argument types other than m, o, O and s`); continue; }
        spec = parsed;
        arity = parsed.length;
        index = specGroup.end;
      } else {
        const count = readOptionalAt(source, index);
        if (count) { arity = Number(count.content.trim()) || 0; index = count.end; }
        const def = count ? readOptionalAt(source, index) : null;
        if (def) { optional = def.content; index = def.end; }
      }
      const begin = readGroupAt(source, index);
      const end = begin && readGroupAt(source, begin.end);
      if (!begin || !end) { note(defs.problems, name, `${name} needs begin and end code`); continue; }
      DEFINITION.lastIndex = end.end;
      defs.environments.set(name, { name, arity, optional, spec, begin: begin.content, end: end.content, pos });
    } else if (command === "theoremstyle") {
      const style = readGroupAt(source, index)?.content.trim();
      if (style === "plain" || style === "definition" || style === "remark") context.theoremStyle = style;
    } else if (command === "newtheorem") {
      const nameGroup = readGroupAt(source, index);
      if (!nameGroup) continue;
      const name = nameGroup.content.trim();
      index = nameGroup.end;
      const shared = readOptionalAt(source, index);
      if (shared) index = shared.end;
      const title = readGroupAt(source, index);
      if (!title) continue;
      index = title.end;
      const within = shared ? null : readOptionalAt(source, index);
      DEFINITION.lastIndex = within?.end ?? title.end;
      defs.theorems.set(name, {
        name, title: title.content.trim(), counter: shared ? shared.content.trim() : name,
        within: within ? within.content.trim() : undefined, numbered: !starred, style: context.theoremStyle,
      });
    } else if (command === "newcounter") {
      const nameGroup = readGroupAt(source, index);
      if (!nameGroup) continue;
      const within = readOptionalAt(source, nameGroup.end);
      if (within) defs.counterWithin.set(nameGroup.content.trim(), within.content.trim());
    } else if (command === "numberwithin") {
      const counter = readGroupAt(source, index);
      const within = counter && readGroupAt(source, counter.end);
      if (counter && within) defs.counterWithin.set(counter.content.trim(), within.content.trim());
    } else if (command === "crefname" || command === "Crefname") {
      const type = readGroupAt(source, index);
      const singular = type && readGroupAt(source, type.end);
      const plural = singular && readGroupAt(source, singular.end);
      if (type && singular && plural) {
        const key = command === "Crefname" ? `${type.content.trim()}:capital` : type.content.trim();
        defs.crefNames.set(key, { singular: singular.content, plural: plural.content, capital: command === "Crefname" });
      }
    } else if (command === "documentclass") {
      const options = readOptionalAt(source, index);
      const name = readGroupAt(source, options?.end ?? index);
      if (name) defs.documentClass = name.content.trim();
    } else if (command === "usepackage" || command === "RequirePackage") {
      const options = readOptionalAt(source, index);
      const names = readGroupAt(source, options?.end ?? index);
      if (names) for (const name of names.content.split(",")) if (name.trim()) defs.packages.push(name.trim());
    }
  }
  defs.fingerprint = definitionsFingerprint(defs);
  return defs;
}

export function definitionsFingerprint(defs: LatexDefinitions) {
  const parts: string[] = [];
  for (const [name, list] of defs.macros) parts.push(name, ...list.map((macro) => `${macro.fingerprint}@${macro.pos}`));
  for (const env of defs.environments.values()) parts.push(JSON.stringify(env));
  for (const thm of defs.theorems.values()) parts.push(JSON.stringify(thm));
  for (const [counter, within] of defs.counterWithin) parts.push(`${counter}<${within}`);
  for (const [key, names] of defs.crefNames) parts.push(`${key}=${names.singular}/${names.plural}`);
  parts.push(defs.documentClass ?? "");
  return hashString(parts.join("\u0000"));
}

/** Where the document body starts: after `\begin{document}`, or 0 for a chapter file without one. */
export function bodyStartOf(source: string) {
  const match = /\\begin\s*\{document\}/.exec(source);
  if (!match || inComment(source, match.index)) return 0;
  return match.index + match[0].length;
}

/** The definition of `name` that applies at `pos` in the open file. */
export function macroAt(defs: LatexDefinitions, name: string, pos: number): LatexMacro | null {
  const list = defs.macros.get(name);
  if (!list) return null;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].pos <= pos) return list[i];
  return null;
}

/** How many macros and environments a summary counts (the latest definition of each name). */
export function definitionCounts(defs: LatexDefinitions) {
  return { macros: defs.macros.size, environments: defs.environments.size, theorems: defs.theorems.size, packages: new Set(defs.packages).size };
}

/** `\input`, `\include` and `\subfile` targets in a source (comments skipped), in order, with positions. */
export function readLatexInputs(source: string) {
  const inputs: Array<{ pos: number; command: string; path: string }> = [];
  for (const match of source.matchAll(/\\(input|include|subfile)\s*\{([^}]+)\}/g)) {
    if (inComment(source, match.index ?? 0)) continue;
    inputs.push({ pos: match.index ?? 0, command: match[1], path: match[2].trim() });
  }
  return inputs;
}

export { inComment as isInLatexComment };
