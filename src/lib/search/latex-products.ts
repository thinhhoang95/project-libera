import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const normalize = (value: string) => value.normalize("NFC").toLowerCase();
const OUTPUT_EXTENSION = /\.(?:pdf|log|bbl|dvi|xdv|ps)$/i;
const SOURCE_EXTENSION = /\.(?:tex|bib|sty|cls|bst)$/i;
const MAX_RECORDER_BYTES = 1024 * 1024;

/** Per-scan metadata cache. Never open a candidate PDF to decide whether to skip it. */
export function latexBuildProductFilter() {
  const directories = new Map<string, Promise<{ stems: Set<string>; outputs: Set<string> }>>();
  function evidence(directory: string) {
    let pending = directories.get(directory);
    if (pending) return pending;
    pending = (async () => {
      const entries = await readdir(directory, { withFileTypes: true });
      const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
      const stems = new Set(names.flatMap((name) => {
        const match = /^(.*)\.(?:tex|aux|fdb_latexmk|synctex(?:\.gz)?)$/i.exec(name);
        return match ? [normalize(match[1])] : [];
      }));
      const outputs = new Set<string>();
      for (const name of names.filter((name) => /\.fls$/i.test(name))) {
        const file = path.join(directory, name);
        const size = await stat(file);
        if (size.size > MAX_RECORDER_BYTES) continue;
        const content = await readFile(file, "utf8");
        // TeX's recorder resolves OUTPUT against PWD, not the recorder folder.
        const cwd = content.match(/^PWD (.+)\r?$/m)?.[1].trim() || directory;
        for (const line of content.split(/\r?\n/)) {
          if (!line.startsWith("OUTPUT ")) continue;
          const target = line.slice(7).trim().replace(/^"(.*)"$/, "$1");
          if (target) outputs.add(normalize(path.resolve(cwd, target)));
        }
      }
      return { stems, outputs };
    })();
    directories.set(directory, pending);
    return pending;
  }

  return async (absolutePath: string, rootDirectory: string) => {
    if (SOURCE_EXTENSION.test(absolutePath)) return false;
    if (/\.(?:bbl|run\.xml)$/i.test(absolutePath)) return true;
    if (!/\.(?:pdf|log|dvi|xdv|ps|png|jpe?g|svg|webp|gif)$/i.test(absolutePath)) return false;
    const directory = path.dirname(absolutePath);
    const extension = path.extname(absolutePath);
    const stem = normalize(path.basename(absolutePath, extension));
    let current = directory;
    while (true) {
      const { stems, outputs } = await evidence(current);
      if (outputs.has(normalize(absolutePath))) return true;
      if (OUTPUT_EXTENSION.test(absolutePath) && stems.has(stem) &&
        (current === directory || /^(?:build|out|output|latex\.out)(?:[\\/]|$)/i.test(path.relative(current, directory)))) return true;
      if (current === rootDirectory) break;
      const parent = path.dirname(current);
      if (parent === current || path.relative(rootDirectory, parent).startsWith("..")) break;
      current = parent;
    }
    return false;
  };
}
