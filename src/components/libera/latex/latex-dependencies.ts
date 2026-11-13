"use client";

import { useEffect, useRef, useState } from "react";
import type { OpenTab } from "@/components/libera/types";
import { getSharedDocRegistry } from "@/lib/collab/client/registry";
import { classTheoremSource, isInLatexComment, loadKey, readLatexInputs } from "@/lib/latex/macros/definitions";
import { findInclusion, includeTargets } from "@/lib/latex/macros/project-numbering";
import type { MacroSource } from "@/lib/latex/codemirror/visual";
import { resolveRelativeNotebookPath } from "@/lib/latex/project";
import { hashString } from "@/lib/macros/core";
import { findBeginDocument } from "@/lib/latex/document-begin";

/* The other files a LaTeX file's Visual mode reads (docs/latex-visual-editor-plan.md
 * §7.3, §7.7): the macro files and local packages its preamble (or its main
 * file's) loads, and the files its body includes, read live from open tabs
 * (shared tabs from their Y.Text) and from disk otherwise. TeX finds all of
 * them from the directory of the file it compiles, so they resolve from there. */

/** Files read at most, and how deep `\input`s are followed. */
const MAX_FILES = 24;
const MAX_DEPTH = 4;
/** Files a body's includes read at most, for numbering: a paper's tables and figures can be files of their own (2405.14734 has 29). */
const MAX_INCLUDES = 400;
/** How often open dependencies are checked for edits (they live in other tabs). */
const POLL_MS = 1500;

/** An open tab's current text: a shared tab's Y.Text (its React draft is not kept up to date), else its draft. */
export function liveTabText(tab: OpenTab): string {
  return getSharedDocRegistry().readTabText(tab.id) ?? tab.draft;
}

export type ReadText = (path: string) => Promise<string>;

/**
 * The files a source loads: its includes (`\input`, `\include`, `\subfile`, the import package's `\subimport{dir/}{file}`),
 * and `\usepackage` of a local `.sty`, with the key the reader matches, where the load is, and the import directory the
 * loaded file's own includes start from.
 */
function loadsOf(text: string, rootPath: string, known: ReadonlySet<string>, packages: boolean, importDir = "") {
  const loads: Array<{ path: string; key: string; pos: number; importDir: string }> = [];
  for (const input of readLatexInputs(text)) {
    const target = includeTargets(input, rootPath, importDir);
    const resolved = target.paths.find((path) => known.has(path));
    if (resolved) loads.push({ path: resolved, key: loadKey("input", input.path), pos: input.pos, importDir: target.importDir });
  }
  if (packages) {
    for (const match of text.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
      for (const name of match[1].split(",")) {
        const resolved = resolveRelativeNotebookPath(rootPath, `${name.trim()}.sty`);
        if (resolved && known.has(resolved)) loads.push({ path: resolved, key: loadKey("package", name), pos: match.index ?? 0, importDir: "" });
      }
    }
  }
  return loads;
}

/** A source with each include written as `\input{name}`, the one the definition reader follows (by the same key): `\include{ch1}`, `\subimport{dir/}{file}`. */
function includesAsInputs(text: string) {
  let out = "";
  let at = 0;
  for (const input of readLatexInputs(text)) {
    if (input.command === "input") continue;
    out += `${text.slice(at, input.pos)}\\input{${input.path}}`;
    at = input.end;
  }
  return at ? out + text.slice(at) : text;
}

/** Commands whose definitions last past the file a chapter of the body is in: such a file is read for them. */
const DEFINES = /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|def|gdef|xdef|let|newtheorem|theoremstyle|newenvironment|renewenvironment|DeclareMathOperator|DeclarePairedDelimiter|(?:New|Renew|Provide|Declare)(?:Expandable)?DocumentCommand|NewDocumentEnvironment|RenewDocumentEnvironment|newtoggle|toggletrue|togglefalse|settoggle|newbool|booltrue|boolfalse|setbool|newcounter|numberwithin|counterwithin|crefname|Crefname|newcolumntype|definecolor|colorlet|newlist|setlist)(?![A-Za-z@])/;

/**
 * The macro sources of a file: its main file's preamble (for a chapter), and
 * the files the preamble loads, and theirs, each marked with what loads it so
 * definitions are read in TeX's order. `paths` are all the files read.
 *
 * A chapter also gets what the main file's body defines before including it
 * (2304.03442's `\newcommand{\gentxt}` after `\begin{document}`, a
 * `\renewcommand{\thetable}{A\arabic{table}}` before the appendices' `\input`),
 * as TeX reads it: the main file up to that include, the files on the way to
 * it up to theirs, and what the chapters before it define. A class the project
 * has (nowfnt.cls) gives its theorems first.
 */
