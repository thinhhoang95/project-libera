import { snippet, startCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { indentUnit } from "@codemirror/language";
import { EditorSelection, EditorState, StateEffect, StateField, type Text } from "@codemirror/state";
import { EditorView, type Command, type KeyBinding } from "@codemirror/view";
import type { BibEntrySummary } from "@/lib/latex/project";
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
};

export const setLatexProject = StateEffect.define<LatexProjectData>();
const EMPTY_PROJECT: LatexProjectData = { labels: [], bibEntries: [], files: [] };

export const latexProjectField = StateField.define<LatexProjectData>({
  create: () => EMPTY_PROJECT,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setLatexProject)) value = effect.value;
    return value;
  },
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
    return {
      from,
      options: project.bibEntries.map((entry) => ({
        label: entry.key,
        apply: closingApply(entry.key),
        type: "constant",
        detail: entry.year,
        info: [entry.title, entry.author].filter(Boolean).join(" — ") || undefined,
      })),
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
