import { snippet, startCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { indentUnit } from "@codemirror/language";
import { EditorSelection, EditorState, StateEffect, StateField, type Text } from "@codemirror/state";
import { EditorView, showPanel, type Command, type KeyBinding, type Panel } from "@codemirror/view";
import { hasDocumentClass, readLatexBibliographyReferences, stripLatexComments, type BibEntrySummary } from "@/lib/latex/project";
import type { ReferenceLibrary } from "@/lib/references/types";
import { ENVIRONMENT_ARGUMENTS, LATEX_CLASSES, LATEX_COMMANDS, LATEX_ENVIRONMENTS, LATEX_PACKAGES } from "./latex-data";
import { isInsideMath } from "./math";

/* ---- Project data used by completion -------------------------------------- */

export type LatexProjectFile = { path: string; kind: "tex" | "bib" | "image" | "pdf" | "other" };
export type LatexProjectData = {
  /** Labels defined in the other files of the project. */
  labels: string[];
  bibEntries: BibEntrySummary[];
  /** Files relative to the folder of the document being edited. */
  files: LatexProjectFile[];
  /** The notebook's References library, offered by `\cite` completion even when no `.bib` is referenced. */
  libraryEntries?: LatexLibraryEntry[];
  /** Whether the project's main file names a bibliography (`\bibliography{}` or `\addbibresource{}`). */
  hasBibliography?: boolean;
  /** Turn on the notebook's generated references.bib (references/bib-mirror.ts). */
  enableBibMirror?: () => void;
};

/** A References entry for `\cite` completion. */
export type LatexLibraryEntry = { key: string; aliases: string[]; author?: string; year?: string; title?: string };

/** A library's entries for `\cite` completion: key, aliases, first author, year, title. */
export function latexLibraryEntries(library: ReferenceLibrary | null | undefined): LatexLibraryEntry[] {
  return Object.values(library?.entries ?? {}).map((entry) => {
    const names = entry.csl.author ?? entry.csl.editor ?? [];
    const first = names[0] ? names[0].family ?? names[0].literal ?? "" : "";
    const year = entry.csl.issued?.["date-parts"]?.[0]?.[0];
    return {
      key: entry.key,
      aliases: entry.aliases ?? [],
      ...(first ? { author: names.length > 1 ? `${first} et al.` : first } : {}),
      ...(typeof year === "number" ? { year: String(year) } : {}),
      ...(typeof entry.csl.title === "string" && entry.csl.title ? { title: entry.csl.title } : {}),
    };
  }).sort((left, right) => left.key.localeCompare(right.key));
}

export const setLatexProject = StateEffect.define<LatexProjectData>();
const EMPTY_PROJECT: LatexProjectData = { labels: [], bibEntries: [], files: [] };

/* ---- Add-bibliography hint ------------------------------------------------- */

/** How the document loads its bibliography: biblatex (`\addbibresource`) or BibTeX (`\bibliography`). */
export type LatexBibliographyKind = "biblatex" | "bibtex";
export type LatexBibliographyHint = { key: string; kind: LatexBibliographyKind };

export const showBibliographyHint = StateEffect.define<LatexBibliographyHint | null>();

/** biblatex when the preamble loads it, else BibTeX (natbib and plain LaTeX both use `\bibliography`). */
export function latexBibliographyKind(source: string): LatexBibliographyKind {
  return /\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\bbiblatex\b[^}]*\}/.test(stripLatexComments(source)) ? "biblatex" : "bibtex";
}

/**
 * The edit that makes a document load the notebook's references.bib:
 * `\addbibresource{references.bib}` before `\begin{document}` (biblatex), or
 * `\bibliographystyle{plain}` (when missing) and `\bibliography{references}`
 * before `\end{document}` (BibTeX). Null for a file that is not a main file.
 */
