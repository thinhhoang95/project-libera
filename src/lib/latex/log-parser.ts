/** Parsing of TeX, BibTeX and Biber logs into editor diagnostics.
 *
 * Logs are expected from a run with `-file-line-error` and a large
 * `max_print_line`, so file names and messages are not wrapped. File names are
 * reported exactly as TeX printed them; the build maps them to notebook paths. */

export type LatexLogSeverity = "error" | "warning" | "info";

export type LatexLogEntry = {
  severity: LatexLogSeverity;
  message: string;
  /** Context lines TeX printed after the message, when useful. */
  details?: string;
  /** The file as printed in the log (absolute, or relative to the build cwd). */
  file?: string;
  line?: number;
};

const FILE_LINE_ERROR = /^((?:[A-Za-z]:)?[^:\s][^:]*?\.[A-Za-z0-9]+):(\d+): (.*)$/;
const WARNING = /^((?:LaTeX|Package [^\s]+|Class [^\s]+)(?: Font)? Warning): (.*)$/;
const BADBOX = /^(Overfull|Underfull) \\[hv]box \((.*?)\)(.*)$/;
const INPUT_LINE = /on input line (\d+)/;
const BADBOX_LINES = /(?:at lines? (\d+)(?:--\d+)?|detected at line (\d+))/;
const MISSING_CHARACTER = /^Missing character: (.*)$/;
const NOISE_ERRORS = new Set(["Emergency stop.", "==> Fatal error occurred, no output PDF file produced!"]);

/** Tracks the file TeX is reading from the "(file" and ")" markers it prints. */
class FileStack {
  private readonly stack: (string | null)[] = [];

  constructor(private readonly mainFile?: string) {}

  get current() {
    for (let index = this.stack.length - 1; index >= 0; index--) {
      const file = this.stack[index];
      if (file) return file;
    }
    return this.mainFile;
  }

  scan(line: string) {
    for (let index = 0; index < line.length; index++) {
      const character = line[index];
      if (character === ")") {
        this.stack.pop();
      } else if (character === "(") {
        const rest = line.slice(index + 1);
        const quoted = rest.match(/^"([^"]+)"/);
        const plain = quoted ? null : rest.match(/^([^()\s]+)/);
        const name = quoted?.[1] ?? plain?.[1] ?? "";
        const looksLikeFile = /\.[A-Za-z0-9]{1,8}$/.test(name) && (/[/\\]/.test(name) || /^[\w.-]+\.(tex|sty|cls|clo|def|cfg|fd|aux|bbl|toc|lof|lot|out|ltx|dtx|ins|bib|bst)$/i.test(name));
        this.stack.push(looksLikeFile ? name : null);
        if (looksLikeFile) index += (quoted ? name.length + 2 : name.length);
      }
    }
  }
}

function collectDetails(lines: string[], start: number, limit = 6) {
  const details: string[] = [];
  for (let index = start; index < lines.length && details.length < limit; index++) {
    const line = lines[index];
    if (!line.trim()) break;
    details.push(line);
  }
  return details;
}

function lineFromDetails(details: string[]) {
  for (const detail of details) {
    const match = detail.match(/^l\.(\d+)/);
    if (match) return Number(match[1]);
  }
  return undefined;
}

