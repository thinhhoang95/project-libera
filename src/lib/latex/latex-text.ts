/* Text, URLs and TeX checks shared by the converters that write LaTeX from
 * pasted content: clipboard HTML (codemirror/visual/html2latex.ts) and
 * Markdown (markdown-paste/). Deterministic and DOM-free. */

const ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", "$": "\\$", "&": "\\&", "#": "\\#", "%": "\\%", "_": "\\_",
  "~": "\\textasciitilde{}", "^": "\\textasciicircum{}",
};

/** Characters that print other glyphs under the default OT1 font encoding: escaped unless T1 is loaded. */
const OT1_ESCAPES: Record<string, string> = { "<": "\\textless{}", ">": "\\textgreater{}", "|": "\\textbar{}" };

/** Characters that LaTeX writes in math. */
export const MATH_SYMBOLS: Record<string, string> = {
  "α": "\\alpha", "β": "\\beta", "γ": "\\gamma", "δ": "\\delta", "ε": "\\epsilon", "ζ": "\\zeta", "η": "\\eta", "θ": "\\theta",
  "ι": "\\iota", "κ": "\\kappa", "λ": "\\lambda", "μ": "\\mu", "ν": "\\nu", "ξ": "\\xi", "π": "\\pi", "ρ": "\\rho", "σ": "\\sigma",
  "τ": "\\tau", "υ": "\\upsilon", "φ": "\\phi", "χ": "\\chi", "ψ": "\\psi", "ω": "\\omega", "Γ": "\\Gamma", "Δ": "\\Delta",
  "Θ": "\\Theta", "Λ": "\\Lambda", "Ξ": "\\Xi", "Π": "\\Pi", "Σ": "\\Sigma", "Φ": "\\Phi", "Ψ": "\\Psi", "Ω": "\\Omega",
  "≤": "\\le", "≥": "\\ge", "≠": "\\neq", "±": "\\pm", "∓": "\\mp", "×": "\\times", "÷": "\\div", "→": "\\rightarrow", "←": "\\leftarrow",
  "↔": "\\leftrightarrow", "⇒": "\\Rightarrow", "⇐": "\\Leftarrow", "⇔": "\\Leftrightarrow", "∞": "\\infty", "∑": "\\sum", "∏": "\\prod",
  "∫": "\\int", "≈": "\\approx", "≡": "\\equiv", "∼": "\\sim", "∝": "\\propto", "∈": "\\in", "∉": "\\notin", "⊂": "\\subset",
  "⊆": "\\subseteq", "⊃": "\\supset", "⊇": "\\supseteq", "∪": "\\cup", "∩": "\\cap", "∅": "\\emptyset", "∀": "\\forall",
  "∃": "\\exists", "∂": "\\partial", "∇": "\\nabla", "·": "\\cdot", "∘": "\\circ", "√": "\\surd", "°": "^\\circ", "′": "'",
  "ℝ": "\\mathbb{R}", "ℕ": "\\mathbb{N}", "ℤ": "\\mathbb{Z}", "ℚ": "\\mathbb{Q}", "ℂ": "\\mathbb{C}", "⋅": "\\cdot", "∗": "\\ast",
  "−": "-", "⟨": "\\langle", "⟩": "\\rangle", "‖": "\\|",
};

/** Characters with a text-mode spelling. */
const TEXT_SYMBOLS: Record<string, string> = {
  "“": "``", "”": "''", "‘": "`", "’": "'", "–": "--", "—": "---", "…": "\\ldots{}", " ": "~", "©": "\\copyright{}",
  "§": "\\S{}", "¶": "\\P{}", "†": "\\dag{}", "‡": "\\ddag{}", "•": "\\textbullet{}", "®": "\\textregistered{}", "™": "\\texttrademark{}",
  "​": "", "﻿": "",
};

/** Emoji and pictographs: pdfLaTeX has no glyph for them and stops with "Unicode character … not set up". */
export const EMOJI = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/gu;

export type LatexTextOptions = {
  /** Escape `<`, `>` and `|`, which OT1 prints as other glyphs (false when T1 is loaded). */
  ot1?: boolean;
  /**
   * Keep Unicode symbols as they are (XeLaTeX and LuaLaTeX) instead of
   * writing them as commands (α → `$\alpha$`).
   */
  unicode?: boolean;
  /** Drop emoji (pdfLaTeX cannot typeset them); `onDropped` counts them. */
  dropEmoji?: boolean;
  onDropped?: (count: number) => void;
};

/**
 * Text as LaTeX: special characters escaped, symbols written as commands
 * (wrapped in `$…$` in text: `$\alpha \le \beta$`), smart punctuation in its
 * TeX spelling. With no options, the behaviour html2latex has always had.
 */