export function addBibliographyChange(source: string, kind: LatexBibliographyKind): { from: number; insert: string } | null {
  if (!hasDocumentClass(source)) return null;
  // Comments are blanked, not removed, so offsets still match the source.
  const active = source.replace(/(^|[^\\])((?:\\\\)*)%[^\n]*/g, (match, before: string, slashes: string) => before + slashes + " ".repeat(match.length - before.length - slashes.length));
  if (kind === "biblatex") {
    const at = active.search(/^[ \t]*\\begin\s*\{document\}/m);
    return at < 0 ? null : { from: at, insert: "\\addbibresource{references.bib}\n" };
  }
  const end = active.search(/^[ \t]*\\end\s*\{document\}/m);
  const style = /\\bibliographystyle\s*\{/.test(active) ? "" : "\\bibliographystyle{plain}\n";
  const lines = `${style}\\bibliography{references}\n`;
  return end < 0 ? { from: source.length, insert: `${source.endsWith("\n") ? "" : "\n"}${lines}` } : { from: end, insert: lines };
}

function documentHasBibliography(state: EditorState) {
  return readLatexBibliographyReferences(state.doc.toString()).length > 0;
}

function bibliographyHintPanel(view: EditorView, hint: LatexBibliographyHint): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-latex-bibliography-hint";
  dom.setAttribute("role", "status");
  const change = addBibliographyChange(view.state.doc.toString(), hint.kind);
  const command = hint.kind === "biblatex" ? "\\addbibresource{references.bib}" : "\\bibliography{references}";
  const message = document.createElement("span");
  message.textContent = change
    ? `“${hint.key}” is from this notebook's References, but this document has no bibliography. Add ${command} and keep references.bib generated from References?`
    : `“${hint.key}” is from this notebook's References. Add ${command} to the main file, and keep references.bib generated from References?`;
  dom.append(message);
  const button = (label: string, run: () => void) => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.addEventListener("mousedown", (event) => event.preventDefault());
    element.addEventListener("click", run);
    dom.append(element);
  };
  button(change ? `Add ${command}` : "Generate references.bib", () => {
    const current = addBibliographyChange(view.state.doc.toString(), hint.kind);
    view.dispatch({ ...(current ? { changes: current } : {}), effects: showBibliographyHint.of(null), userEvent: "input" });
    (view.state.field(latexProjectField, false) ?? EMPTY_PROJECT).enableBibMirror?.();
    view.focus();
  });
  button("Dismiss", () => {
    view.dispatch({ effects: showBibliographyHint.of(null) });
    view.focus();
  });
  return { dom, top: false };
}

/** The hint shown after a References key is inserted into a document without a bibliography. */
export const bibliographyHintField = StateField.define<LatexBibliographyHint | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(showBibliographyHint)) value = effect.value;
    // Gone once the document names a bibliography.
    if (value && tr.docChanged && documentHasBibliography(tr.state)) return null;
    return value;
  },
  provide: (field) => showPanel.from(field, (hint) => (hint ? (view) => bibliographyHintPanel(view, hint) : null)),
});

export const latexProjectField = StateField.define<LatexProjectData>({
  create: () => EMPTY_PROJECT,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setLatexProject)) value = effect.value;
    return value;
  },
  // Wherever project data is, the add-bibliography hint can show.
  provide: () => bibliographyHintField,
});

/* ---- Helpers --------------------------------------------------------------- */

const REF_COMMANDS = /^(?:ref|eqref|pageref|autoref|cref|Cref|nameref|vref|labelcref|crefrange|Crefrange)$/;
const CITE_COMMANDS = /^(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|citeyearpar|parencite|textcite|autocite|footcite|fullcite|smartcite|supercite|nocite|Cite|Citep|Citet|Parencite|Textcite|Autocite)\*?$/;
const ESCAPE = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function stripLineComment(text: string) {
  const match = text.match(/(^|[^\\])(?:\\\\)*%/);
  return match ? text.slice(0, (match.index ?? 0) + match[0].length - 1) : text;
}

function isInComment(state: EditorState, pos: number) {
  const line = state.doc.lineAt(pos);
  return stripLineComment(line.text).length < pos - line.from;
}

/** Commands and environments the document defines itself. */
function documentDefinitions(doc: Text) {
  const text = doc.length > 400_000 ? doc.sliceString(0, 400_000) : doc.toString();
  const commands = new Set<string>();
  const environments = new Set<string>();
  const labels = new Set<string>();
  for (const match of text.matchAll(/\\(?:newcommand|renewcommand|providecommand|DeclareMathOperator|DeclareRobustCommand)\*?\s*\{?\\([a-zA-Z@]+)/g)) commands.add(match[1]);
  for (const match of text.matchAll(/\\def\s*\\([a-zA-Z@]+)/g)) commands.add(match[1]);
  for (const match of text.matchAll(/\\(?:newenvironment|renewenvironment|newtheorem)\*?\s*\{([^}]+)\}/g)) environments.add(match[1]);
  for (const match of text.matchAll(/\\label\s*\{([^}]+)\}/g)) labels.add(match[1]);
  return { commands, environments, labels };
}

