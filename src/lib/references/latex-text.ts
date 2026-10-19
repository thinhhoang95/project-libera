// LaTeX text in BibTeX fields ↔ Unicode text with CSL rich-text markup.
//
// Decoding turns accent macros, special letters, escapes, dashes, quotes and
// the common formatting commands into Unicode and the HTML subset citeproc
// understands (`<i> <b> <sup> <sub>`, small caps and `nocase` spans). `$…$`
// math is kept verbatim. Encoding is the reverse, for BibTeX export: the
// `bibtex` dialect writes accents as macros, `biblatex` keeps UTF-8.
//
// Brace-protected text (`{DNA}`) becomes `<span class="nocase">…</span>`,
// CSL's case protection, unless every word inside already protects itself
// (internal capitals or an acronym, see `isSelfProtectingWord`): citeproc
// never changes the case of such words, and `protectTitleCase` braces them
// again on export, so dropping the redundant span keeps BibTeX → entries →
// BibTeX round trips stable. Pure and dependency-free.

export type LatexDialect = "bibtex" | "biblatex";

export type LatexDecodeOptions = {
  /** "html" (default) keeps formatting as CSL rich text; "plain" drops all markup. */
  markup?: "html" | "plain";
  /** Turn brace-protected text into nocase spans. Default true; only meaningful with html markup. */
  protectCase?: boolean;
};

const NOCASE_OPEN = '<span class="nocase">';
const SMALL_CAPS_OPEN = '<span style="font-variant:small-caps;">';

/** Accent macros and the combining mark each one adds. */
const ACCENTS: Record<string, string> = {
  "'": "́", "`": "̀", "^": "̂", "\"": "̈", "~": "̃", "=": "̄", ".": "̇",
  u: "̆", v: "̌", H: "̋", c: "̧", k: "̨", r: "̊", d: "̣", b: "̱", t: "͡",
};
/** The spacing character an accent macro produces with an empty argument, e.g. `\^{}`. */
const ACCENT_SPACING: Record<string, string> = { "'": "´", "`": "`", "^": "^", "\"": "¨", "~": "~", "=": "¯", ".": "˙" };

const SPECIAL_LETTERS: Record<string, string> = {
  ss: "ß", SS: "SS", o: "ø", O: "Ø", aa: "å", AA: "Å", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", l: "ł", L: "Ł",
  i: "ı", j: "ȷ", dh: "ð", DH: "Ð", th: "þ", TH: "Þ", ng: "ŋ", NG: "Ŋ", dj: "đ", DJ: "Đ",
};

/** Commands without arguments that stand for a character or a word. */
const SYMBOL_COMMANDS: Record<string, string> = {
  textendash: "–", textemdash: "—", textquotedblleft: "“", textquotedblright: "”", textquoteleft: "‘",
  textquoteright: "’", ldots: "…", dots: "…", textellipsis: "…", textasciitilde: "~", textasciicircum: "^",
  textbackslash: "\\", textasciigrave: "`", textbar: "|", textless: "<", textgreater: ">", textunderscore: "_",
  S: "§", P: "¶", copyright: "©", textcopyright: "©", textregistered: "®", texttrademark: "™", pounds: "£",
  textsterling: "£", euro: "€", texteuro: "€", textdegree: "°", textperiodcentered: "·", textbullet: "•",
  dag: "†", ddag: "‡", guillemotleft: "«", guillemotright: "»", guillemetleft: "«", guillemetright: "»",
  quad: " ", qquad: " ", LaTeX: "LaTeX", TeX: "TeX", BibTeX: "BibTeX", relax: "", protect: "", textordfeminine: "ª",
  textordmasculine: "º", textexclamdown: "¡", textquestiondown: "¿", textdollar: "$", textbraceleft: "{", textbraceright: "}",
};