export function escapeLatexText(text: string, options: LatexTextOptions = {}) {
  if (options.dropEmoji) {
    let count = 0;
    text = text.replace(EMOJI, (match) => {
      // ©, ®, ™, ↔ and the like are pictographs to Unicode but have a TeX spelling: kept (without an emoji variation selector).
      const base = match.replace(/️/g, "");
      if ([...base].length === 1 && (TEXT_SYMBOLS[base] !== undefined || MATH_SYMBOLS[base] !== undefined)) return base;
      count++;
      return "";
    });
    if (count) options.onDropped?.(count);
  }
  let out = "";
  let math = "";
  const flushMath = () => { if (math) { out += `$${math}$`; math = ""; } };
  for (const char of text) {
    const symbol = options.unicode ? undefined : MATH_SYMBOLS[char];
    if (symbol !== undefined) {
      // Neighbouring math symbols share one formula: `$\alpha \le \beta$`.
      math += math && /[A-Za-z]$/.test(math) && /^\\?[A-Za-z]/.test(symbol) ? ` ${symbol}` : symbol;
      continue;
    }
    if (math && char === " ") { math += " "; continue; }
    if (math) {
      // Spaces after the symbols separate them from the text: they go after the formula, not into it.
      const spaces = /\s*$/.exec(math)![0];
      math = math.trimEnd();
      flushMath();
      out += spaces;
    }
    out += ESCAPES[char] ?? (options.ot1 ? OT1_ESCAPES[char] : undefined) ?? (options.unicode && char !== "​" && char !== "﻿" && char !== " " ? undefined : TEXT_SYMBOLS[char]) ?? char;
  }
  const spaces = /\s*$/.exec(math)![0];
  math = math.trimEnd();
  flushMath();
  return out + spaces;
}

/** Commands whose argument is text, even inside a formula: a math command there needs `\ensuremath`. */
const TEXT_ARGUMENT_COMMANDS = /^(?:text|textrm|textit|textbf|textsf|texttt|textup|textsl|textsc|textmd|textnormal|emph|mbox|hbox|fbox|intertext|shortintertext)$/;

/**
 * Unicode symbols inside a formula as commands (pdfLaTeX): `α^2` → `\alpha^2`.
 * Inside a text argument (`\text{α}`) they are wrapped in `\ensuremath`, since
 * math commands cannot stand in text; a `$…$` inside it is math again.
 */
export function mathSymbolsToCommands(tex: string) {
  let out = "";
  const chars = Array.from(tex);
  // One entry per open brace: whether its group is text. `inlineMath`: inside `$…$` within a text group.
  const groups: boolean[] = [];
  let pendingText = false;
  let inlineMath = false;
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    if (char === "\\") {
      // A command (or an escaped character) is copied whole; a text command makes its next group text.
      const name = /^\\(?:[A-Za-z]+|.)/.exec(chars.slice(index, index + 40).join(""))?.[0] ?? "\\";
      out += name;
      index += Array.from(name).length - 1;
      pendingText = TEXT_ARGUMENT_COMMANDS.test(name.slice(1));
      continue;
    }
    if (char === "{") { groups.push(pendingText || (!!groups[groups.length - 1] && !inlineMath)); pendingText = false; out += char; continue; }
    if (char === "}") { groups.pop(); out += char; continue; }
    if (!/\s/.test(char)) pendingText = false;
    const inText = !!groups[groups.length - 1];
    if (char === "$" && inText) inlineMath = !inlineMath;
    const symbol = MATH_SYMBOLS[char];
    if (symbol === undefined) { out += char; continue; }
    if (inText && !inlineMath) { out += `\\ensuremath{${symbol}}`; continue; }
    out += symbol;
    // `\alpha` followed by a letter would read as one longer command.
    if (/[A-Za-z]$/.test(symbol) && /^[A-Za-z]/.test(chars[index + 1] ?? "")) out += " ";
  }
  return out;
}

