"use client";

import { useEffect, useState } from "react";
import type { OpenTab } from "@/components/libera/types";
import { getSharedDocRegistry } from "@/lib/collab/client/registry";
import { loadKey, readLatexInputs } from "@/lib/latex/macros/definitions";
import type { MacroSource } from "@/lib/latex/codemirror/visual";
import { resolveRelativeNotebookPath } from "@/lib/latex/project";
import { hashString } from "@/lib/macros/core";

/* The other files a LaTeX file's Visual mode reads (docs/latex-visual-editor-plan.md
 * §7.3, §7.7): the macro files and local packages its preamble (or its main
 * file's) loads, and the files its body includes, read live from open tabs
 * (shared tabs from their Y.Text) and from disk otherwise. TeX finds all of
 * them from the directory of the file it compiles, so they resolve from there. */

/** Files read at most, and how deep `\input`s are followed. */
const MAX_FILES = 24;
const MAX_DEPTH = 4;
/** How often open dependencies are checked for edits (they live in other tabs). */
const POLL_MS = 1500;

/** An open tab's current text: a shared tab's Y.Text (its React draft is not kept up to date), else its draft. */
export function liveTabText(tab: OpenTab): string {
  return getSharedDocRegistry().readTabText(tab.id) ?? tab.draft;
}

export type ReadText = (path: string) => Promise<string>;

/** The files a source loads: `\input`/`\include`/`\subfile`, and `\usepackage` of a local `.sty`, with the key the reader matches. */
function loadsOf(text: string, rootPath: string, known: ReadonlySet<string>, packages: boolean) {
  const loads: Array<{ path: string; key: string }> = [];
  for (const input of readLatexInputs(text)) {
    const name = /\.(?:tex|ltx|sty)$/i.test(input.path) ? input.path : `${input.path}.tex`;
    const resolved = resolveRelativeNotebookPath(rootPath, name);
    if (resolved && known.has(resolved)) loads.push({ path: resolved, key: loadKey("input", input.path) });
  }
  if (packages) {
    for (const match of text.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
      for (const name of match[1].split(",")) {
        const resolved = resolveRelativeNotebookPath(rootPath, `${name.trim()}.sty`);
        if (resolved && known.has(resolved)) loads.push({ path: resolved, key: loadKey("package", name) });
      }
    }
  }
  return loads;
}

/**
 * The macro sources of a file: its main file's preamble (for a chapter), and
 * the files the preamble loads, and theirs, each marked with what loads it so
 * definitions are read in TeX's order. `paths` are all the files read.
 */
export async function collectMacroSources(options: {
  filePath: string; rootPath: string; ownPreamble: string; known: ReadonlySet<string>; readText: ReadText; version: (path: string) => string;
}): Promise<{ sources: MacroSource[]; paths: string[] }> {
  const { filePath, rootPath, known, readText, version } = options;
  const sources: MacroSource[] = [];
  const paths: string[] = [];
  let preamble = options.ownPreamble;
  let loader = "";
  if (rootPath !== filePath) {
    const rootText = await readText(rootPath);
    paths.push(rootPath);
    const bodyStart = /\\begin\s*\{document\}/.exec(rootText);
    preamble = rootText.slice(0, bodyStart ? bodyStart.index : 0);
    if (preamble) sources.push({ path: rootPath, text: preamble, version: version(rootPath) });
    loader = rootPath;
  }
  const seen = new Set<string>([filePath, rootPath]);
  let queue = loadsOf(preamble, rootPath, known, true).map((load) => ({ ...load, loadedBy: loader }));
  for (let depth = 0; queue.length && depth < MAX_DEPTH; depth++) {
    const next: typeof queue = [];
    for (const load of queue) {
      if (seen.has(load.path) || paths.length >= MAX_FILES) continue;
      seen.add(load.path);
      const text = await readText(load.path);
      paths.push(load.path);
      if (!text) continue;
      sources.push({ path: load.path, text, version: version(load.path), loadedBy: load.loadedBy, key: load.key });
      next.push(...loadsOf(text, rootPath, known, true).map((inner) => ({ ...inner, loadedBy: load.path })));
    }
    queue = next;
  }
  return { sources, paths };
}

/** The texts of the files a body includes (`\input`, `\include`), and theirs, by `loadKey`, for numbering. */
export async function collectBodyIncludes(options: {
  filePath: string; rootPath: string; text: string; known: ReadonlySet<string>; readText: ReadText;
}): Promise<{ includes: Map<string, string>; paths: string[] }> {
  const { rootPath, known, readText } = options;
  const includes = new Map<string, string>();
  const paths: string[] = [];
  const bodyStart = /\\begin\s*\{document\}/.exec(options.text);
  const seen = new Set<string>([options.filePath]);
  let queue = loadsOf(options.text.slice(bodyStart ? bodyStart.index : 0), rootPath, known, false);
  for (let depth = 0; queue.length && depth < MAX_DEPTH; depth++) {
    const next: typeof queue = [];
    for (const load of queue) {
      if (seen.has(load.path) || paths.length >= MAX_FILES || /\.sty$/i.test(load.path)) continue;
      seen.add(load.path);
      const text = await readText(load.path);
      paths.push(load.path);
      includes.set(load.key, text);
      next.push(...loadsOf(text, rootPath, known, false));
    }
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
  const signature = () => {
    const open = new Map(readOpenTabs().map((tab) => [tab.file.path, tab]));
    return hashString(paths.map((path) => {
      const tab = open.get(path);
      return tab ? `${path}=${hashString(liveTabText(tab))}` : `${path}@${updatedAt.get(path) ?? ""}`;
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
