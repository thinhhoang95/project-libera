/* Characters that LaTeX writes as commands, for the Visual mode. Each is
 * drawn as the character it typesets; anything not listed stays as source. */

/** `\%` and the other escaped characters. */
export const CONTROL_SYMBOLS: Record<string, string> = {
  "\\%": "%", "\\&": "&", "\\_": "_", "\\#": "#", "\\$": "$", "\\{": "{", "\\}": "}",
  "\\,": " ", "\\;": " ", "\\:": " ", "\\ ": " ", "\\!": "", "\\/": "", "\\-": "­",
  "\\@": "",
  // A backslash before a line break or tab is a space.
  "\\\n": " ", "\\\t": " ",
};

/** Text-mode commands with no arguments. */
export const SYMBOL_COMMANDS: Record<string, string> = {
  "\\ldots": "…", "\\dots": "…", "\\textellipsis": "…", "\\textendash": "–", "\\textemdash": "—",
  "\\textbullet": "•", "\\textperiodcentered": "·", "\\S": "§", "\\P": "¶", "\\copyright": "©", "\\textcopyright": "©",
  "\\textregistered": "®", "\\texttrademark": "™", "\\dag": "†", "\\ddag": "‡", "\\textdagger": "†", "\\textdaggerdbl": "‡",
  // amssymb's tick, in text (results tables).
  "\\checkmark": "✓",
  "\\textbackslash": "\\", "\\textasciitilde": "~", "\\textasciicircum": "^", "\\textbar": "|", "\\textless": "<", "\\textgreater": ">",
  "\\textquoteleft": "‘", "\\lq": "‘", "\\rq": "’","\\textquoteright": "’", "\\textquotedblleft": "“", "\\textquotedblright": "”", "\\guillemotleft": "«", "\\guillemotright": "»",
  "\\pounds": "£", "\\euro": "€", "\\textdegree": "°", "\\textmu": "µ", "\\i": "ı", "\\j": "ȷ", "\\ss": "ß", "\\ae": "æ", "\\AE": "Æ",
  "\\oe": "œ", "\\OE": "Œ", "\\o": "ø", "\\O": "Ø", "\\aa": "å", "\\AA": "Å", "\\l": "ł", "\\L": "Ł",
  "\\LaTeX": "LaTeX", "\\TeX": "TeX", "\\LaTeXe": "LaTeX2ε", "\\BibTeX": "BibTeX", "\\quad": " ", "\\qquad": "  ",
  "\\enspace": " ", "\\thinspace": " ", "\\nobreakspace": " ", "\\slash": "/", "\\textvisiblespace": "␣",
  // textcomp's symbols.
  "\\texttimes": "×", "\\textdiv": "÷", "\\textpm": "±", "\\textminus": "−", "\\textonehalf": "½", "\\textonequarter": "¼", "\\textthreequarters": "¾",
  "\\textsection": "§", "\\textparagraph": "¶", "\\textcent": "¢", "\\textyen": "¥", "\\texteuro": "€", "\\textsterling": "£", "\\textdollar": "$",
  "\\textnumero": "№", "\\textcelsius": "℃", "\\textperthousand": "‰", "\\textasteriskcentered": "∗", "\\textquotesingle": "'", "\\textlnot": "¬",
  "\\textohm": "Ω", "\\textleftarrow": "←", "\\textrightarrow": "→", "\\textuparrow": "↑", "\\textdownarrow": "↓", "\\textunderscore": "_",
  "\\textbraceleft": "{", "\\textbraceright": "}", "\\textordfeminine": "ª", "\\textordmasculine": "º", "\\textsuperscriptone": "¹", "\\textmusicalnote": "♪",
  // Letters of other alphabets.
  "\\th": "þ", "\\TH": "Þ", "\\dh": "ð", "\\DH": "Ð", "\\ng": "ŋ", "\\NG": "Ŋ", "\\dj": "đ", "\\DJ": "Đ",
};

/**
 * Commands that wrap text, by name: what each of their `{…}` arguments shows, in order (a class for its text, "" for
 * plain text, null for an argument that is hidden), and what they print around it. Their markup is hidden; their text is
 * edited in place. `package`: drawn only with that package (a name other packages also use).
 */