/** Formatting commands with one argument, and the rich-text tag they become. */
const FORMAT_COMMANDS: Record<string, [string, string]> = {
  textit: ["<i>", "</i>"], emph: ["<i>", "</i>"], textsl: ["<i>", "</i>"], mkbibemph: ["<i>", "</i>"], mkbibitalic: ["<i>", "</i>"],
  textbf: ["<b>", "</b>"], mkbibbold: ["<b>", "</b>"], textsc: [SMALL_CAPS_OPEN, "</span>"],
  textsuperscript: ["<sup>", "</sup>"], mkbibsuperscript: ["<sup>", "</sup>"],
  textsubscript: ["<sub>", "</sub>"], mkbibsubscript: ["<sub>", "</sub>"],
  NoCaseChange: [NOCASE_OPEN, "</span>"], enquote: ["“", "”"], mkbibquote: ["“", "”"],
};
/** Old-style switches that format the rest of their group, e.g. `{\em text}`. */
const SWITCH_COMMANDS: Record<string, [string, string] | null> = {
  em: ["<i>", "</i>"], it: ["<i>", "</i>"], itshape: ["<i>", "</i>"], sl: ["<i>", "</i>"], slshape: ["<i>", "</i>"],
  bf: ["<b>", "</b>"], bfseries: ["<b>", "</b>"], sc: [SMALL_CAPS_OPEN, "</span>"], scshape: [SMALL_CAPS_OPEN, "</span>"],
  rm: null, sf: null, tt: null, upshape: null, normalfont: null, mdseries: null, rmfamily: null, sffamily: null, ttfamily: null,
};
/** Commands whose argument is kept as plain text: `\mbox{x}` → "x". */
const TRANSPARENT_COMMANDS = new Set([
  "mbox", "hbox", "text", "textrm", "textnormal", "textup", "textsf", "texttt", "textmd", "textlatin", "foreignlanguage",
]);
/** Commands whose argument is verbatim. */
const VERBATIM_COMMANDS = new Set(["url", "nolinkurl", "path", "doi"]);
/** Commands whose argument is dropped. */
const DROPPED_COMMANDS = new Set(["noopsort", "nocite", "label", "index", "hyphenation", "sortname"]);

const WORD_SOURCE = String.raw`[\p{L}\p{N}]+(?:['’\-.][\p{L}\p{N}]+)*`;
const LETTER = new RegExp(String.raw`\p{L}`, "u");
const UPPERCASE = new RegExp(String.raw`\p{Lu}`, "u");

/**
 * A word whose case citeproc's title and sentence casing never change, and
 * that `protectTitleCase` braces on export: an uppercase letter after the
 * first character, as in "iPhone", "McDonald" or the acronym "DNA".
 */
export function isSelfProtectingWord(word: string) {
  return UPPERCASE.test(Array.from(word).slice(1).join(""));
}

function stripMarkup(html: string) {
  return html.replace(/<\/?[a-zA-Z][^>]*>/g, "");
}

/** True when a nocase span around `content` changes nothing (see the module comment). */
function nocaseIsRedundant(content: string) {
  // Math never changes case, so it needs no protection either.
  const text = stripMarkup(content).replace(/\$[^$]*\$/g, " ");
  const words = text.match(new RegExp(WORD_SOURCE, "gu"));
  if (!words) return true;
  if (text.split(new RegExp(WORD_SOURCE, "u")).some((gap) => gap.trim() !== "")) return false;
  return words.every(isSelfProtectingWord);
}

function hasCasedLetters(text: string) {
  const plain = stripMarkup(text);
  return plain.toLowerCase() !== plain.toUpperCase();
}

class LatexDecoder {
  private index = 0;

  constructor(private readonly source: string, private readonly html: boolean, private readonly protectCase: boolean) {}

  decode() {
    let out = "";
    while (this.index < this.source.length) {
      out += this.sequence(false, false);
      // A stray closing brace at the top level is dropped.
      if (this.source[this.index] === "}") this.index += 1;
    }
    return out;
  }

  private open(tags: [string, string] | null, content: string) {
    if (!tags || !this.html || content === "") return content;
    return tags[0] + content + tags[1];
  }

