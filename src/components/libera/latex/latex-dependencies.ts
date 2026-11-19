"use client";

import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type { OpenTab } from "@/components/libera/types";
import { useDraftRevisionFor } from "@/components/libera/tab-chrome";
import { getSharedDocRegistry } from "@/lib/collab/client/registry";
import { classCommandSource, classTheoremSource, isInLatexComment, loadKey, readLatexInputs } from "@/lib/latex/macros/definitions";
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
/** The slow check that finds a shared dependency tab once it attaches (edits and disk changes arrive as events). */
const FALLBACK_MS = 30_000;

/** An open tab's current text: a shared tab's Y.Text (its React draft is not kept up to date), else its draft. */
export function liveTabText(tab: OpenTab): string {
  return getSharedDocRegistry().readTabText(tab.id) ?? tab.draft;
}

/** Edits seen on each shared Y.Text, so a poll can tell it is unchanged without copying its text. */
const textRevisions = new WeakMap<Y.Text, { count: number }>();

function textRevision(ytext: Y.Text): number {
  let revision = textRevisions.get(ytext);
  if (!revision) {
    const counter = { count: 0 };
    ytext.observe(() => { counter.count += 1; });
    textRevisions.set(ytext, counter);
    revision = counter;
  }
  return revision.count;
}

/** An open shared tab's attached Y.Text, or null (not shared, or not attached yet). */
function sharedTabText(tab: OpenTab): Y.Text | null {
  const session = getSharedDocRegistry().sessionForTab(tab.id);
  return session && session.replica.getSnapshot().attached ? session.replica.ytext : null;
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
    const classText = await readText(cls);
    const theorems = classTheoremSource(match[1].trim(), classText);
    // What the class gives its users is read where `\documentclass` is, with the class options (its `\ifbool`s read them), theorems included.
    const commands = classCommandSource(classText);
    if (commands) sources.push({ path: cls, text: `${theorems}\n${commands}`, version: version(cls), loadedBy: loader, key: loadKey("class", match[1]) });
    else if (theorems) sources.unshift({ path: cls, text: theorems, version: version(cls) });
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
 * (`updatedAt`) or in an open tab, shared ones included. Nothing polls: a tab's
 * text arrives as a draft publication under its path (tab-chrome.ts), a shared
 * tab's Y.Text is observed, and disk changes arrive through `updatedAt`.
 */
export function useDependencyVersion(paths: readonly string[], readOpenTabs: () => OpenTab[], updatedAt: ReadonlyMap<string, string | number | undefined>) {
  const key = paths.join("\u0000");
  // Each open dependency's last text and its hash: an unchanged text is not hashed again at every check.
  // A shared tab is known unchanged from its Y.Text's edit count, without copying the text out.
  const hashes = useRef(new Map<string, { text: string; hash: string; ytext?: Y.Text; revision?: number }>());
  const signature = () => {
    const open = new Map(readOpenTabs().map((tab) => [tab.file.path, tab]));
    const cache = hashes.current;
    for (const path of cache.keys()) if (!paths.includes(path)) cache.delete(path);
    return hashString(paths.map((path) => {
      const tab = open.get(path);
      if (!tab) return `${path}@${updatedAt.get(path) ?? ""}`;
      let entry = cache.get(path);
      const ytext = sharedTabText(tab);
      if (ytext) {
        const revision = textRevision(ytext);
        if (entry?.ytext !== ytext || entry.revision !== revision) {
          const text = ytext.toString();
          cache.set(path, entry = { text, hash: entry?.text === text ? entry.hash : hashString(text), ytext, revision });
        }
        return `${path}=${entry.hash}`;
      }
      const text = liveTabText(tab);
      if (!entry || entry.ytext || entry.text !== text) cache.set(path, entry = { text, hash: hashString(text) });
      return `${path}=${entry.hash}`;
    }).join("\u0000"));
  };
  const [version, setVersion] = useState("");
  // Moves only when one of these files' tabs is opened, closed or has new text.
  const draftRevision = useDraftRevisionFor(paths);
  const check = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!paths.length) return;
    const watched = new Map<Y.Text, () => void>();
    let timer: ReturnType<typeof setInterval> | undefined;
    const run = () => {
      // Nothing builds while the window is hidden; showing it checks at once.
      if (document.visibilityState === "hidden") return;
      const next = signature();
      setVersion((current) => (current === next ? current : next));
    };
    // Shared tabs edit their Y.Text before (or without) a draft publication, so each attached one is observed.
    const watch = () => {
      const live = new Set<Y.Text>();
      for (const tab of readOpenTabs()) {
        if (!paths.includes(tab.file.path)) continue;
        const ytext = sharedTabText(tab);
        if (!ytext) continue;
        live.add(ytext);
        if (!watched.has(ytext)) {
          textRevision(ytext);
          const listener = () => run();
          ytext.observe(listener);
          watched.set(ytext, listener);
        }
      }
      for (const [ytext, listener] of watched) if (!live.has(ytext)) { ytext.unobserve(listener); watched.delete(ytext); }
    };
    const checkNow = () => {
      if (document.visibilityState === "hidden") return;
      watch();
      run();
    };
    check.current = checkNow;
    // The only poll left: a shared tab attaches without an event this hook hears, so a slow visible-only check finds it.
    const arm = () => {
      if (timer === undefined && document.visibilityState !== "hidden") timer = setInterval(checkNow, FALLBACK_MS);
    };
    const disarm = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined; } };
    const visibility = () => {
      if (document.visibilityState === "hidden") disarm(); else { arm(); checkNow(); }
    };
    checkNow();
    arm();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      check.current = null;
      disarm();
      document.removeEventListener("visibilitychange", visibility);
      for (const [ytext, listener] of watched) ytext.unobserve(listener);
    };
    // `key` stands for the paths; the signature reads the current tabs and versions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, updatedAt]);
  useEffect(() => { check.current?.(); }, [draftRevision]);
  return version;
}