export const TEXT_WRAPPERS: Record<string, { args: Array<string | null>; open?: string; close?: string; package?: string }> = {
  // The changes package's tracked changes.
  "\\added": { args: ["cm-vis-added"] },
  "\\deleted": { args: ["cm-vis-deleted"] },
  "\\replaced": { args: ["cm-vis-added", "cm-vis-deleted"] },
  "\\highlight": { args: ["cm-vis-hl"] },
  "\\comment": { args: ["cm-vis-change-comment"], package: "changes" },
  // soul's highlight, strike-out, underline, letter spacing and capitals.
  "\\hl": { args: ["cm-vis-hl"] },
  "\\st": { args: ["cm-vis-s"] },
  "\\ul": { args: ["cm-vis-u"] },
  "\\so": { args: ["cm-vis-so"] },
  "\\caps": { args: ["cm-vis-sc"] },
  // Boxes in the text: a framed one has a frame; the others are their text.
  "\\fbox": { args: ["cm-vis-fbox"] },
  "\\framebox": { args: ["cm-vis-fbox"] },
  "\\makebox": { args: [""] },
  "\\parbox": { args: [null, ""] },
  // url's and hyperref's unlinked paths, in the typewriter face.
  "\\nolinkurl": { args: ["cm-vis-tt"] },
  "\\path": { args: ["cm-vis-tt"] },
  // hyperref's internal links and anchors (`\hyperlink{target}{text}`, Pandoc's `\hypertarget{id}{}`): their text, the target hidden.
  "\\hyperlink": { args: [null, ""] },
  "\\hypertarget": { args: [null, ""] },
  // A note in the margin: a small note where it is written.
  "\\marginpar": { args: ["cm-vis-margin-note"] },
  "\\marginnote": { args: ["cm-vis-margin-note"] },
  // csquotes' `\enquote{…}`: the text in quotation marks.
  "\\enquote": { args: [""], open: "“", close: "”" },
  // A box as wide as its content, showing nothing: a space where it is (`\phantom`), or nothing (`\vphantom`).
};

/** pifont's `\ding{n}` (Zapf Dingbats) used in papers: ticks and crosses in comparison tables, stars, circled numbers. */
export const DINGBATS: Record<string, string> = {
  "51": "✓", "52": "✔", "53": "✕", "54": "✖", "55": "✗", "56": "✘", "70": "✦", "72": "★", "73": "☆", "108": "●", "109": "❍", "110": "■", "111": "❏",
  "113": "❑", "115": "▲", "116": "▼", "117": "◆", "118": "❖", "228": "➤", "232": "➨", "43": "☛",
  ...Object.fromEntries(Array.from({ length: 10 }, (_, n) => [String(172 + n), String.fromCodePoint(0x2460 + n)])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, n) => [String(182 + n), String.fromCodePoint(0x2776 + n)])),
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

/** Font switches (`{\bf …}`, `{\itshape …}`): the class that styles what follows them in their group. */
export const FONT_SWITCHES: Record<string, string> = {
  "\\bf": "cm-vis-b", "\\bfseries": "cm-vis-b", "\\it": "cm-vis-i", "\\itshape": "cm-vis-i", "\\sl": "cm-vis-i", "\\slshape": "cm-vis-i",
  "\\em": "cm-vis-em", "\\tt": "cm-vis-tt", "\\ttfamily": "cm-vis-tt", "\\sc": "cm-vis-sc", "\\scshape": "cm-vis-sc",
  "\\sf": "cm-vis-sf", "\\sffamily": "cm-vis-sf", "\\mdseries": "cm-vis-md",
  "\\rm": "cm-vis-rm", "\\rmfamily": "cm-vis-rm", "\\upshape": "cm-vis-rm", "\\normalfont": "cm-vis-rm",
  // Bold formulas (`\boldmath$3.3\cdot 10^{18}$` in a results table).
  "\\boldmath": "cm-vis-b",
};

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

/**
 * xcolor's base names, the document's own (`\definecolor`, `\colorlet`, in `colors`), and the `HTML`, `rgb`,
 * `RGB`, `gray` and `cmyk` models, as a CSS colour; null for anything else.
 */