/** Environments opened before `pos` and not yet closed, innermost last. */
export function openEnvironmentsAt(doc: Text, pos: number) {
  const start = Math.max(0, pos - 60_000);
  const text = doc.sliceString(start, pos).split("\n").map(stripLineComment).join("\n");
  const stack: string[] = [];
  for (const match of text.matchAll(/\\(begin|end)\s*\{([^}]+)\}/g)) {
    if (match[1] === "begin") stack.push(match[2]);
    else {
      const index = stack.lastIndexOf(match[2]);
      if (index >= 0) stack.splice(index, 1);
    }
  }
  return stack;
}

/** Whether a `\begin{name}` just before `pos` already has its `\end{name}`. */
function environmentIsClosed(doc: Text, pos: number, name: string) {
  const text = doc.sliceString(pos, Math.min(doc.length, pos + 200_000)).split("\n").map(stripLineComment).join("\n");
  const pattern = new RegExp(`\\\\(begin|end)\\s*\\{${ESCAPE(name)}\\}`, "g");
  let depth = 0;
  for (const match of text.matchAll(pattern)) {
    depth += match[1] === "begin" ? 1 : -1;
    if (depth < 0) return true;
  }
  return false;
}

function findPartner(doc: Text, keywordPos: number, kind: "begin" | "end", name: string) {
  const pattern = new RegExp(`\\\\(begin|end)\\s*\\{${ESCAPE(name)}\\}`, "g");
  if (kind === "begin") {
    const offset = keywordPos;
    const text = doc.sliceString(offset, Math.min(doc.length, offset + 200_000));
    let depth = 0;
    for (const match of text.matchAll(pattern)) {
      depth += match[1] === "begin" ? 1 : -1;
      if (depth === 0) {
        const nameFrom = offset + (match.index ?? 0) + match[0].indexOf("{") + 1;
        return { from: nameFrom, to: nameFrom + name.length };
      }
    }
    return null;
  }
  const offset = Math.max(0, keywordPos - 200_000);
  const text = doc.sliceString(offset, keywordPos + 5 + name.length + 2);
  const matches = [...text.matchAll(pattern)];
  let depth = 0;
  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index];
    depth += match[1] === "end" ? 1 : -1;
    if (depth === 0) {
      const nameFrom = offset + (match.index ?? 0) + match[0].indexOf("{") + 1;
      return { from: nameFrom, to: nameFrom + name.length };
    }
  }
  return null;
}

/* ---- Completion ------------------------------------------------------------ */

function environmentTemplate(name: string, body?: string) {
  const args = ENVIRONMENT_ARGUMENTS[name] ?? "";
  const bodyLines = (body ?? "${}").split("\n").map((line) => `\t${line}`).join("\n");
  return `${name}}${args}\n${bodyLines}\n\\end{${name}}`;
}

function environmentCompletions(state: EditorState, from: number, to: number, closing: boolean): CompletionResult {
  const defined = documentDefinitions(state.doc).environments;
  const known = new Map(LATEX_ENVIRONMENTS.map((environment) => [environment.name, environment]));
  for (const name of defined) if (!known.has(name)) known.set(name, { name, detail: "Defined in this document" });
  const hasClosingBrace = state.sliceDoc(to, to + 1) === "}";

  if (closing) {
    const open = openEnvironmentsAt(state.doc, from).reverse();
    const names = [...new Set([...open, ...known.keys()])];
    return {
      from,
      to: hasClosingBrace ? to + 1 : to,
      options: names.map((name, index) => ({ label: name, apply: `${name}}`, type: "type", boost: index < open.length ? 99 - index : 0, detail: index < open.length ? "open environment" : undefined })),
      validFor: /^[a-zA-Z@*]*$/,
    };
  }

  const options: Completion[] = [...known.values()].map((environment) => ({
    label: environment.name,
    type: "type",
    detail: environment.detail,
    apply: (view, completion, applyFrom, applyTo) => {
      const end = view.state.sliceDoc(applyTo, applyTo + 1) === "}" ? applyTo + 1 : applyTo;
      // Only expand into a full block when the \begin stands at the end of its line.
      if (view.state.sliceDoc(end, view.state.doc.lineAt(end).to).trim() || environmentIsClosed(view.state.doc, end, environment.name)) {
        view.dispatch({ changes: { from: applyFrom, to: end, insert: `${environment.name}}` }, selection: { anchor: applyFrom + environment.name.length + 1 } });
        return;
      }
      snippet(environmentTemplate(environment.name, environment.body))(view, completion, applyFrom, end);
    },
  }));
  return { from, to, options, validFor: /^[a-zA-Z@*]*$/ };
}