  /** Decodes until the end of input, or a closing brace when `inGroup`, which is consumed. */
  private sequence(inGroup: boolean, inNocase: boolean): string {
    let out = "";
    const source = this.source;
    while (this.index < source.length) {
      const char = source[this.index];
      if (char === "}") {
        if (inGroup) this.index += 1;
        return out;
      }
      if (char === "{") {
        this.index += 1;
        out += this.group(inNocase);
        continue;
      }
      if (char === "\\") {
        const switched = this.switchAt();
        if (switched) {
          this.index = switched.end;
          return out + this.open(switched.tags, this.sequence(inGroup, inNocase));
        }
        out += this.command(inNocase);
        continue;
      }
      if (char === "$") {
        out += this.math();
        continue;
      }
      if (char === "~") {
        out += " ";
        this.index += 1;
        continue;
      }
      if (char === "-") {
        if (source.startsWith("---", this.index)) {
          out += "—";
          this.index += 3;
        } else if (source.startsWith("--", this.index)) {
          out += "–";
          this.index += 2;
        } else {
          out += "-";
          this.index += 1;
        }
        continue;
      }
      if (char === "`") {
        if (source[this.index + 1] === "`") {
          out += "“";
          this.index += 2;
        } else {
          out += "‘";
          this.index += 1;
        }
        continue;
      }
      if (char === "'" && source[this.index + 1] === "'") {
        out += "”";
        this.index += 2;
        continue;
      }
      if (/\s/.test(char)) {
        while (this.index < source.length && /\s/.test(source[this.index])) this.index += 1;
        out += " ";
        continue;
      }
      out += char;
      this.index += 1;
    }
    return out;
  }

  /** A brace group; the opening brace is consumed. */
  private group(inNocase: boolean) {
    const special = this.specialGroupAhead();
    const protect = this.html && this.protectCase && !inNocase && !special;
    const content = this.sequence(true, inNocase || protect);
    if (!protect || !hasCasedLetters(content) || nocaseIsRedundant(content)) return content;
    return NOCASE_OPEN + content + "</span>";
  }

  /** BibTeX's "special character" group: `{\'e}`, `{\ss}`, `{\em …}`, which is not case protection. */
  private specialGroupAhead() {
    if (this.source[this.index] !== "\\") return false;
    const next = this.source[this.index + 1] ?? "";
    if (next in ACCENTS && !/[a-zA-Z]/.test(next)) return true;
    const name = this.source.slice(this.index + 1).match(/^[a-zA-Z]+/)?.[0] ?? "";
    return name in ACCENTS || name in SPECIAL_LETTERS || name in SWITCH_COMMANDS;
  }

  private switchAt() {
    const match = this.source.slice(this.index).match(/^\\([a-zA-Z]+)\s*/);
    if (!match || !(match[1] in SWITCH_COMMANDS)) return null;
    return { tags: SWITCH_COMMANDS[match[1]], end: this.index + match[0].length };
  }

  private skipSpaces() {
    while (this.index < this.source.length && /\s/.test(this.source[this.index])) this.index += 1;
  }