export function cssColor(model: string | null, value: string, colors?: ReadonlyMap<string, { model: string; value: string }>, depth = 0): string | null {
  const trimmed = value.trim();
  if (model === "HTML" && /^[0-9A-Fa-f]{6}$/.test(trimmed)) return `#${trimmed}`;
  if (model === "gray") {
    const level = Number(trimmed);
    return trimmed && level >= 0 && level <= 1 ? `rgb(${Array(3).fill(Math.round(level * 255)).join(",")})` : null;
  }
  if (model === "cmyk") {
    const [c, m, y, k] = trimmed.split(",").map(Number);
    if ([c, m, y, k].some((part) => !(part >= 0 && part <= 1))) return null;
    return `rgb(${[c, m, y].map((part) => Math.round(255 * (1 - part) * (1 - k))).join(",")})`;
  }
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
  const base = /^([A-Za-z][\w.-]*)(?:!\d+(?:![A-Za-z][\w.-]*)?)?$/.exec(trimmed)?.[1];
  const own = base ? colors?.get(base) : undefined;
  if (own && depth < 8) return cssColor(own.model || null, own.value, colors, depth + 1);
  if (base && DVIPS_NAMES[base]) return cssColor("cmyk", DVIPS_NAMES[base]);
  return base && named[base] ? named[base] : null;
}

/** xcolor's `dvipsnames` (HANK's `\color{MidnightBlue}` title), as their CMYK values in dvipsnam.def. */
const DVIPS_NAMES: Record<string, string> = {
  Apricot: "0,0.32,0.52,0", Aquamarine: "0.82,0,0.30,0", Bittersweet: "0,0.75,1,0.24", BlueGreen: "0.85,0,0.33,0", BlueViolet: "0.86,0.91,0,0.04",
  BrickRed: "0,0.89,0.94,0.28", Brown: "0,0.81,1,0.60", BurntOrange: "0,0.51,1,0", CadetBlue: "0.62,0.57,0.23,0", CarnationPink: "0,0.63,0,0",
  Cerulean: "0.94,0.11,0,0", CornflowerBlue: "0.65,0.13,0,0", Dandelion: "0,0.29,0.84,0", DarkOrchid: "0.40,0.80,0.20,0", Emerald: "1,0,0.50,0",
  ForestGreen: "0.91,0,0.88,0.12", Fuchsia: "0.47,0.91,0,0.08", Goldenrod: "0,0.10,0.84,0", GreenYellow: "0.15,0,0.69,0", JungleGreen: "0.99,0,0.52,0",
  Lavender: "0,0.48,0,0", LimeGreen: "0.50,0,1,0", Mahogany: "0,0.85,0.87,0.35", Maroon: "0,0.87,0.68,0.32", Melon: "0,0.46,0.50,0",
  MidnightBlue: "0.98,0.13,0,0.43", Mulberry: "0.34,0.90,0,0.02", NavyBlue: "0.94,0.54,0,0", OliveGreen: "0.64,0,0.95,0.40", Orange: "0,0.61,0.87,0",
  OrangeRed: "0,1,0.50,0", Orchid: "0.32,0.64,0,0", Peach: "0,0.50,0.70,0", Periwinkle: "0.57,0.55,0,0", PineGreen: "0.92,0,0.59,0.25",
  Plum: "0.50,1,0,0", ProcessBlue: "0.96,0,0,0", Purple: "0.45,0.86,0,0", RawSienna: "0,0.72,1,0.45", Red: "0,1,1,0", RedOrange: "0,0.77,0.87,0",
  RedViolet: "0.07,0.90,0,0.34", Rhodamine: "0,0.82,0,0", RoyalBlue: "1,0.50,0,0", RoyalPurple: "0.75,0.90,0,0", RubineRed: "0,1,0.13,0",
  Salmon: "0,0.53,0.38,0", SeaGreen: "0.69,0,0.50,0", Sepia: "0,0.83,1,0.70", SkyBlue: "0.62,0,0.12,0", SpringGreen: "0.26,0,0.76,0",
  Tan: "0.14,0.42,0.56,0", TealBlue: "0.86,0,0.34,0.02", Thistle: "0.12,0.59,0,0", Turquoise: "0.85,0,0.20,0", Violet: "0.79,0.88,0,0",
  VioletRed: "0,0.81,0,0", WildStrawberry: "0,0.96,0.39,0", YellowGreen: "0.44,0,0.74,0", YellowOrange: "0,0.42,1,0",
  Blue: "1,1,0,0", Green: "1,0,1,0", Cyan: "1,0,0,0", Magenta: "0,1,0,0", Yellow: "0,0,1,0", Gray: "0,0,0,0.50",
};