/** Insert a key or file name and close its argument when the brace is missing. */
function closingApply(label: string): Completion["apply"] {
  return (view, _completion, from, to) => {
    const next = view.state.sliceDoc(to, to + 1);
    const insert = next === "}" || next === "," ? label : `${label}}`;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input.complete" });
  };
}

function relativeFileOptions(files: LatexProjectFile[], kinds: LatexProjectFile["kind"][], stripExtension: boolean): Completion[] {
  return files.filter((file) => kinds.includes(file.kind)).map((file) => {
    const label = stripExtension ? file.path.replace(/\.(tex)$/i, "") : file.path;
    return { label, apply: closingApply(label), type: "text", detail: file.kind === "image" ? "image" : file.kind === "pdf" ? "PDF" : undefined };
  });
}

/** Insert a References key; in a document without a bibliography, offer to add one. */
function libraryKeyApply(key: string, project: LatexProjectData): Completion["apply"] {
  return (view, _completion, from, to) => {
    const next = view.state.sliceDoc(to, to + 1);
    const insert = next === "}" || next === "," ? key : `${key}}`;
    const effects = !project.hasBibliography && !documentHasBibliography(view.state)
      ? [showBibliographyHint.of({ key, kind: latexBibliographyKind(view.state.doc.toString()) })]
      : [];
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, effects, userEvent: "input.complete" });
  };
}

/**
 * The notebook library's keys, and its aliases (which insert the current
 * key), that no `.bib` of the project already offers.
 */
function libraryCiteOptions(project: LatexProjectData, bibKeys: Set<string>): Completion[] {
  const options: Completion[] = [];
  for (const entry of project.libraryEntries ?? []) {
    if (bibKeys.has(entry.key)) continue;
    const info = [entry.title, entry.author].filter(Boolean).join(" — ") || undefined;
    const apply = libraryKeyApply(entry.key, project);
    options.push({ label: entry.key, apply, type: "constant", detail: entry.year ? `${entry.year} · References` : "References", info, boost: -1 });
    for (const alias of entry.aliases) {
      if (bibKeys.has(alias) || alias === entry.key) continue;
      options.push({ label: alias, apply, type: "constant", detail: `alias of ${entry.key}`, info, boost: -2 });
    }
  }
  return options;
}

function argumentCompletions(context: CompletionContext, command: string, typed: string): CompletionResult | null {
  const { state, pos } = context;
  const project = state.field(latexProjectField, false) ?? EMPTY_PROJECT;
  // Comma-separated keys complete only the current entry.
  const listCommand = CITE_COMMANDS.test(command) || command === "usepackage" || REF_COMMANDS.test(command);
  const segment = listCommand ? typed.slice(typed.lastIndexOf(",") + 1) : typed;
  const leading = segment.match(/^\s*/)?.[0].length ?? 0;
  const from = pos - segment.length + leading;
  const validFor = /^[^,{}\s]*$/;

  if (command === "begin") return environmentCompletions(state, pos - typed.length, pos, false);
  if (command === "end") return environmentCompletions(state, pos - typed.length, pos, true);

  if (REF_COMMANDS.test(command)) {
    const labels = new Set([...documentDefinitions(state.doc).labels, ...project.labels]);
    return { from, options: [...labels].map((label) => ({ label, apply: closingApply(label), type: "variable", detail: label.includes(":") ? label.split(":")[0] : undefined })), validFor };
  }

  if (CITE_COMMANDS.test(command)) {
    const bibKeys = new Set(project.bibEntries.map((entry) => entry.key));
    return {
      from,
      options: [
        ...project.bibEntries.map((entry) => ({
          label: entry.key,
          apply: closingApply(entry.key),
          type: "constant",
          detail: entry.year,
          info: [entry.title, entry.author].filter(Boolean).join(" — ") || undefined,
        })),
        ...libraryCiteOptions(project, bibKeys),
      ],
      validFor,
    };
  }

  if (command === "usepackage" || command === "RequirePackage") return { from, options: LATEX_PACKAGES.map((name) => ({ label: name, apply: closingApply(name), type: "namespace" })), validFor };
  if (command === "documentclass") return { from, options: LATEX_CLASSES.map((name) => ({ label: name, apply: closingApply(name), type: "class" })), validFor };
  if (command === "includegraphics") return { from, options: relativeFileOptions(project.files, ["image", "pdf"], false), validFor: /^[^{}]*$/ };
  if (command === "input" || command === "include" || command === "subfile" || command === "includeonly") return { from, options: relativeFileOptions(project.files, ["tex"], true), validFor: /^[^{}]*$/ };
  if (command === "bibliography" || command === "addbibresource") {
    return {
      from,
      options: relativeFileOptions(project.files, ["bib"], false).map((option) => {
        const label = command === "bibliography" ? option.label.replace(/\.bib$/i, "") : option.label;
        return { ...option, label, apply: closingApply(label) };
      }),
      validFor: /^[^{}]*$/,
    };
  }
  return null;
}