  /** The raw text of a brace group at the cursor, consumed; null when there is none. */
  private rawGroup() {
    const start = this.index;
    this.skipSpaces();
    if (this.source[this.index] !== "{") {
      this.index = start;
      return null;
    }
    let depth = 0;
    for (let index = this.index; index < this.source.length; index += 1) {
      const char = this.source[index];
      if (char === "\\") {
        index += 1;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const raw = this.source.slice(this.index + 1, index);
          this.index = index + 1;
          return raw;
        }
      }
    }
    const raw = this.source.slice(this.index + 1);
    this.index = this.source.length;
    return raw;
  }

  /** A decoded brace-group argument, or null when the next token is not a group. */
  private argument(inNocase: boolean) {
    const start = this.index;
    this.skipSpaces();
    if (this.source[this.index] !== "{") {
      this.index = start;
      return null;
    }
    this.index += 1;
    return this.sequence(true, inNocase);
  }

  private command(inNocase: boolean): string {
    const source = this.source;
    this.index += 1;
    const next = source[this.index];
    if (next === undefined) return "\\";
    if (!/[a-zA-Z]/.test(next)) {
      this.index += 1;
      if (next in ACCENTS) return this.accent(next, inNocase);
      if ("&%$#_{}".includes(next)) return next;
      if (next === "\\" || next === " " || next === "\n" || next === ",") return " ";
      if (next === "-" || next === "/" || next === "@") return "";
      return next;
    }
    const name = source.slice(this.index).match(/^[a-zA-Z]+/)![0];
    this.index += name.length;
    if (name in ACCENTS) return this.accent(name, inNocase);
    if (name in SPECIAL_LETTERS || name in SYMBOL_COMMANDS) {
      this.skipSpaces();
      if (source.startsWith("{}", this.index)) this.index += 2;
      return SPECIAL_LETTERS[name] ?? SYMBOL_COMMANDS[name];
    }
    if (name in FORMAT_COMMANDS) {
      const content = this.argument(inNocase || name === "NoCaseChange") ?? "";
      if (name === "NoCaseChange") return this.html && !inNocase && this.protectCase ? this.open(FORMAT_COMMANDS[name], content) : content;
      if (name === "enquote" || name === "mkbibquote") return `“${content}”`;
      return this.open(FORMAT_COMMANDS[name], content);
    }
    if (VERBATIM_COMMANDS.has(name)) return this.rawGroup() ?? "";
    if (name === "href") {
      this.rawGroup();
      return this.argument(inNocase) ?? "";
    }
    if (name === "ensuremath") return `$${this.rawGroup() ?? ""}$`;
    if (DROPPED_COMMANDS.has(name)) {
      this.rawGroup();
      return "";
    }
    this.skipSpaces();
    if (TRANSPARENT_COMMANDS.has(name) || source[this.index] === "{") return this.argument(inNocase) ?? "";
    // Unknown argument-less command: dropped.
    return "";
  }

  private accent(macro: string, inNocase: boolean) {
    const source = this.source;
    this.skipSpaces();
    let base: string;
    let rest = "";
    if (source[this.index] === "{") {
      this.index += 1;
      const content = this.sequence(true, true);
      if (content === "") return ACCENT_SPACING[macro] ?? "";
      const chars = Array.from(content);
      base = chars[0];
      rest = chars.slice(1).join("");
    } else if (source[this.index] === "\\") {
      base = this.command(inNocase);
    } else if (this.index < source.length) {
      base = Array.from(source.slice(this.index))[0];
      this.index += base.length;
    } else {
      return ACCENT_SPACING[macro] ?? "";
    }
    if (base === "ı") base = "i";
    if (base === "ȷ") base = "j";
    const chars = Array.from(base);
    const first = chars.shift() ?? "";
    return (first + ACCENTS[macro]).normalize("NFC") + chars.join("") + rest;
  }

  /** `$…$` or `$$…$$`, kept verbatim. An unmatched `$` is a literal dollar sign. */
  private math() {
    const source = this.source;
    const delimiter = source.startsWith("$$", this.index) ? "$$" : "$";
    for (let index = this.index + delimiter.length; index < source.length; index += 1) {
      if (source[index] === "\\") {
        index += 1;
      } else if (source.startsWith(delimiter, index)) {
        const math = source.slice(this.index, index + delimiter.length);
        this.index = index + delimiter.length;
        return math.replace(/\s+/g, " ");
      }
    }
    this.index += 1;
    return "$";
  }
}

/**
 * LaTeX field text → Unicode. With html markup (the default), formatting
 * becomes CSL rich text and brace-protected text becomes nocase spans;
 * plain markup drops all formatting, for names, keys and identifiers.
 * Whitespace runs become single spaces; `~` becomes a no-break space.
 */
export function decodeLatex(text: string, options: LatexDecodeOptions = {}) {
  const html = (options.markup ?? "html") === "html";
  const decoded = new LatexDecoder(text, html, options.protectCase ?? true).decode();
  return decoded.replace(/ {2,}/g, " ").trim();
}

/**
 * The text of a verbatim field (url, doi, eprint, isbn): a `\url{}` wrapper,
 * braces and the backslash of escaped characters are removed; nothing else
 * changes, so `~` and `--` survive.
 */