/** A URL as an `\href`/`\url` argument: characters that would end or change the argument are percent-encoded, `%` and `#` escaped. */
export function latexUrl(href: string) {
  const encoded = href.replace(/[\\{}\s^`"<>|]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  return encoded.replace(/[%#]/g, (char) => `\\${char}`);
}

/** Commands that read or write files, run programs or change how TeX reads: never pasted as LaTeX. */
export const UNSAFE_TEX_COMMAND = /\\(?:input|include|InputIfFileExists|IfFileExists|openin|openout|closein|closeout|newread|newwrite|read|readline|write|immediate|special|catcode|uccode|lccode|mathcode|sfcode|delcode|def|gdef|edef|xdef|let|futurelet|csname|scantokens|everyeof|everypar|everymath|everydisplay|newcommand|renewcommand|providecommand|DeclareRobustCommand|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|newenvironment|renewenvironment|usepackage|RequirePackage|documentclass|directlua|latelua|luaexec|ShellEscape|write18|verb|makeatletter|makeatother|endinput|lstinputlisting|verbatiminput|VerbatimInput|BVerbatimInput|LVerbatimInput|inputminted|includepdf|includestandalone|includesvg|subfile|import|subimport|inputfrom|includefrom|subinputfrom|subincludefrom|externaldocument|pdfobj|pdfximage|pdfrefximage|pdffiledump|pdffilemoddate|pdffilesize|pdfmdfivesum|pdfshellescape|filecontents)(?![A-Za-z@])/;

/** Environments that write files or run code: never pasted as LaTeX. */
const UNSAFE_ENVIRONMENT = /\\begin\s*\{\s*(?:filecontents\*?|filecontentsdef|luacode\*?|luacodestar|pycode|sagesilent|sageblock|minted|writefile)\s*\}/;

/** `^^5c` is a backslash to TeX (and `^^M` a line end): such notation could spell any command, so it is never kept. */
const CARET_NOTATION = /\^\^/;

/** Whether braces balance (escaped braces ignored) and never close more than they opened. */
export function hasBalancedBraces(tex: string) {
  let depth = 0;
  for (let i = 0; i < tex.length; i++) {
    if (tex[i] === "\\") { i++; continue; }
    if (tex[i] === "{") depth++;
    else if (tex[i] === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

/** Whether `\begin{…}` and `\end{…}` inside close what they open, in order. */
export function hasBalancedEnvironments(tex: string) {
  const open: string[] = [];
  for (const match of tex.matchAll(/\\(begin|end)\s*\{([^}]*)\}/g)) {
    if (match[1] === "begin") open.push(match[2].trim());
    else if (open.pop() !== match[2].trim()) return false;
  }
  return open.length === 0;
}

/**
 * Whether TeX from a clipboard's math annotation stays inside the formula it
 * is pasted as: balanced braces, no math delimiters, comments, paragraph
 * breaks or `\end{…}` that could close it, and nothing that reads files or
 * changes how TeX reads (`\input`, `\catcode`, `\def`…).
 */
export function isSafeMathTex(tex: string) {
  if (/[$%]|\n\s*\n|\\[()[\]]|\\(?:begin|end)\s*\{\s*document\s*\}/.test(tex.replace(/\\[$%]/g, ""))) return false;
  if (UNSAFE_TEX_COMMAND.test(tex) || UNSAFE_ENVIRONMENT.test(tex) || CARET_NOTATION.test(tex)) return false;
  // Environments inside (matrices, cases) must close what they open, in order.
  return hasBalancedBraces(tex) && hasBalancedEnvironments(tex);
}

/**
 * Whether LaTeX written by hand inside pasted text may be kept as LaTeX:
 * balanced, closing what it opens, no comments, nothing that reads files or
 * changes how TeX reads, and no `\begin{document}`.
 */
export function isSafeRawLatex(tex: string) {
  if (/(?<!\\)%|\\(?:begin|end)\s*\{\s*document\s*\}/.test(tex)) return false;
  if (UNSAFE_TEX_COMMAND.test(tex) || UNSAFE_ENVIRONMENT.test(tex) || CARET_NOTATION.test(tex)) return false;
  return hasBalancedBraces(tex) && hasBalancedEnvironments(tex);
}

/** Whether a custom template or other one-off TeX fragment is free of file access, definitions and `^^` notation. */
export function hasUnsafeTex(tex: string) {
  return UNSAFE_TEX_COMMAND.test(tex) || UNSAFE_ENVIRONMENT.test(tex) || CARET_NOTATION.test(tex);
}

/**
 * Indent every line (with `skipFirst`, every line after the first), except
 * the inside of verbatim blocks, whose spaces are content.
 */
export function indentLines(text: string, indent: string, skipFirst = false) {
  let verbatim: string | null = null;
  return text.split("\n").map((line, index) => {
    if (verbatim) {
      if (line.includes(`\\end{${verbatim}}`)) verbatim = null;
      return line;
    }
    const begin = /\\begin\{(verbatim\*?|lstlisting|Verbatim)\}/.exec(line);
    if (begin && !line.includes(`\\end{${begin[1]}}`)) verbatim = begin[1];
    return line && !(skipFirst && index === 0) ? indent + line : line;
  }).join("\n");
}

/** A GitHub-style heading slug: lower case, punctuation dropped, spaces as hyphens. */
export function headingSlug(text: string) {
  return text.toLowerCase().trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** A label from free text: ASCII letters, digits and hyphens only (`fig:` and the like are added by the caller). */
export function labelSlug(text: string, fallback = "item") {
  const slug = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return slug || fallback;
}

/** `base`, or `base-2`, `base-3`… when taken. Records the result in `taken`. */
export function uniqueLabel(base: string, taken: Set<string>) {
  let label = base;
  for (let index = 2; taken.has(label); index++) label = `${base}-${index}`;
  taken.add(label);
  return label;
}

/** Whether a label typed by the user can be written inside `\label{…}` as is. */
export function isValidLabel(label: string) {
  return /^[A-Za-z0-9:._\-/+]+$/.test(label);
}