export function latexCompletionSource(context: CompletionContext): CompletionResult | null {
  const { state, pos } = context;
  if (isInComment(state, pos)) return null;
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(Math.max(0, pos - line.from - 400), pos - line.from);

  const argument = before.match(/\\([a-zA-Z]+\*?)\s*(?:\[[^\]]*\])*\{([^{}]*)$/);
  if (argument) {
    const result = argumentCompletions(context, argument[1].replace(/\*$/, ""), argument[2]);
    if (result) return result;
  }

  const word = context.matchBefore(/\\[a-zA-Z@]*\*?/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  // "\\" is a line break, not the start of a command.
  if (word.text === "\\" && state.sliceDoc(word.from - 1, word.from) === "\\") return null;
  if (word.from > 0 && state.sliceDoc(word.from - 1, word.from) === "\\" && state.sliceDoc(word.from - 2, word.from - 1) !== "\\") return null;

  const inMath = isInsideMath(state, pos);
  const defined = documentDefinitions(state.doc).commands;
  const options: Completion[] = [];
  const seen = new Set<string>();

  for (const command of LATEX_COMMANDS) {
    seen.add(command.name);
    const boost = command.math ? (inMath ? 2 : -5) : command.text && inMath ? -2 : 0;
    options.push({
      label: `\\${command.name}`,
      type: command.math ? "keyword" : "function",
      detail: command.detail,
      boost,
      apply: command.snippet ? snippet(command.snippet) : `\\${command.name}`,
    });
  }

  for (const name of defined) {
    if (seen.has(name)) continue;
    options.push({ label: `\\${name}`, type: "function", detail: "defined in this document", boost: 1 });
  }

  options.push({
    label: "\\begin",
    type: "keyword",
    detail: "environment",
    boost: 3,
    apply: (view, _completion, from, to) => {
      view.dispatch({ changes: { from, to, insert: "\\begin{}" }, selection: { anchor: from + 7 } });
      // Open the environment list right away.
      queueMicrotask(() => startCompletion(view));
    },
  });

  return { from: word.from, options, validFor: /^\\[a-zA-Z@]*\*?$/ };
}

/* ---- Typing helpers -------------------------------------------------------- */

const LIST_ENVIRONMENTS = new Set(["itemize", "enumerate", "description"]);

/** Typing `}` to finish `\begin{name}` opens the block and adds `\end{name}`;
 * after a single backslash, `{`, `[` and `(` get their escaped partner. */
export function handleLatexInput(view: EditorView, from: number, to: number, text: string) {
  if (from !== to || view.state.readOnly) return false;
  const state = view.state;
  if (isInComment(state, from)) return false;
  const line = state.doc.lineAt(from);
  const before = line.text.slice(0, from - line.from);

  if (text === "}") {
    const match = before.match(/\\begin\s*\{([a-zA-Z@*]+)$/);
    if (!match) return false;
    const name = match[1];
    const hasClosingBrace = state.sliceDoc(from, from + 1) === "}";
    const afterBrace = hasClosingBrace ? from + 1 : from;
    if (state.sliceDoc(afterBrace, line.to).trim() || environmentIsClosed(state.doc, afterBrace, name)) return false;
    const indent = /^\s*/.exec(line.text)?.[0] ?? "";
    const unit = state.facet(indentUnit);
    const item = LIST_ENVIRONMENTS.has(name) ? "\\item " : "";
    const insert = `}\n${indent}${unit}${item}\n${indent}\\end{${name}}`;
    view.dispatch({
      changes: { from, to: afterBrace, insert },
      selection: { anchor: from + 2 + indent.length + unit.length + item.length },
      scrollIntoView: true,
      userEvent: "input.type",
    });
    return true;
  }

  const escapedPartner: Record<string, string> = { "{": "\\}", "[": "\\]", "(": "\\)" };
  if (text in escapedPartner && /(^|[^\\])\\$/.test(before)) {
    const closing = escapedPartner[text];
    if (state.sliceDoc(from, from + closing.length) === closing) return false;
    view.dispatch({ changes: { from, insert: `${text}${closing}` }, selection: { anchor: from + 1 }, userEvent: "input.type" });
    return true;
  }

  // An escaped dollar or percent sign is a literal character, never a pair.
  if ((text === "$" || text === "%") && /(^|[^\\])\\$/.test(before)) {
    view.dispatch({ changes: { from, insert: text }, selection: { anchor: from + 1 }, userEvent: "input.type" });
    return true;
  }

  return false;
}

export const latexInputHandler = EditorView.inputHandler.of(handleLatexInput);

/** Enter on an `\item` line starts the next item; on an empty item, ends the list. */
export const continueListItem: Command = (view) => {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(range.head);
  const match = line.text.match(/^(\s*)\\item(\[[^\]]*\])?(\s*)(.*)$/);
  if (!match || range.head < line.from + match[1].length + 5) return false;
  const environments = openEnvironmentsAt(state.doc, line.from);
  if (!LIST_ENVIRONMENTS.has(environments.at(-1) ?? "")) return false;

  if (!match[4].trim() && !match[2] && range.head === line.to) {
    view.dispatch({ changes: { from: line.from + match[1].length, to: line.to, insert: "" }, userEvent: "delete" });
    return true;
  }
  view.dispatch(state.update(state.replaceSelection(`\n${match[1]}\\item `), { scrollIntoView: true, userEvent: "input" }));
  return true;
};

/** Wrap the selection in `\command{…}`, or unwrap it when already wrapped. */
export function wrapSelection(command: string): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const opening = `\\${command}{`;
    view.dispatch(view.state.changeByRange((range) => {
      const { state } = view;
      if (state.sliceDoc(range.from - opening.length, range.from) === opening && state.sliceDoc(range.to, range.to + 1) === "}") {
        return {
          changes: [{ from: range.from - opening.length, to: range.from }, { from: range.to, to: range.to + 1 }],
          range: EditorSelection.range(range.from - opening.length, range.to - opening.length),
        };
      }
      const text = state.sliceDoc(range.from, range.to);
      return {
        changes: { from: range.from, to: range.to, insert: `${opening}${text}}` },
        range: EditorSelection.range(range.from + opening.length, range.from + opening.length + text.length),
      };
    }), { userEvent: "input", scrollIntoView: true });
    return true;
  };
}