/** Parse a TeX engine log (.log). */
export function parseLatexLog(log: string, mainFile?: string): LatexLogEntry[] {
  const lines = log.replace(/\r\n?/g, "\n").split("\n");
  const files = new FileStack(mainFile);
  const entries: LatexLogEntry[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fileLineError = line.match(FILE_LINE_ERROR);

    if (fileLineError && !/^\s/.test(line)) {
      const details = collectDetails(lines, index + 1);
      entries.push({
        severity: "error",
        message: fileLineError[3].trim(),
        details: details.join("\n") || undefined,
        file: fileLineError[1],
        line: Number(fileLineError[2]),
      });
      index += details.length;
      continue;
    }

    if (line.startsWith("! ")) {
      const message = line.slice(2).trim();
      const details = collectDetails(lines, index + 1, 8);
      entries.push({
        severity: "error",
        message,
        details: details.join("\n") || undefined,
        file: files.current,
        line: lineFromDetails(details),
      });
      index += details.length;
      continue;
    }

    const warning = line.match(WARNING);

    if (warning) {
      // Continuation lines are indented, or prefixed with "(package)".
      const parts = [warning[2]];
      let next = index + 1;
      while (next < lines.length && lines[next].trim() && (/^\s/.test(lines[next]) || /^\([^)]+\)/.test(lines[next]))) {
        parts.push(lines[next].replace(/^\([^)]+\)\s*/, "").trim());
        next++;
      }
      const message = parts.join(" ").replace(/\s+/g, " ").trim();
      const inputLine = message.match(INPUT_LINE);
      entries.push({
        // Font substitutions, and epstopdf noting that shell escape is off
        // (Libera always disables it), are notes rather than problems.
        severity: /Font Warning/.test(warning[1]) || /^Package epstopdf/.test(warning[1]) ? "info" : "warning",
        message: warning[1].startsWith("LaTeX") ? message : `${warning[1].replace(/ Warning$/, "")}: ${message}`,
        file: files.current,
        line: inputLine ? Number(inputLine[1]) : undefined,
      });
      files.scan(lines.slice(index + 1, next).join(" "));
      index = next - 1;
      continue;
    }

    const badbox = line.match(BADBOX);

    if (badbox) {
      const lineMatch = badbox[3].match(BADBOX_LINES);
      entries.push({
        severity: "info",
        message: `${badbox[1]} \\${line.includes("\\vbox") ? "vbox" : "hbox"} (${badbox[2]})`,
        file: files.current,
        line: lineMatch ? Number(lineMatch[1] ?? lineMatch[2]) : undefined,
      });
      continue;
    }

    const missingCharacter = line.match(MISSING_CHARACTER);

    if (missingCharacter) {
      entries.push({ severity: "warning", message: `Missing character: ${missingCharacter[1]}`, file: files.current });
      continue;
    }

    files.scan(line);
  }

  const hasRealError = entries.some((entry) => entry.severity === "error" && !NOISE_ERRORS.has(entry.message));
  return dedupeEntries(entries.filter((entry) => !(hasRealError && NOISE_ERRORS.has(entry.message))));
}

/** Parse a BibTeX (.blg) log. */
export function parseBibtexLog(log: string): LatexLogEntry[] {
  const lines = log.replace(/\r\n?/g, "\n").split("\n");
  const entries: LatexLogEntry[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const location = line.match(/---line (\d+) of file (.+)$/);

    if (location) {
      const message = (lines[index - 1] && !/^\s*$/.test(lines[index - 1]) && !location.index ? lines[index - 1] : line.slice(0, location.index)).trim();
      entries.push({ severity: "error", message: message || "BibTeX error", file: location[2].trim(), line: Number(location[1]) });
      continue;
    }

    const warning = line.match(/^Warning--(.*)$/);

    if (warning) {
      const where = lines[index + 1]?.match(/^--line (\d+) of file (.+)$/);
      entries.push({
        severity: "warning",
        message: `BibTeX: ${warning[1].trim()}`,
        file: where?.[2].trim(),
        line: where ? Number(where[1]) : undefined,
      });
      continue;
    }

    if (/^I couldn't open (database|style) file/.test(line) || /^I found no (\\bibdata|\\bibstyle|\\citation)/.test(line)) {
      entries.push({ severity: "error", message: `BibTeX: ${line.trim()}` });
    }
  }

  return dedupeEntries(entries);
}

/** Parse a Biber (.blg) log. */
export function parseBiberLog(log: string): LatexLogEntry[] {
  const entries: LatexLogEntry[] = [];

  for (const line of log.replace(/\r\n?/g, "\n").split("\n")) {
    const match = line.match(/^\[\d+\] [^:]*:(ERROR|WARN) - (.*)$/);
    if (!match) continue;
    const message = match[2].trim();
    const location = message.match(/BibTeX subsystem: (.+?), line (\d+), (.*)$/);
    entries.push({
      severity: match[1] === "ERROR" ? "error" : "warning",
      message: `Biber: ${location ? location[3] : message}`,
      file: location?.[1],
      line: location ? Number(location[2]) : undefined,
    });
  }

  return dedupeEntries(entries);
}

function dedupeEntries(entries: LatexLogEntry[]) {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.severity}\0${entry.file ?? ""}\0${entry.line ?? ""}\0${entry.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
