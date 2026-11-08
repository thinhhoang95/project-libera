/* Characters that LaTeX writes as commands, for the Visual mode. Each is
 * drawn as the character it typesets; anything not listed stays as source. */

/** `\%` and the other escaped characters. */
export const CONTROL_SYMBOLS: Record<string, string> = {
  "\\%": "%", "\\&": "&", "\\_": "_", "\\#": "#", "\\$": "$", "\\{": "{", "\\}": "}",
  "\\,": " ", "\\;": " ", "\\:": " ", "\\ ": " ", "\\!": "", "\\/": "", "\\-": "­",
  "\\@": "",
};

/** Text-mode commands with no arguments. */
export const SYMBOL_COMMANDS: Record<string, string> = {
  "\\ldots": "…", "\\dots": "…", "\\textellipsis": "…", "\\textendash": "–", "\\textemdash": "—",
  "\\textbullet": "•", "\\textperiodcentered": "·", "\\S": "§", "\\P": "¶", "\\copyright": "©", "\\textcopyright": "©",
  "\\textregistered": "®", "\\texttrademark": "™", "\\dag": "†", "\\ddag": "‡", "\\textdagger": "†", "\\textdaggerdbl": "‡",
  "\\textbackslash": "\\", "\\textasciitilde": "~", "\\textasciicircum": "^", "\\textbar": "|", "\\textless": "<", "\\textgreater": ">",
  "\\textquoteleft": "‘", "\\textquoteright": "’", "\\textquotedblleft": "“", "\\textquotedblright": "”", "\\guillemotleft": "«", "\\guillemotright": "»",
  "\\pounds": "£", "\\euro": "€", "\\textdegree": "°", "\\textmu": "µ", "\\i": "ı", "\\j": "ȷ", "\\ss": "ß", "\\ae": "æ", "\\AE": "Æ",
  "\\oe": "œ", "\\OE": "Œ", "\\o": "ø", "\\O": "Ø", "\\aa": "å", "\\AA": "Å", "\\l": "ł", "\\L": "Ł",
  "\\LaTeX": "LaTeX", "\\TeX": "TeX", "\\LaTeXe": "LaTeX2ε", "\\BibTeX": "BibTeX", "\\quad": " ", "\\qquad": "  ",
  "\\enspace": " ", "\\thinspace": " ", "\\nobreakspace": " ", "\\slash": "/", "\\textvisiblespace": "␣",
};

const ACCENTS: Record<string, string> = {
  "'": "́", "`": "̀", "^": "̂", "\"": "̈", "~": "̃", "=": "̄", ".": "̇",
  "u": "̆", "v": "̌", "H": "̋", "c": "̧", "k": "̨", "r": "̊", "d": "̣", "b": "̱",
};

/** An accent at the start of `text` (`\'e`, `\'{e}`, `\c{c}`, `\v s`), as the accented character and the length it covers. */
export function readAccent(text: string): { char: string; length: number } | null {
  const match = /^\\(['`^"~=.]|[uvHckrdb](?![A-Za-z]))\s*(?:\{\s*(\\[ij]|[A-Za-z])\s*\}|(\\[ij](?![A-Za-z])|[A-Za-z]))/.exec(text);
  if (!match) return null;
  const mark = ACCENTS[match[1]];
  let base = match[2] ?? match[3];
  if (base === "\\i") base = "ı";
  if (base === "\\j") base = "ȷ";
  return { char: (base + mark).normalize("NFC"), length: match[0].length };
}

/** Font size switches (`{\small 1}`): the editor keeps one size, so they draw nothing. */
export const SIZE_COMMAND = /^\\(?:tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)$/;

/** `\textcircled{1}` as ①: digits 0–20 and letters; null for anything else. Size switches inside are ignored. */
export function circledText(inner: string): string | null {
  const text = inner.replace(/\\(?:tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)(?![A-Za-z])/g, "").replace(/[{}\s]/g, "");
  if (/^(?:1\d|20|\d)$/.test(text)) return text === "0" ? "⓪" : String.fromCodePoint(0x2460 + Number(text) - 1);
  if (/^[a-z]$/.test(text)) return String.fromCodePoint(0x24d0 + text.charCodeAt(0) - 97);
  if (/^[A-Z]$/.test(text)) return String.fromCodePoint(0x24b6 + text.charCodeAt(0) - 65);
  return null;
}

/** Dashes and TeX quotes in running text, with the characters they typeset. */
export const TEXT_LIGATURES = /---|--|``|''/g;
export const LIGATURE_CHARS: Record<string, string> = { "---": "—", "--": "–", "``": "“", "''": "”" };

/** `\today`, as TeX would print it in English. */
export function todayText() {
  return new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/** xcolor's base names, and the `HTML` and `rgb` models, as a CSS colour; null for anything else. */
export function cssColor(model: string | null, value: string): string | null {
  const trimmed = value.trim();
  if (model === "HTML" && /^[0-9A-Fa-f]{6}$/.test(trimmed)) return `#${trimmed}`;
  if (model === "rgb") {
    const parts = trimmed.split(",").map(Number);
    if (parts.length === 3 && parts.every((part) => part >= 0 && part <= 1)) return `rgb(${parts.map((part) => Math.round(part * 255)).join(",")})`;
    return null;
  }
  if (model === "RGB") {
    const parts = trimmed.split(",").map(Number);
    if (parts.length === 3 && parts.every((part) => part >= 0 && part <= 255)) return `rgb(${parts.join(",")})`;
    return null;
  }
  if (model) return null;
  const named: Record<string, string> = {
    red: "#dc2626", green: "#16a34a", blue: "#2563eb", cyan: "#0891b2", magenta: "#c026d3", yellow: "#ca8a04", black: "currentColor",
    white: "#ffffff", gray: "#6b7280", darkgray: "#4b5563", lightgray: "#9ca3af", brown: "#92400e", lime: "#65a30d", olive: "#6b7d1f",
    orange: "#ea580c", pink: "#db2777", purple: "#7e22ce", teal: "#0d9488", violet: "#7c3aed",
  };
  // `red!50` and other mixes are drawn as their base colour.
  const base = /^([a-z]+)(?:!\d+(?:![a-z]+)?)?$/.exec(trimmed)?.[1];
  return base && named[base] ? named[base] : null;
}