export const latexFormattingKeymap: KeyBinding[] = [
  { key: "Mod-b", run: wrapSelection("textbf") },
  { key: "Mod-i", run: wrapSelection("textit") },
  { key: "Mod-u", run: wrapSelection("underline") },
  { key: "Mod-Shift-e", run: wrapSelection("emph") },
  { key: "Mod-Shift-t", run: wrapSelection("texttt") },
  { key: "Enter", run: continueListItem },
];

/** Editing an environment name in `\begin{…}` renames its `\end{…}`, and vice versa. */
export const syncEnvironmentNames = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !(tr.isUserEvent("input") || tr.isUserEvent("delete"))) return tr;
  let count = 0;
  let changeFrom = 0;
  let changeTo = 0;
  tr.changes.iterChangedRanges((fromA, toA) => { count++; changeFrom = fromA; changeTo = toA; });
  if (count !== 1) return tr;
  const start = tr.startState;
  const line = start.doc.lineAt(changeFrom);
  if (changeTo > line.to) return tr;

  for (const match of line.text.matchAll(/\\(begin|end)\s*\{([^}\n]*)\}/g)) {
    const keywordPos = line.from + (match.index ?? 0);
    const nameFrom = keywordPos + match[0].indexOf("{") + 1;
    const nameTo = nameFrom + match[2].length;
    if (changeFrom < nameFrom || changeTo > nameTo) continue;
    const oldName = match[2];
    if (!oldName.trim()) return tr;
    const partner = findPartner(start.doc, keywordPos, match[1] as "begin" | "end", oldName);
    if (!partner || (partner.from >= nameFrom && partner.to <= nameTo)) return tr;
    const newFrom = tr.changes.mapPos(nameFrom, -1);
    const newTo = tr.changes.mapPos(nameTo, 1);
    const newName = tr.newDoc.sliceString(newFrom, newTo);
    if (newName === oldName || /[{}\n\\]/.test(newName)) return tr;
    return [tr, { changes: { from: tr.changes.mapPos(partner.from, -1), to: tr.changes.mapPos(partner.to, 1), insert: newName }, sequential: true }];
  }
  return tr;
});