export function decodeLatexVerbatim(text: string) {
  return text
    .replace(/\\(?:url|nolinkurl|path|doi)\s*\{/g, "{")
    .replace(/\\([_%&#$~{}])/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const MARK_TO_ACCENT: Record<string, string> = Object.fromEntries(Object.entries(ACCENTS).map(([macro, mark]) => [mark, macro]));
const LETTER_TO_MACRO: Record<string, string> = {
  ß: "ss", ø: "o", Ø: "O", å: "aa", Å: "AA", æ: "ae", Æ: "AE", œ: "oe", Œ: "OE", ł: "l", Ł: "L", ı: "i", ȷ: "j",
  ð: "dh", Ð: "DH", þ: "th", Þ: "TH", ŋ: "ng", Ŋ: "NG", đ: "dj", Đ: "DJ",
};
/** Marks placed below the letter, which keep the dot of i and j. */
const MARKS_BELOW = new Set(["̧", "̨", "̣", "̱"]);
const BIBTEX_SYMBOLS: Record<string, string> = {
  "‘": "\\textquoteleft{}", "’": "\\textquoteright{}", "…": "\\ldots{}", "§": "\\S{}", "¶": "\\P{}", "©": "\\textcopyright{}",
  "®": "\\textregistered{}", "™": "\\texttrademark{}", "£": "\\pounds{}", "€": "\\texteuro{}", "°": "\\textdegree{}",
  "«": "\\guillemotleft{}", "»": "\\guillemotright{}", "†": "\\dag{}", "‡": "\\ddag{}", "¡": "\\textexclamdown{}", "¿": "\\textquestiondown{}",
};

function encodeAccented(char: string) {
  if (char in LETTER_TO_MACRO) return `{\\${LETTER_TO_MACRO[char]}}`;
  const decomposed = Array.from(char.normalize("NFD"));
  const base = decomposed[0];
  const marks = decomposed.slice(1);
  if (!marks.length || !/^[a-zA-Z]$/.test(base) || !marks.every((mark) => mark in MARK_TO_ACCENT)) return null;
  let text = base;
  if ((base === "i" || base === "j") && !MARKS_BELOW.has(marks[0])) text = `\\${base}`;
  marks.forEach((mark, index) => {
    const macro = MARK_TO_ACCENT[mark];
    const letterMacro = /^[a-zA-Z]$/.test(macro);
    const argument = index === 0 && !text.startsWith("\\") && !letterMacro ? text : `{${text}}`;
    text = `\\${macro}${argument}`;
  });
  return `{${text}}`;
}

type EncodeTag = { close: string };

const OPEN_TAGS: Array<[RegExp, string, string]> = [
  [/^<i>/, "\\textit{", "}"],
  [/^<b>/, "\\textbf{", "}"],
  [/^<sup>/, "\\textsuperscript{", "}"],
  [/^<sub>/, "\\textsubscript{", "}"],
  [/^<span class="nocase">/, "{", "}"],
  [/^<span style="font-variant:\s*small-caps;?">/, "\\textsc{", "}"],
];

/** Pandoc's rule for TeX math: `$` not followed by a space, closing `$` not preceded by a space nor followed by a digit. */
function mathEnd(text: string, start: number) {
  if (text[start + 1] === undefined || /\s/.test(text[start + 1]) || text[start + 1] === "$") return -1;
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
    } else if (text[index] === "$") {
      if (/\s/.test(text[index - 1]) || /\d/.test(text[index + 1] ?? "")) return -1;
      return index;
    }
  }
  return -1;
}

/**
 * Unicode text with CSL rich-text markup → BibTeX-safe LaTeX: escapes
 * `& % $ # _ { } ~ ^ \`, writes formatting as commands and nocase spans as
 * braces, dashes as `--`/`---`, curly double quotes as ``` `` '' ```, a
 * no-break space as `~`, and (bibtex dialect) accents and special letters as
 * macros. TeX math (`$…$`) is kept as it is.
 */
export function encodeLatex(text: string, dialect: LatexDialect = "biblatex") {
  let out = "";
  const stack: EncodeTag[] = [];
  const chars = text;
  let index = 0;
  while (index < chars.length) {
    const char = chars[index];
    if (char === "<") {
      const rest = chars.slice(index);
      const opened = OPEN_TAGS.find(([pattern]) => pattern.test(rest));
      if (opened) {
        const length = rest.match(opened[0])![0].length;
        out += opened[1];
        stack.push({ close: opened[2] });
        index += length;
        continue;
      }
      const closing = rest.match(/^<\/(i|b|sup|sub|span)>/);
      if (closing) {
        out += stack.pop()?.close ?? "";
        index += closing[0].length;
        continue;
      }
    }
    if (char === "$") {
      const end = mathEnd(chars, index);
      if (end > 0) {
        out += chars.slice(index, end + 1);
        index = end + 1;
        continue;
      }
    }
    index += 1;
    switch (char) {
      case "\\": out += "\\textbackslash{}"; continue;
      case "{": case "}": case "&": case "%": case "$": case "#": case "_": out += `\\${char}`; continue;
      case "~": out += "\\textasciitilde{}"; continue;
      case "^": out += "\\textasciicircum{}"; continue;
      case " ": out += "~"; continue;
      case "–": out += "--"; continue;
      case "—": out += "---"; continue;
      case "“": out += "``"; continue;
      case "”": out += "''"; continue;
      case "`": out += "\\textasciigrave{}"; continue;
      case "-":
        // A literal "--" must not turn into a dash.
        out += chars[index] === "-" ? "-{}" : "-";
        continue;
      case "'":
        out += chars[index] === "'" ? "'{}" : "'";
        continue;
    }
    if (dialect === "bibtex" && char.charCodeAt(0) > 127) {
      // Take the whole code point plus any combining marks that follow.
      let cluster = char;
      if (/[\uD800-\uDBFF]/.test(char) && index < chars.length) cluster += chars[index++];
      while (index < chars.length && /[̀-ͯ]/.test(chars[index])) cluster += chars[index++];
      const composed = cluster.normalize("NFC");
      out += BIBTEX_SYMBOLS[composed] ?? encodeAccented(composed) ?? composed;
      continue;
    }
    out += char;
  }
  while (stack.length) out += stack.pop()!.close;
  return out;
}

/**
 * Marks the words of a CSL rich-text title that BibTeX styles must not
 * recase: words with internal capitals ("iPhone") and acronyms of two or
 * more letters ("DNA", "COVID-19") get nocase spans. Text already in nocase
 * spans and math are left alone.
 */
export function markCaseProtection(title: string) {
  let out = "";
  let nocaseDepth = 0;
  const spanStack: boolean[] = [];
  const word = new RegExp(WORD_SOURCE, "gu");
  const protect = (segment: string) => {
    if (nocaseDepth > 0) return segment;
    // Math is split out so its letters are never wrapped.
    return segment.split(/(\$[^$]*\$)/).map((part, index) => (index % 2 === 1
      ? part
      : part.replace(word, (match) => (isSelfProtectingWord(match) && LETTER.test(match) ? NOCASE_OPEN + match + "</span>" : match)))).join("");
  };
  for (const piece of title.split(/(<\/?[a-zA-Z][^>]*>)/)) {
    if (!piece.startsWith("<")) {
      out += protect(piece);
      continue;
    }
    if (/^<span\b/.test(piece)) {
      const nocase = piece === NOCASE_OPEN;
      spanStack.push(nocase);
      if (nocase) nocaseDepth += 1;
    } else if (piece === "</span>" && spanStack.pop()) {
      nocaseDepth -= 1;
    }
    out += piece;
  }
  return out;
}

/**
 * A title for BibTeX export: words with internal capitals, acronyms and text
 * already in nocase spans end up in braces, so BibTeX styles that recase
 * titles keep them as written. Returns encoded LaTeX.
 */
export function protectTitleCase(title: string, dialect: LatexDialect = "bibtex") {
  return encodeLatex(markCaseProtection(title), dialect);
}