export async function collectMacroSources(options: {
  filePath: string; rootPath: string; ownPreamble: string; ownBody?: string; known: ReadonlySet<string>; readText: ReadText; version: (path: string) => string;
}): Promise<{ sources: MacroSource[]; paths: string[] }> {
  const { filePath, rootPath, known, version } = options;
  // Finding the chapter and reading the sources read the same files: once each.
  const reads = new Map<string, Promise<string>>();
  const readText = (path: string) => {
    let read = reads.get(path);
    if (!read) reads.set(path, read = options.readText(path));
    return read;
  };
  const sources: MacroSource[] = [];
  const paths: string[] = [];
  let preamble = options.ownPreamble;
  let text = preamble;
  let loader = "";
  /** For a chapter: the files from the main file's body to it, read up to the include that leads on. */
  const chain = new Map<string, number>();
  let bodyFrom = Number.POSITIVE_INFINITY;
  if (rootPath !== filePath) {
    const rootText = await readText(rootPath);
    paths.push(rootPath);
    const bodyStart = findBeginDocument(rootText);
    preamble = rootText.slice(0, bodyStart ? bodyStart.index : 0);
    text = preamble;
    const steps = bodyStart ? await findInclusion(filePath, rootPath, readText) : null;
    if (steps) {
      for (const step of steps) chain.set(step.path, step.cut);
      bodyFrom = includesAsInputs(preamble).length;
      text = includesAsInputs(rootText.slice(0, steps[0].cut));
    }
    if (text) sources.push({ path: rootPath, text, version: version(rootPath) });
    loader = rootPath;
  }
  for (const match of preamble.matchAll(/\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/g)) {
    const cls = resolveRelativeNotebookPath(rootPath, `${match[1].trim()}.cls`);
    if (!cls || !known.has(cls) || isInLatexComment(preamble, match.index ?? 0) || paths.includes(cls)) continue;
    paths.push(cls);
    const theorems = classTheoremSource(match[1].trim(), await readText(cls));
    if (theorems) sources.unshift({ path: cls, text: theorems, version: version(cls) });
  }
  const seen = new Set<string>([filePath, rootPath]);
  let queue = loadsOf(text, rootPath, known, true).map((load) => ({ ...load, loadedBy: loader, body: load.pos >= bodyFrom }));
  // What the open file inputs in its own body applies from there on: the open file's reader reaches that `\input` and reads the file.
  if (options.ownBody) queue.push(...loadsOf(options.ownBody, rootPath, known, false).map((load) => ({ ...load, loadedBy: "", body: true })));
  let preambleReads = 0;
  let bodyReads = 0;
  for (let depth = 0; queue.length && depth < MAX_DEPTH; depth++) {
    const next: typeof queue = [];
    for (const load of queue) {
      const cut = chain.get(load.path);
      if (seen.has(load.path) || (cut === undefined && (load.body ? bodyReads >= MAX_INCLUDES : preambleReads >= MAX_FILES))) continue;
      seen.add(load.path);
      if (load.body) bodyReads++; else preambleReads++;
      let loaded = await readText(load.path);
      paths.push(load.path);
      if (!loaded) continue;
      // A file on the way to the chapter is read up to the include leading on; another file of the body only for what it defines.
      if (cut !== undefined) loaded = loaded.slice(0, cut);
      else if (load.body && !DEFINES.test(loaded)) continue;
      const body = load.body || cut !== undefined;
      if (body) loaded = includesAsInputs(loaded);
      sources.push({ path: load.path, text: loaded, version: version(load.path), loadedBy: load.loadedBy, key: load.key });
      next.push(...loadsOf(loaded, rootPath, known, true, load.importDir).map((inner) => ({ ...inner, loadedBy: load.path, body })));
    }
    queue = next;
  }
  return { sources, paths };
}

/** The texts of the files a body includes (`\input`, `\include`, `\subfile`, imports), and theirs, by `loadKey`, for numbering. */
export async function collectBodyIncludes(options: {
  filePath: string; rootPath: string; text: string; known: ReadonlySet<string>; readText: ReadText;
}): Promise<{ includes: Map<string, string>; paths: string[] }> {
  const { rootPath, known, readText } = options;
  const includes = new Map<string, string>();
  const paths: string[] = [];
  const bodyStart = findBeginDocument(options.text);
  const seen = new Set<string>([options.filePath]);
  let queue = loadsOf(options.text.slice(bodyStart ? bodyStart.index : 0), rootPath, known, false);
  for (let depth = 0; queue.length && depth < MAX_DEPTH; depth++) {
    const batch: typeof queue = [];
    for (const load of queue) {
      if (seen.has(load.path) || paths.length + batch.length >= MAX_INCLUDES || /\.sty$/i.test(load.path)) continue;
      seen.add(load.path);
      batch.push(load);
    }
    // Each level's files are read together, and kept in reading order.
    const texts = await Promise.all(batch.map((load) => readText(load.path)));
    const next: typeof queue = [];
    batch.forEach((load, index) => {
      paths.push(load.path);
      includes.set(load.key, texts[index]);
      next.push(...loadsOf(texts[index], rootPath, known, false, load.importDir));
    });
    queue = next;
  }
  return { includes, paths };
}

/**
 * A version of a set of files that changes when any of them does: on disk
 * (`updatedAt`) or in an open tab, shared ones included. Open tabs are
 * checked every few seconds, since their edits happen in other editors.
 */
export function useDependencyVersion(paths: readonly string[], readOpenTabs: () => OpenTab[], updatedAt: ReadonlyMap<string, string | number | undefined>) {
  const key = paths.join("\u0000");
  // Each open dependency's last text and its hash: an unchanged text is not hashed again at every poll.
  const hashes = useRef(new Map<string, { text: string; hash: string }>());
  const signature = () => {
    const open = new Map(readOpenTabs().map((tab) => [tab.file.path, tab]));
    const cache = hashes.current;
    for (const path of cache.keys()) if (!paths.includes(path)) cache.delete(path);
    return hashString(paths.map((path) => {
      const tab = open.get(path);
      if (!tab) return `${path}@${updatedAt.get(path) ?? ""}`;
      const text = liveTabText(tab);
      let entry = cache.get(path);
      if (!entry || entry.text !== text) cache.set(path, entry = { text, hash: hashString(text) });
      return `${path}=${entry.hash}`;
    }).join("\u0000"));
  };
  const [version, setVersion] = useState("");
  useEffect(() => {
    if (!paths.length) return;
    const check = () => {
      const next = signature();
      setVersion((current) => (current === next ? current : next));
    };
    check();
    const timer = setInterval(check, POLL_MS);
    return () => clearInterval(timer);
    // `key` stands for the paths; the signature reads the current tabs and versions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, updatedAt]);
  return version;
}
