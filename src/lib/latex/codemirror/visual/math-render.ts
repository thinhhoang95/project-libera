import katex from "katex";
import { readGroup, readOptional, TEX_GROUPS } from "../../../macros/core";
import { splitMathRows, stripTexComments } from "../../macros/numbering";
import { siunitxForKatex } from "./siunitx";
import { cssColor } from "./symbols";

/* KaTeX for the Visual mode. Formulas arrive with the document's macros
 * already expanded (macros/expand.ts). A formula KaTeX cannot parse is not
 * drawn: it stays as source, so the Visual mode never shows a formula other
 * than the one in the file. Equation numbers come from the numbering pass,
 * set on KaTeX's number slots (`.eqn-num`), because KaTeX numbers with a CSS
 * counter and cannot number rows with `\tag`. */

const cache = new Map<string, string | null>();
const CACHE_LIMIT = 3000;

/** HTML for a formula, or null when KaTeX cannot render it. Cached. */
/** Package commands KaTeX lacks, as KaTeX macros: nicefrac/xfrac's slanted fractions, bbm/dsfont's blackboard letters. */
export const KATEX_MACROS: Record<string, string> = {
  "\\nicefrac": "{}^{#1}\\!/\\!{}_{#2}",
  "\\sfrac": "{}^{#1}\\!/\\!{}_{#2}",
  "\\mathbbm": "\\mathbb{#1}",
  "\\mathds": "\\mathbb{#1}",
  "\\bbm": "\\mathbb{#1}",
  // LaTeX's text box and old slanted switch in formulas (`$\left[ \mbox{UNK} \right]$`, `$\text{\sl N}$`).
  "\\mbox": "\\text{#1}",
  "\\sl": "\\it",
  // relsize's one-step larger and smaller formulas (YOLO's `\mathlarger{\mathbbm{1}}`).
  "\\mathlarger": "{\\large #1}",
  "\\mathsmaller": "{\\small #1}",
  // Spacing and robustness commands that draw nothing in a formula: the italic correction (O'Donnell's
  // `\Var` is `\mathop{\bf Var\/}`), `\protect`, xspace's `\xspace`, `\@` and `\leavevmode`.
  "\\/": "",
  "\\protect": "",
  "\\xspace": "",
  "\\@": "",
  "\\leavevmode": "",
  "\\ensuremath": "#1",
  // The TeX.SX `\widebar` (a bar sized to its argument, built from box arithmetic the reader leaves out): a bar.
  "\\widebar": "\\overline{#1}",
  // eurosym's sign in a formula (the minimum-wage paper's `$\euro 8.50$`).
  "\\euro": "\\text{€}",
  "\\EUR": "\\text{€}\\,#1",
  // amsmath's capital accents (a macro paper's `\Tilde{\pi}_1`), which KaTeX lacks: the accents they are.
  "\\Bar": "\\bar", "\\Tilde": "\\tilde", "\\Hat": "\\hat", "\\Check": "\\check", "\\Acute": "\\acute",
  "\\Grave": "\\grave", "\\Dot": "\\dot", "\\Ddot": "\\ddot", "\\Breve": "\\breve", "\\Vec": "\\vec",
  // amsthm's `\qedhere` at the end of a display in a proof (2204.14024): the proof's end mark is drawn at
  // `\end{proof}`, so it draws nothing here; `\qed` is the end mark itself.
  "\\qedhere": "",
  "\\qed": "\\square",
  // stmaryrd/mathabx's ⋤ and ⋥ (Larrauri & Živný's `\lneqsg`), which KaTeX lacks: the relation over ≠, as drawn.
  "\\sqsubsetneq": "\\mathrel{\\underset{\\neq}{\\sqsubset}}",
  "\\sqsupsetneq": "\\mathrel{\\underset{\\neq}{\\sqsupset}}",
  // TeX's null delimiter width, in cmathml's `\left.\kern-\nulldelimiterspace` (Larrauri & Živný's `\Crestrict`).
  "\\nulldelimiterspace": "1.2pt",
  // AASTeX's solar and Earth symbols (2611.08676's `\left(…\right)_{\sun}`).
  "\\sun": "\\odot",
  "\\earth": "\\oplus",
  // TeX's delimiters KaTeX lacks (2611.11568's `\Big\arrowvert`): the bars they draw. `\bracevert`, a brace's middle
  // piece, is a thicker bar in TeX.
  "\\arrowvert": "\\vert",
  "\\Arrowvert": "\\Vert",
  "\\bracevert": "\\vert",
  // The slashed package's Feynman slash (2611.11568's `\slashed{k}`, `\slashed n_1`): a `/` centred over the
  // argument, as slashed.sty sets it. The outer clap moves half the argument's width in, the inner one centres the slash.
  "\\slashed": "{\\mathclap{\\hphantom{#1}\\mathclap{/}}#1}",
  // mathtools' and amsmath's commands KaTeX lacks, as what they draw: a left superscript and subscript (`\prescript`),
  // `\sideset`'s scripts beside an operator, `\mleft`/`\mright` (delimiters without the inner spacing), `\mspace`.
  "\\prescript": "{}^{#1}_{#2}{#3}",
  "\\sideset": "\\mathop{{}#1\\!#3\\nolimits#2}",
  "\\mleft": "\\left",
  "\\mright": "\\right",
  "\\mspace": "\\mkern#1",
  // Spacing and struts: `\hfill` between a formula's parts as a wide space, `\strut` as `\mathstrut`.
  "\\hfill": "\\qquad",
  "\\strut": "\\mathstrut",
  // Dots, bars and big operators of LaTeX, mathdots and mathabx.
  "\\hdots": "\\ldots",
  "\\iddots": "\\mathinner{\\text{⋰}}",
  "\\relbar": "\\mathrel{-}",
  "\\Relbar": "\\mathrel{=}",
  "\\bigtimes": "\\mathop{\\mathchoice{\\vcenter{\\hbox{\\huge$\\times$}}}{\\vcenter{\\hbox{\\Large$\\times$}}}{\\times}{\\times}}",
  "\\idotsint": "\\mathop{\\int\\!\\cdots\\!\\int}\\nolimits",
  "\\iiiint": "\\mathop{\\int\\!\\!\\!\\!\\int\\!\\!\\!\\!\\int\\!\\!\\!\\!\\int}\\nolimits",
  // Old and unicode-math font commands: `\mit` (italic), `\mathbfit` (bold italic).
  "\\mit": "\\mathit",
  "\\mathbfit": "\\boldsymbol{#1}",
  // upgreek's upright Greek letters (KaTeX's own Greek is italic): the letters as text, which is upright.
  ...Object.fromEntries("alpha α beta β gamma γ delta δ epsilon ϵ varepsilon ε zeta ζ eta η theta θ vartheta ϑ iota ι kappa κ lambda λ mu μ nu ν xi ξ pi π varpi ϖ rho ρ varrho ϱ sigma σ varsigma ς tau τ upsilon υ phi ϕ varphi φ chi χ psi ψ omega ω Gamma Γ Delta Δ Theta Θ Lambda Λ Xi Ξ Pi Π Sigma Σ Upsilon Υ Phi Φ Psi Ψ Omega Ω"
    .split(" ").reduce<Array<[string, string]>>((pairs, word, index, words) => (index % 2 ? pairs : [...pairs, [`\\up${word}`, `\\mathord{\\text{${words[index + 1]}}}`]]), [])),
  // wasysym and stmaryrd symbols KaTeX lacks, as their characters.
  "\\Lbag": "\\mathopen{\\text{⟅}}",
  "\\Rbag": "\\mathclose{\\text{⟆}}",
  "\\mapsfrom": "\\mathrel{\\text{↤}}",
  "\\Mapsfrom": "\\mathrel{\\text{⤆}}",
  "\\Mapsto": "\\mathrel{\\text{⤇}}",
  "\\sslash": "\\mathbin{\\text{⫽}}",
  "\\oblong": "\\mathord{\\text{▯}}",
  "\\lightning": "\\mathord{\\text{↯}}",
  "\\male": "\\mathord{\\text{♂}}",
  "\\female": "\\mathord{\\text{♀}}",
  "\\smiley": "\\mathord{\\text{☺}}",
  "\\frownie": "\\mathord{\\text{☹}}",
  "\\diameter": "\\mathord{\\text{⌀}}",
  "\\invneg": "\\mathord{\\text{⌐}}",
  "\\bigsqcap": "\\mathop{\\text{⨅}}",
  // Text symbols KaTeX lacks, inside `\text{…}` (`\text{\textmu m}`), as their characters.
  "\\textmu": "\\text{µ}",
  "\\textperiodcentered": "\\text{·}",
  "\\guillemotleft": "\\text{«}",
  "\\guillemotright": "\\text{»}",
  "\\slash": "\\text{/}",
  "\\textvisiblespace": "\\text{␣}",
  "\\l": "\\text{ł}",
  "\\L": "\\text{Ł}",
  "\\k": "\\text{#1̨}",
  // breqn's `\condition{for all x}` after a dmath's formula: a comma and the text.
  "\\condition": ",\\quad\\text{#1}",
};

/** TeX's `\ooalign` rows (`\crcr` or `\cr` at the top level of its group). */
function ooalignRows(content: string) {
  const rows: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === "\\") {
      const name = /^\\(?:[A-Za-z@]+|.)/.exec(content.slice(i, i + 16))?.[0] ?? "\\";
      if (depth === 0 && (name === "\\cr" || name === "\\crcr")) { rows.push(content.slice(from, i)); from = i + name.length; }
      i += name.length - 1;
    }
  }
  rows.push(content.slice(from));
  return rows.map((row) => row.trim()).filter((row, index, all) => row || index < all.length - 1);
}

/** An `\ooalign` row as math: `$…$`, or plain characters (`/`); null for anything else. */
function ooalignCell(row: string) {
  const math = /^\$([^$]*)\$$/.exec(row);
  if (math) return math[1];
  return /^[^\\{}$&#%^_~]+$/.test(row) ? `\\text{${row}}` : null;
}

/**
 * Plain TeX's overlay `\ooalign{\hfil/\hfil\crcr$k$}` (2611.11568's `\Slash`): two rows, one centred with `\hfil`
 * on both sides, drawn on top of each other, the centred one over the middle of the other. Other overlays (both or
 * neither row centred, boxes, more rows) are left: KaTeX then fails and the formula stays source.
 */
function ooalignForKatex(latex: string) {
  return replaceGroups(latex, /\\ooalign\s*/g, (content) => {
    const rows = ooalignRows(content);
    const centred = rows.map((row) => /^\\(?:hfill?|hss)(?![A-Za-z])\s*([\s\S]*?)\s*\\(?:hfill?|hss)$/.exec(row)?.[1]);
    const cells = rows.map((row, index) => ooalignCell(centred[index] ?? row));
    const over = centred.findIndex((row) => row !== undefined);
    if (rows.length !== 2 || cells.includes(null) || over < 0 || centred[1 - over] !== undefined) return `\\ooalign{${content}}`;
    const base = cells[1 - over]!;
    return `{\\mathclap{\\hphantom{${base}}\\mathclap{${cells[over]}}}${base}}`;
  });
}

/** Text in small capitals as KaTeX can draw it: lower-case runs as smaller capitals; commands and `$…$` kept as written. */
function smallCaps(text: string) {
  let out = "";
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (char === "\\") {
      const name = /^\\(?:[A-Za-z@]+|.)/.exec(text.slice(i, i + 64))?.[0] ?? "\\";
      out += name;
      i += name.length;
    } else if (char === "$") {
      const end = text.indexOf("$", i + 1);
      const to = end < 0 ? text.length : end + 1;
      out += text.slice(i, to);
      i = to;
    } else if (/[a-z]/.test(char)) {
      const run = /^[a-z]+/.exec(text.slice(i))![0];
      out += `{\\small ${run.toUpperCase()}}`;
      i += run.length;
    } else {
      out += char;
      i++;
    }
  }
  return out;
}

/** `\textsc{…}` as `\text{…}` in small capitals, also around commands and formulas (algorithm2e's `\textsc{Fetch($T.\nodes[i]$)}`). */
function textscForKatex(latex: string): string {
  return replaceGroups(latex, /\\textsc(?![A-Za-z@])\s*/g, (content) => `\\text{${smallCaps(content.includes("\\textsc") ? textscForKatex(content) : content)}}`);
}

/** mathtools' small matrices with delimiters, which KaTeX lacks: its `smallmatrix` between those delimiters. */
const SMALL_MATRICES: Record<string, [string, string]> = {
  psmallmatrix: ["(", ")"], bsmallmatrix: ["[", "]"], Bsmallmatrix: ["\\{", "\\}"], vsmallmatrix: ["|", "|"], Vsmallmatrix: ["\\|", "\\|"],
};
const SMALL_MATRIX = /\\(begin|end)\s*\{([pbBvV]smallmatrix)\}/g;

const COUNTER_COMMANDS = /\\(?:addtocounter|setcounter)\s*\{[^{}]*\}\s*\{[^{}]*\}|\\(?:stepcounter|refstepcounter)\s*\{[^{}]*\}/g;
const COUNTED_TAG = /\\tag\*?\s*\{\s*\\theequation\s*\}/;

/**
 * Rows numbered by hand (`\addtocounter{equation}{1}\tag{\theequation}`, VAE's `\eqnr` in `align*`): the counter
 * commands draw nothing, and such rows get number slots, which the numbering pass fills as other rows'; the
 * environment's other rows are `\nonumber`. Null when the formula has none of this.
 */
export function countedRows(latex: string): { latex: string; numbered: boolean } | null {
  if (!/\\(?:addtocounter|setcounter|stepcounter|refstepcounter|theequation)(?![A-Za-z@])/.test(latex)) return null;
  const text = latex.replace(COUNTER_COMMANDS, "");
  if (!COUNTED_TAG.test(text)) return { latex: text, numbered: false };
  const untagged = (row: string) => row.replace(new RegExp(COUNTED_TAG.source, "g"), "");
  const env = /^\s*\\begin\{(align|alignat|flalign|gather|equation|multline)\*\}([\s\S]*)\\end\{\1\*\}\s*$/.exec(text);
  if (env && (env[1] === "equation" || env[1] === "multline")) return { latex: `\\begin{${env[1]}}${untagged(env[2])}\\end{${env[1]}}`, numbered: true };
  if (env) {
    const rows = splitMathRows(env[2]).map((row) => (COUNTED_TAG.test(row) ? untagged(row) : `${row}\\nonumber`));
    return { latex: `\\begin{${env[1]}}${rows.join("\\\\")}\\end{${env[1]}}`, numbered: true };
  }
  // `equation*`, drawn without its environment: a numbered equation.
  return { latex: `\\begin{equation}${untagged(text)}\\end{equation}`, numbered: true };
}

/** The premises or conclusion of a rule: lines (`\\`) stacked, and `\and` between premises as a gap. */
function ruleStack(text: string) {
  const parts = text.replace(/\\and(?![A-Za-z@])/g, "\\qquad ").trim();
  return parts ? `\\begin{array}{c}${parts}\\end{array}` : "";
}

/**
 * mathpartir's inference rules, which KaTeX lacks: `\inferrule[name]{premises}{conclusion}` (and `\inferrule*` with
 * `[right=name]`) as a fraction of the stacked premises over the conclusion, the name beside it. A rule whose
 * arguments do not close is left as it is (KaTeX then fails, and the formula stays source).
 */
export function inferrulesForKatex(latex: string) {
  let out = "";
  let at = 0;
  for (let index = latex.indexOf("\\inferrule"); index >= 0; index = latex.indexOf("\\inferrule", at)) {
    let i = index + "\\inferrule".length;
    if (/[A-Za-z@]/.test(latex[i] ?? "")) { out += latex.slice(at, i); at = i; continue; }
    if (latex[i] === "*") i++;
    const skip = () => { while (/\s/.test(latex[i] ?? "")) i++; };
    skip();
    const options = latex[i] === "[" ? readOptional(latex, i, TEX_GROUPS) : null;
    if (options) { i = options.end; skip(); }
    const premises = latex[i] === "{" ? readGroup(latex, i, TEX_GROUPS) : null;
    if (premises) { i = premises.end; skip(); }
    const conclusion = premises && latex[i] === "{" ? readGroup(latex, i, TEX_GROUPS) : null;
    if (!premises || !conclusion) { out += latex.slice(at, i); at = i; continue; }
    const name = options ? (/(?:^|,)\s*(?:right|left|Right|Left|lab|Lab)\s*=\s*([^,]*)/.exec(options.content)?.[1] ?? (options.content.includes("=") ? "" : options.content)).trim() : "";
    const rule = `\\dfrac{${ruleStack(premises.content)}}{${ruleStack(conclusion.content)}}`;
    out += latex.slice(at, index) + (name ? `{\\scriptsize\\textsc{${name}}}\\;${rule}` : rule);
    at = conclusion.end;
  }
  return out + latex.slice(at);
}

/**
 * mathpartir's `mathpar` body as one formula: rules separated by `\and` or blank lines side by side, `\\` starting a
 * new row.
 */
export function mathparForKatex(body: string) {
  // The rules first (their own `\and` and `\\` are inside their braces), then the layout around them.
  const text = inferrulesForKatex(stripTexComments(body).trim());
  const rows: string[][] = [[]];
  let rule = "";
  let depth = 0;
  let environments = 0;
  const endRule = () => { if (rule.trim()) rows[rows.length - 1].push(rule.trim()); rule = ""; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") {
      // A command or an escaped character (`\{`) is copied as it is; at the top level, `\\` and `\and` lay the rules out.
      if (depth === 0) {
        if (text.startsWith("\\begin", i)) environments++;
        else if (text.startsWith("\\end", i)) environments--;
        else if (environments === 0 && text[i + 1] === "\\") { endRule(); rows.push([]); i++; continue; }
        else if (environments === 0 && /^\\and(?![A-Za-z@])/.test(text.slice(i, i + 5))) { endRule(); i += 3; continue; }
      }
      rule += char + (text[i + 1] ?? "");
      i++;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === "\n" && depth === 0 && environments === 0 && /^\n[ \t]*\n/.test(text.slice(i, i + 40))) { endRule(); continue; }
    rule += char;
  }
  endRule();
  return `\\begin{gathered}${rows.filter((row) => row.length).map((row) => row.join(" \\qquad ")).join(" \\\\[1.2em] ")}\\end{gathered}`;
}

/** TeX's `\raise<dimen>` and `\lower<dimen>` before a box. */
export const RAISE = /\\(?:raise|lower)\s*-?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:ex|em|pt|mm|cm|in|bp|mu)\s*/g;

/** `\cmd` and its `{…}` argument at each match of `pattern` (which ends where the group opens), replaced; a use whose group does not close is left. */
function replaceGroups(latex: string, pattern: RegExp, replace: (content: string) => string, build?: (match: RegExpExecArray, content: string) => string) {
  let out = "";
  let at = 0;
  for (let match: RegExpExecArray | null; (match = pattern.exec(latex));) {
    const group = latex[pattern.lastIndex] === "{" ? readGroup(latex, pattern.lastIndex, TEX_GROUPS) : null;
    if (!group) continue;
    out += latex.slice(at, match.index) + (build ? build(match, group.content) : replace(group.content));
    at = pattern.lastIndex = group.end;
  }
  return out + latex.slice(at);
}

/** Where the `close` matching the `open` at `from` is (same brace depth, nested pairs counted), or -1. */
function delimiterEnd(latex: string, from: number, open: string, close: string) {
  let depth = 0;
  let nested = 0;
  for (let i = from + 1; i < latex.length; i++) {
    const char = latex[i];
    if (char === "\\") { i++; continue; }
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (depth === 0 && char === close && nested === 0) return i;
    else if (depth === 0 && char === open && open !== close) nested++;
    else if (depth === 0 && char === close) nested--;
  }
  return -1;
}

const QUANTITY = /\\physics@(qty|mqty|smqty)\s*(\\(?:big|Big|bigg|Bigg)(?![A-Za-z@])\s*)?/g;
const MATRICES: Record<string, string> = { "{": "matrix", "(": "pmatrix", "[": "bmatrix", "|": "vmatrix" };
const SMALL_DELIMITERS: Record<string, [string, string]> = { "{": ["", ""], "(": ["\\left(", "\\right)"], "[": ["\\left[", "\\right]"], "|": ["\\left\\lvert", "\\right\\rvert"] };

/**
 * physics' commands that read delimiters, as its definitions write them (macros/packages.ts): `\qty(…)`, `\qty[…]`,
 * `\qty{…}` and `\qty|…|` sized to their content (or by `\big` and the like), `\mqty(…)` matrices, and `\bra{a}\ket{b}`
 * as one bracket ⟨a|b⟩. A use it cannot read keeps its marker, which KaTeX does not know: the formula stays source.
 */
function physicsForKatex(latex: string): string {
  if (latex.includes("\\physics@mat")) latex = physicsMatricesForKatex(latex);
  if (latex.includes("\\physics@eval")) latex = physicsEvalForKatex(latex);
  let out = latex.replace(/\\right\\rvert\\physics@bra\s*\\physics@ket\\left\\lvert/g, "\\middle\\vert ").replace(/\\rvert\\physics@bra\s*\\physics@ket\\lvert/g, "\\vert ");
  // A sized bra before an unsized ket (or the reverse): physics joins them unsized, which is not written out here.
  if (/\\physics@bra\s*\\physics@ket/.test(out)) return out;
  out = out.replace(/\\physics@(?:bra|ket)(?![A-Za-z@])/g, "");
  if (!out.includes("\\physics@")) return out;
  let result = "";
  let at = 0;
  QUANTITY.lastIndex = 0;
  for (let match: RegExpExecArray | null; (match = QUANTITY.exec(out));) {
    const start = QUANTITY.lastIndex;
    const open = out[start];
    const close = open === "(" ? ")" : open === "[" ? "]" : open === "|" ? "|" : open === "{" ? "}" : "";
    const end = open === "{" ? (readGroup(out, start, TEX_GROUPS)?.end ?? 0) - 1 : close ? delimiterEnd(out, start, open, close) : -1;
    const [, kind, size] = match;
    if (end < 0 || (size && kind !== "qty")) continue;
    const content = physicsForKatex(out.slice(start + 1, end));
    let drawn: string;
    if (kind === "qty") {
      const [left, right] = open === "{" ? ["\\{", "\\}"] : open === "|" ? ["\\lvert", "\\rvert"] : [open, close];
      const sizing = size?.trim();
      drawn = sizing ? `${sizing}l${left} ${content}${sizing}r${right}` : `\\left${left} ${content}\\right${right}`;
    } else if (kind === "mqty") drawn = `\\begin{${MATRICES[open]}}${content}\\end{${MATRICES[open]}}`;
    else drawn = `${SMALL_DELIMITERS[open][0]}\\begin{smallmatrix}${content}\\end{smallmatrix}${SMALL_DELIMITERS[open][1]}`;
    result += out.slice(at, match.index) + drawn;
    at = QUANTITY.lastIndex = end + 1;
  }
  return result + out.slice(at);
}

/** physics' Pauli matrices by index (`\pmat{1}` or `\pmat{x}`), as rows. */
const PAULI: Record<string, string> = { "0": "1&0\\\\0&1", "1": "0&1\\\\1&0", x: "0&1\\\\1&0", "2": "0&-i\\\\i&0", y: "0&-i\\\\i&0", "3": "1&0\\\\0&-1", z: "1&0\\\\0&-1" };

/**
 * physics' matrix contents (`\imat{n}`, `\zmat{m}{n}`, `\xmat{x}{m}{n}`, `\dmat{a,b}`, `\admat{a,b}`, `\pmat{n}`), which
 * macros/packages.ts writes as `\physics@mat{kind}{fill}{a}{b}{c}`: their rows, the whole content of a `\mqty(…)` (as physics
 * writes them, inside its brackets) or a `matrix` on their own. Sizes over 12 or forms not written here keep the marker.
 */
function physicsMatricesForKatex(latex: string) {
  const MARK = /\\physics@mat\{(imat|zmat|xmat|xmat\*|dmat|admat|pmat)\}\{([^{}]*)\}\{((?:[^{}]|\{[^{}]*\})*)\}\{([^{}]*)\}\{([^{}]*)\}/g;
  const rows = (kind: string, fill: string, a: string, b: string, c: string): string | null => {
    const size = (text: string) => (/^\s*\d+\s*$/.test(text) && Number(text) >= 1 && Number(text) <= 12 ? Number(text) : null);
    const grid = (m: number, n: number, cell: (i: number, j: number) => string) => Array.from({ length: m }, (_, i) => Array.from({ length: n }, (_, j) => cell(i, j)).join("&")).join("\\\\");
    if (kind === "imat") { const n = size(a); return n && grid(n, n, (i, j) => (i === j ? "1" : "0")); }
    if (kind === "zmat") { const m = size(a); const n = size(b); return m && n && grid(m, n, () => "0"); }
    if (kind === "xmat" || kind === "xmat*") {
      const m = size(b);
      const n = size(c);
      // `xmat` (physics' starred `\xmat*`): indexed entries (`x_{11}`, or `x_{1}` for one row or column); `xmat*` (unstarred): the entry itself.
      return m && n && grid(m, n, (i, j) => (kind === "xmat*" ? a : `${a}_{${m === 1 ? j + 1 : n === 1 ? i + 1 : `${i + 1}${j + 1}`}}`));
    }
    if (kind === "pmat") return PAULI[a.trim()] ?? null;
    const items = a.split(",").map((item) => item.trim());
    if (items.length > 12) return null;
    const n = items.length;
    return grid(n, n, (i, j) => (kind === "dmat" ? (i === j ? items[i] : fill) : i + j === n - 1 ? items[i] : fill));
  };
  // Inside physics' own brackets: `\mqty(\imat{2})`, `\smqty[\dmat{a,b}]`.
  let out = latex.replace(new RegExp(`(\\\\physics@s?mqty\\s*[([{|])\\s*${MARK.source}\\s*(?=[)\\]}|])`, "g"), (whole, open: string, kind: string, fill: string, a: string, b: string, c: string) => {
    const drawn = rows(kind, fill, a, b, c);
    return drawn ? open + drawn : whole;
  });
  out = out.replace(MARK, (whole, kind: string, fill: string, a: string, b: string, c: string) => {
    const drawn = rows(kind, fill, a, b, c);
    return drawn ? `\\begin{matrix}${drawn}\\end{matrix}` : whole;
  });
  return out;
}

/**
 * physics' `\eval{f}_a^b` (written `\physics@eval`, starred `\physics@eval*`): the expression and a bar sized to it,
 * `\eval(f)|_a^b` and `\eval[f|_a^b` with their opening delimiter. Unread forms keep the marker (KaTeX then fails).
 */
function physicsEvalForKatex(latex: string) {
  let out = "";
  let at = 0;
  const pattern = /\\physics@eval(\*?)\s*/g;
  for (let match: RegExpExecArray | null; (match = pattern.exec(latex));) {
    const start = pattern.lastIndex;
    const open = latex[start];
    let content: string | null = null;
    let end = -1;
    if (open === "{") {
      const group = readGroup(latex, start, TEX_GROUPS);
      if (group) { content = group.content; end = group.end; }
    } else if (open === "(" || open === "[") {
      const bar = delimiterEnd(latex, start, open, "|");
      if (bar > 0) { content = latex.slice(start + 1, bar); end = bar + 1; }
    }
    if (content === null) continue;
    const starred = !!match[1];
    const left = open === "{" ? "." : open;
    const drawn = starred ? `${left === "." ? "" : left}${content}\\vert` : `\\left${left}${content}\\right\\vert`;
    out += latex.slice(at, match.index) + drawn;
    at = pattern.lastIndex = end;
  }
  return out + latex.slice(at);
}

/** A colour as `#rrggbb` (KaTeX's colours are CSS names or hex): from cssColor's CSS; null for `currentColor` and anything else. */
function hexColor(css: string | null): string | null {
  if (!css) return null;
  if (/^#[0-9A-Fa-f]{6}$/.test(css)) return css;
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(css);
  return rgb ? `#${rgb.slice(1).map((part) => Number(part).toString(16).padStart(2, "0")).join("")}` : null;
}

/** xcolor's mixes (`red!50!blue`, `red!30` with white) of known colours, as `#rrggbb`; null for anything else. */
function mixedColor(spec: string, colors?: ReadonlyMap<string, { model: string; value: string }>): string | null {
  const parts = spec.split("!").map((part) => part.trim());
  const rgbOf = (name: string) => {
    const hex = name === "black" ? "#000000" : hexColor(cssColor(null, name, colors));
    return hex ? [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) : null;
  };
  let current = rgbOf(parts[0]);
  for (let i = 1; current && i < parts.length; i += 2) {
    const percent = Number(parts[i]);
    const other = i + 1 < parts.length ? rgbOf(parts[i + 1]) : [255, 255, 255];
    if (!(percent >= 0 && percent <= 100) || !other) return null;
    current = current.map((value, index) => Math.round((value * percent + other[index] * (100 - percent)) / 100));
  }
  return current ? `#${current.map((value) => value.toString(16).padStart(2, "0")).join("")}` : null;
}

/**
 * xcolor's colours in a formula as KaTeX takes them: a model (`\textcolor[HTML]{FF0000}`, `\color[rgb]{1,0,0}`), a mix
 * (`red!50!blue`), dvipsnames and the document's `\definecolor` names (`colors`) as `#rrggbb`. CSS names KaTeX knows stay;
 * a colour not read here stays as written (KaTeX then fails on it, or draws it as it does today).
 */
export function colorsForKatex(latex: string, colors?: ReadonlyMap<string, { model: string; value: string }>) {
  if (!/\\(?:textcolor|color|colorbox|fcolorbox)(?![A-Za-z@])/.test(latex)) return latex;
  const convert = (model: string | undefined, spec: string) => {
    const value = spec.trim();
    if (model !== undefined) return hexColor(cssColor(model.trim(), value)) ?? (model.trim() === "gray" && value === "0" ? "#000000" : null);
    if (value.includes("!")) return mixedColor(value, colors);
    if (/^#?[0-9A-Fa-f]{6}$/.test(value) || (/^[a-z]+$/.test(value) && !colors?.has(value))) return null;
    return hexColor(cssColor(null, value, colors));
  };
  return latex
    .replace(/\\(textcolor|color|colorbox)\s*(?:\[([^\]]*)\])?\s*\{([^{}]*)\}/g, (whole, command: string, model: string | undefined, spec: string) => {
      const hex = convert(model, spec);
      return hex ? `\\${command}{${hex}}` : whole;
    })
    .replace(/\\fcolorbox\s*(?:\[([^\]]*)\])?\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (whole, model: string | undefined, frame: string, back: string) => {
      const [a, b] = [convert(model, frame), convert(model, back)];
      return a || b ? `\\fcolorbox{${a ?? frame}}{${b ?? back}}` : whole;
    });
}

/** `*{3}{c}` in a column specification, written out (to a depth of four). */
function repeatedColumns(spec: string, depth = 0): string {
  return depth > 4 ? spec : spec.replace(/\*\s*\{\s*(\d+)\s*\}\s*\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g, (_, count: string, columns: string) => repeatedColumns(columns, depth + 1).repeat(Math.min(Number(count), 40)));
}

/**
 * An array's column specification as KaTeX takes it (it knows `l c r | :`): array's `>{…}` and `<{…}` (code around a
 * column's cells) and `@{…}` (between columns) dropped, `!{\vrule}` as a rule, paragraph columns `p{…} m{…} b{…}` and
 * tabularx's `X` as `l`, `*{n}{…}` written out, and the custom `L C R` (IEEEeqnarray's, and many `\newcolumntype`s) as
 * `l c r`. Null when a column letter is not one of these (the array stays as written, and the formula source).
 */
export function arrayColumnsForKatex(spec: string): string | null {
  let text = repeatedColumns(spec);
  let out = "";
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (/\s/.test(char)) { i++; continue; }
    if (char === ">" || char === "<" || char === "@" || char === "!") {
      let j = i + 1;
      while (/\s/.test(text[j] ?? "")) j++;
      const group = text[j] === "{" ? readGroup(text, j) : null;
      if (!group) return null;
      if (char === "!" && /\\vrule|\|/.test(group.content)) out += "|";
      i = group.end;
      continue;
    }
    if (char === "p" || char === "m" || char === "b") {
      let j = i + 1;
      while (/\s/.test(text[j] ?? "")) j++;
      const group = text[j] === "{" ? readGroup(text, j) : null;
      if (!group) return null;
      out += "l";
      i = group.end;
      continue;
    }
    if (/[lcr|:]/.test(char)) out += char;
    else if (/[LCR]/.test(char)) out += char.toLowerCase();
    else if (char === "X" || char === "S") out += char === "X" ? "l" : "c";
    else return null;
    i++;
  }
  text = out;
  return /[lcr]/.test(text) ? text : null;
}

/**
 * Arrays in a formula as KaTeX takes them: the column specification (arrayColumnsForKatex), the position argument
 * `\begin{array}[t]` dropped, and between rows: `\specialrule` and `\noalign{\hrule}` as `\hline`, other `\noalign{…}` (space)
 * dropped; `\cline`, `\cmidrule` and `\hhline` (partial rules KaTeX cannot draw) dropped; `\multicolumn{n}{…}{x}` as `x`
 * in the first of its n cells.
 */
function arraysForKatex(latex: string) {
  let out = latex;
  if (/\\begin\s*\{(?:array|darray|subarray)\}/.test(out)) {
    let result = "";
    let at = 0;
    const pattern = /\\begin\s*\{(array|darray|subarray)\}\s*(?:\[\s*[tbc]?\s*\]\s*)?/g;
    for (let match: RegExpExecArray | null; (match = pattern.exec(out));) {
      const group = out[pattern.lastIndex] === "{" ? readGroup(out, pattern.lastIndex) : null;
      if (!group) continue;
      const spec = arrayColumnsForKatex(group.content);
      result += out.slice(at, match.index) + `\\begin{${match[1]}}{${spec ?? group.content}}`;
      at = pattern.lastIndex = group.end;
    }
    out = result + out.slice(at);
  }
  if (/\\(?:cline|cmidrule|hhline|noalign|specialrule|multicolumn)(?![A-Za-z@])/.test(out)) {
    out = out
      .replace(/\\specialrule\s*\{[^{}]*\}\s*\{[^{}]*\}\s*\{[^{}]*\}/g, "\\hline ")
      .replace(/\\noalign\s*\{\s*\\hrule\s*\}/g, "\\hline ")
      .replace(/\\noalign\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "")
      .replace(/\\(?:cline|hhline)\s*\{[^{}]*\}|\\cmidrule\s*(?:\[[^\]]*\]\s*)?(?:\([^)]*\)\s*)?\{[^{}]*\}/g, "");
    out = replaceGroups(out, /\\multicolumn\s*\{\s*(\d+)\s*\}\s*\{[^{}]*\}\s*/g, (content) => `{${content}}`, (match, content) => `{${content}}${"&".repeat(Math.max(0, Math.min(Number(match[1]), 40) - 1))}`);
  }
  return out;
}

/** `\ensuremath{x}` in a formula's text (`\text{the value \ensuremath{x}}`): math again, as `$x$`. */
function ensuremathInText(latex: string) {
  return replaceGroups(latex, /\\(?:text|textrm|textit|textbf|textnormal|textup|textsf|texttt|mbox)(?![A-Za-z@])\s*/g, (content) => content, (match, content) => {
    if (!content.includes("\\ensuremath") || content.includes("$")) return `${match[0]}{${content}}`;
    return `${match[0]}{${replaceGroups(content, /\\ensuremath\s*/g, (inner) => `$${inner}$`)}}`;
  });
}

/** Plain TeX's `\buildrel a \over =` (a relation with something over it): amsmath's `\stackrel{a}{=}`. */
function buildrelForKatex(latex: string) {
  return latex.replace(/\\buildrel\s*((?:[^{}\\]|\\(?!over(?![A-Za-z]))[A-Za-z]*|\{(?:[^{}]|\{[^{}]*\})*\})*?)\\over(?![A-Za-z])\s*(\\[A-Za-z]+|\{(?:[^{}]|\{[^{}]*\})*\}|[^\s{}])/g, (_, over: string, base: string) => `\\stackrel{${over.trim()}}{${base}}`);
}

/** Commands that draw nothing in a formula: page breaking (`\displaybreak[2]`, `\allowdisplaybreaks`), labels in their forms (cleveref's `\label[type]{key}`, `\zlabel`, `\ltxlabel`). */
const DRAWS_NOTHING = /\\(?:displaybreak|allowdisplaybreaks)(?![A-Za-z@])\s*(?:\[\s*\d?\s*\])?|\\(?:label|zlabel|ltxlabel|sublabel)\*?\s*(?:\[[^\]]*\]\s*)?\{[^{}]*\}|\\smashoperator(?![A-Za-z@])\s*(?:\[[^\]]*\])?/g;

const SIZE_ENVIRONMENT =/\\(?:begin|end)\s*\{(?:tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\}/g;

/** An accent or font whose argument is a command with its own group (`\widehat\mathrm{x}`): TeX reads it, KaTeX does not. */
const UNBRACED_ARGUMENT = /\\(hat|widehat|tilde|widetilde|bar|overline|underline|vec|dot|ddot|check|breve|acute|grave|mathring|overrightarrow|overleftarrow|boldsymbol|bm|sqrt)\s*(\\(?:math[a-z]+|text[a-z]*|operatorname|boldsymbol|bm)\s*\{(?:[^{}]|\{[^{}]*\})*\})/g;

/**
 * LaTeX KaTeX lacks, written as what it can draw: `\textsc{Base}` as `\text{B{\small ASE}}` (small capitals),
 * and Batch Norm's `\widehat\mathrm{x}` as `\widehat{\mathrm{x}}`.
 */
export function forKatex(latex: string) {
  // `\raise.17ex\hbox{…}` (Mask R-CNN's `\app`, a raised ∼): KaTeX has no \raise or \lower; the box is drawn in place.
  let out = latex.includes("\\raise") || latex.includes("\\lower") ? latex.replace(RAISE, "") : latex;
  if (out.includes("\\textsc")) out = textscForKatex(out);
  if (out.includes("\\ooalign")) out = ooalignForKatex(out);
  // booktabs' rules in a formula's array (2611.11191's `\begin{array}…\toprule … \midrule`): KaTeX's `\hline`.
  // `\addlinespace` is space between rows; `\cmidrule` (a partial rule, which KaTeX cannot draw) stays: source.
  if (/\\(?:toprule|midrule|bottomrule|addlinespace)(?![A-Za-z@])/.test(out)) out = out.replace(/\\(?:toprule|midrule|bottomrule)(?![A-Za-z@])(?:\s*\[[^\]]*\])?/g, "\\hline ").replace(/\\addlinespace(?![A-Za-z@])(?:\s*\[[^\]]*\])?/g, "");
  if (/\\[a-z]+\s*\\(?:math|text|operatorname|boldsymbol|bm)/.test(out)) out = out.replace(UNBRACED_ARGUMENT, "\\$1{$2}");
  if (out.includes("\\inferrule")) out = inferrulesForKatex(out);
  // tikzmark's `\tikzmarknode[draw=red]{name}{content}` (Self-RAG's framed Retrieve tokens): its content.
  if (out.includes("\\tikzmark")) out = out.replace(/\\tikzmarknode\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}/g, "").replace(/\\tikzmark\s*\{[^{}]*\}/g, "");
  // Vertical space in a formula (SimPO's `\vspace{-0.5em}` before `\end{equation}`): the page's layout, not the formula.
  if (/\\(?:vspace|vskip|smallskip|medskip|bigskip|noindent)(?![A-Za-z])/.test(out)) {
    out = out.replace(/\\vspace\*?\s*\{[^{}]*\}|\\vskip\s*-?\s*(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|em|ex|in|cm|mm|bp)(?:\s*(?:plus|minus)\s*-?\s*[\d.]+\s*(?:pt|em|ex|in|cm|mm|bp|fil+))*|\\(?:smallskip|medskip|bigskip|noindent)(?![A-Za-z])/g, "");
  }
  // `\begin{psmallmatrix}…\end{psmallmatrix}` (Borusyak et al.'s rank conditions): `smallmatrix` in parentheses.
  if (out.includes("smallmatrix")) {
    out = out.replace(SMALL_MATRIX, (whole, side: string, env: string) => {
      const [left, right] = SMALL_MATRICES[env] ?? [];
      if (!left) return whole;
      return side === "begin" ? `\\left${left}\\begin{smallmatrix}` : `\\end{smallmatrix}\\right${right}`;
    });
  }
  if (out.includes("\\physics@")) out = physicsForKatex(out);
  // graphicx's `\scalebox{0.4}[1]{${=}$}` (2204.14024's `\eq`): its content, a text box as in LaTeX, unscaled.
  if (out.includes("\\scalebox")) out = replaceGroups(out, /\\scalebox\s*\{[^{}]*\}\s*(?:\[[^\]]*\]\s*)?/g, (content) => `\\text{${content}}`);
  // amsmath's `\intertext{where}` between an align's rows (a natural-gradient derivation's), which KaTeX lacks: the
  // text as a row of its own, unnumbered, before the row it opens.
  if (out.includes("intertext")) out = replaceGroups(out, /\\(?:short)?intertext\s*/g, (content) => `\\text{${content}}\\notag\\\\`);
  // `\begin{small}` around a display's body (a book's `equation*`): a text size, which does not apply in a formula.
  if (/\\(?:begin|end)\s*\{(?:tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\}/.test(out)) out = out.replace(SIZE_ENVIRONMENT, "");
  // `\nulldelimiterspace=0pt` sets the width (KATEX_MACROS has its value for `\kern-\nulldelimiterspace`): not drawn.
  if (out.includes("\\nulldelimiterspace")) out = out.replace(/\\nulldelimiterspace\s*=?\s*-?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|em|ex|mu|bp|mm|cm|in)|\\setlength\s*\{?\s*\\nulldelimiterspace\s*\}?\s*\{[^{}]*\}/g, "");
  // Page breaks and labels in their forms draw nothing (`\displaybreak[2]` in an align, cleveref's `\label[lemma]{x}`).
  if (/\\(?:displaybreak|allowdisplaybreaks|label|zlabel|ltxlabel|sublabel|smashoperator)(?![A-Za-z@])/.test(out)) out = out.replace(DRAWS_NOTHING, "");
  // Arrays' column specifications and rules (`{@{}l@{\quad}r@{}}`, `\cmidrule`, `\multicolumn`).
  if (/\\begin\s*\{(?:array|darray|subarray)\}|\\(?:cline|cmidrule|hhline|noalign|specialrule|multicolumn)(?![A-Za-z@])/.test(out)) out = arraysForKatex(out);
  if (out.includes("\\buildrel")) out = buildrelForKatex(out);
  if (out.includes("\\ensuremath")) out = ensuremathInText(out);
  out = colorsForKatex(out);
  out = siunitxForKatex(out);
  return out;
}

/** The class of a part of a formula shown as its source (a row KaTeX rejects): the one `\htmlClass` KaTeX is trusted with. */
const SOURCE_CLASS = "cm-vis-math-source";
const trustSourceClass = (context: { command: string; class?: string }) => context.command === "\\htmlClass" && (context.class === SOURCE_CLASS || context.class === "eqn-num");

/** KaTeX's HTML for a formula already written for it, or null when it rejects it. */
function katexHtml(latex: string, display: boolean): string | null {
  try {
    return katex.renderToString(latex, { displayMode: display, throwOnError: true, strict: "ignore", trust: trustSourceClass, maxExpand: 500, output: "html", macros: { ...KATEX_MACROS } });
  } catch {
    return null;
  }
}

const MHCHEM = /\\(?:ce|pu)(?![A-Za-z@])/;
let mhchemLoading: Promise<void> | null = null;
let mhchemReady = false;
const extensionListeners = new Set<() => void>();

/**
 * KaTeX's mhchem extension (`\ce{H2O}`, `\pu{123 kJ/mol}`), loaded the first time a formula uses it, so documents
 * without chemistry do not load it. Formulas drawn as source meanwhile are drawn again once it is in (listeners).
 */
export function loadMhchem(): Promise<void> {
  mhchemLoading ??= import("katex/contrib/mhchem").then(() => {
    mhchemReady = true;
    for (const [key, html] of cache) if (html === null) cache.delete(key);
    for (const listener of extensionListeners) listener();
  });
  return mhchemLoading;
}

/** Calls `listener` when a KaTeX extension has loaded (formulas that needed it can now be drawn); returns the unsubscribe. */
export function onMathExtensionLoaded(listener: () => void) {
  extensionListeners.add(listener);
  return () => { extensionListeners.delete(listener); };
}

export function renderKatex(latex: string, display: boolean): string | null {
  const key = `${display ? "D" : "I"}${latex}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const source = forKatex(latex);
  if (!mhchemReady && MHCHEM.test(source)) {
    // Source until mhchem is in; not cached, so the formula is drawn once it is.
    loadMhchem().catch(() => {});
    return null;
  }
  const html = katexHtml(source, display) ?? partialKatex(source, display);
  cache.set(key, html);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return html;
}

/** Environments whose rows are drawn one by one when the whole fails: a row KaTeX rejects shows its source. */
const ROW_ENVIRONMENT = /\\begin\s*\{(align|alignat|flalign|gather|multline|eqnarray|aligned|alignedat|gathered|split|cases|dcases|rcases)(\*?)\}/g;
const NUMBERED_ROW_ENVIRONMENTS = new Set(["align", "alignat", "flalign", "gather", "multline", "eqnarray"]);
/** Text arguments in a formula, whose `$…$` pieces are drawn one by one when the whole fails. */
const TEXT_ARGUMENT = /\\(?:text|textrm|textit|textbf|textnormal|textup|textsf|texttt|mbox)(?![A-Za-z@])\s*/g;
const PLACEHOLDER = /QQSRC(\d+)QQ/g;

/** Where the `\end{…}` closing the environment whose `\begin{…}` ends at `from` starts, or -1. */
function environmentEnd(latex: string, from: number) {
  const pattern = /\\(begin|end)\s*\{[^{}]*\}/g;
  pattern.lastIndex = from;
  let depth = 1;
  for (let match: RegExpExecArray | null; (match = pattern.exec(latex));) {
    depth += match[1] === "begin" ? 1 : -1;
    if (depth === 0) return match.index;
  }
  return -1;
}

/** An environment's body as rows and the `\\` (with `*` and `[…]`) after each, at the top level (as splitMathRows reads them). */
function rowsWithBreaks(body: string) {
  const rows: Array<{ text: string; separator: string }> = [];
  let depth = 0;
  let environments = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "%") { const end = body.indexOf("\n", i); i = end < 0 ? body.length : end; continue; }
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === "\\") {
      if (body.startsWith("\\begin", i)) environments++;
      else if (body.startsWith("\\end", i)) environments--;
      else if (body[i + 1] === "\\" && depth === 0 && environments === 0) {
        const breakStart = i;
        i++;
        if (body[i + 1] === "*") i++;
        const spacing = /^\s*\[[^\]]*\]/.exec(body.slice(i + 1));
        if (spacing) i += spacing[0].length;
        rows.push({ text: body.slice(start, breakStart), separator: body.slice(breakStart, i + 1) });
        start = i + 1;
        continue;
      }
      i++;
    }
  }
  rows.push({ text: body.slice(start), separator: "" });
  return rows;
}

type PartialState = { sources: string[]; kept: number };

/** A part of a formula shown as its source: a trusted `\htmlClass` around a placeholder, its text put back in the HTML. */
function sourcePart(text: string, state: PartialState) {
  state.sources.push(text.trim().replace(/\s+/g, " "));
  return `\\htmlClass{${SOURCE_CLASS}}{\\text{QQSRC${state.sources.length - 1}QQ}}`;
}

/**
 * The formula with each row KaTeX rejects (of the environments in ROW_ENVIRONMENT, nested ones first tried row by
 * row in turn) and each `$…$` in a `\text{…}` it rejects written as a source part. A numbered row keeps its number
 * slot (a row with a `\tag` or `\nonumber` has none), so the numbering pass's numbers stay on the right rows.
 */
function markFailingParts(latex: string, state: PartialState, depth: number): string {
  let out = "";
  let at = 0;
  const pattern = new RegExp(ROW_ENVIRONMENT.source, "g");
  for (let match: RegExpExecArray | null; (match = pattern.exec(latex));) {
    let bodyStart = pattern.lastIndex;
    const [, name, star] = match;
    let args = "";
    if (name === "alignat" || name === "alignedat") {
      const group = /^\s*\{[^{}]*\}/.exec(latex.slice(bodyStart));
      if (group) { args = group[0]; bodyStart += group[0].length; }
    }
    const end = environmentEnd(latex, pattern.lastIndex);
    if (end < 0) break;
    const env = `${name}${star}`;
    // Rows are tried in the environment's starred form (numbers do not change whether KaTeX reads a row).
    const testEnv = NUMBERED_ROW_ENVIRONMENTS.has(name) ? `${name === "multline" ? "gather" : name === "eqnarray" ? "align" : name}*` : env;
    const renders = (row: string) => katexHtml(`\\begin{${testEnv}}${args}${row}\\end{${testEnv}}`, true) !== null;
    const rows = rowsWithBreaks(latex.slice(bodyStart, end)).map(({ text, separator }) => {
      if (!text.trim() || renders(text)) { if (text.trim()) state.kept++; return text + separator; }
      if (depth < 3) {
        const inner = markFailingParts(text, state, depth + 1);
        if (inner !== text && renders(inner)) return inner + separator;
      }
      const unnumbered = NUMBERED_ROW_ENVIRONMENTS.has(name) && !star && /\\(?:tag|nonumber|notag)(?![A-Za-z@])/.test(text);
      return sourcePart(text, state) + (unnumbered ? "\\nonumber " : "") + separator;
    });
    out += `${latex.slice(at, match.index)}${match[0]}${args}${rows.join("")}`;
    at = pattern.lastIndex = end;
  }
  out += latex.slice(at);
  if (!out.includes("$")) return out;
  return replaceGroups(out, new RegExp(TEXT_ARGUMENT.source, "g"), (content) => content, (match, content) => {
    const text = content.replace(/\$([^$]+)\$/g, (whole, piece: string) => {
      if (katexHtml(piece, false) !== null) { state.kept++; return whole; }
      return `$${sourcePart(whole, state)}$`;
    });
    return `${match[0]}{${text}}`;
  });
}

/** Characters as HTML text. */
function escapeHtml(text: string) {
  return text.replace(/[&<>"]/g, (char) => (char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : "&quot;"));
}

/**
 * A formula KaTeX rejects as a whole, drawn with only the parts it rejects shown as their source (principle: fail at
 * the smallest unit): rows of an align, `$…$` in a `\text{…}`. Null when no part could be told apart, or none draws.
 */
function partialKatex(latex: string, display: boolean): string | null {
  if (latex.includes("QQSRC") || !(latex.includes("\\begin") || latex.includes("$"))) return null;
  const state: PartialState = { sources: [], kept: 0 };
  const marked = markFailingParts(latex, state, 0);
  if (!state.sources.length || !state.kept) return null;
  const html = katexHtml(marked, display);
  return html && html.replace(PLACEHOLDER, (_, index: string) => escapeHtml(state.sources[Number(index)] ?? ""));
}

const NUMBERED_ROWS = new Set(["align", "alignat", "flalign", "gather", "eqnarray"]);
const UNNUMBERED_DISPLAY = new Set(["displaymath", "math"]);

/**
 * Labels go: KaTeX has no \label. `\tag` stays: KaTeX draws it as written
 * (`\tag*{A}` without parentheses), also in starred environments, and the
 * numbering pass numbers only the other rows.
 */
function stripNumbering(body: string) {
  return body.replace(/\\label\s*\{[^}]*\}/g, "");
}

export type DisplayMathSource = { latex: string; numbered: boolean; inline: boolean };

/**
 * The KaTeX source for a math environment: unnumbered environments KaTeX
 * lacks are drawn with a near equivalent (multline as gathered lines, eqnarray
 * as align).
 */
export function katexForEnvironment(env: string, body: string): DisplayMathSource {
  const starred = env.endsWith("*");
  const base = env.replace(/\*$/, "");
  const content = stripNumbering(body);
  // breqn's `dmath` and `dseries` (one equation, broken into lines by breqn): an equation; `[…]` options dropped.
  if (base === "dmath" || base === "dseries") return katexForEnvironment(starred ? "equation*" : "equation", content.replace(/^\s*\[(?:[^\][{}]|\{[^{}]*\})*\]/, ""));
  if (base === "empheq") return empheqForKatex(content);
  if (base === "IEEEeqnarray") return ieeeEqnarrayForKatex(content, starred);
  if (base === "math") return { latex: content, numbered: false, inline: true };
  if (UNNUMBERED_DISPLAY.has(base)) return { latex: content, numbered: false, inline: false };
  if (base === "equation") {
    const numbered = !starred && !/\\(?:nonumber|notag)\b/.test(stripTexComments(content));
    return { latex: numbered ? `\\begin{equation}${content}\\end{equation}` : content, numbered, inline: false };
  }
  if (base === "multline") {
    const inner = `\\begin{gathered}${content}\\end{gathered}`;
    return { latex: starred ? inner : `\\begin{equation}${inner}\\end{equation}`, numbered: !starred, inline: false };
  }
  if (base === "eqnarray") {
    // `a &=& b` is three columns; align's `a &= b` draws the same.
    const rows = content.split(/\\\\/).map((row) => row.replace(/&([^&]*)&/, "&$1"));
    return { latex: `\\begin{align${starred ? "*" : ""}}${rows.join("\\\\")}\\end{align${starred ? "*" : ""}}`, numbered: !starred, inline: false };
  }
  if (NUMBERED_ROWS.has(base)) {
    const args = base === "alignat" ? /^\s*\{[^}]*\}/.exec(content)?.[0] ?? "" : "";
    const rest = content.slice(args.length);
    // KaTeX has no flalign: its align takes as many column pairs, centred rather than flush.
    const name = `${base === "flalign" ? "align" : base}${starred ? "*" : ""}`;
    return { latex: `\\begin{${name}}${args}${rest}\\end{${name}}`, numbered: !starred, inline: false };
  }
  // Inner environments used on their own (matrix, cases) and anything else: as they are.
  return { latex: `\\begin{${env}}${content}\\end{${env}}`, numbered: false, inline: false };
}

/** A number slot the formula sets itself (in its own column), filled like KaTeX's by applyEquationNumbers. */
const NUMBER_SLOT = "\\htmlClass{eqn-num}{}";

/**
 * Rows of a numbered environment drawn in an `aligned` or `darray`, with a last column holding each row's number slot
 * (a `\tag` drawn as its text; `\nonumber`, `\notag` and `\IEEEnonumber` rows none). `columns` is the cells a row has
 * before that column (an even count for `aligned`, so the slot column is right-aligned). Null when no row is numbered.
 */
function rowsWithNumbers(rows: string[], numbered: boolean, columns: number): { rows: string[]; slots: number } | null {
  let slots = 0;
  let any = false;
  const out = rows.map((row) => {
    const tag = /\\tag(\*?)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(row);
    const unnumbered = /\\(?:nonumber|notag|IEEEnonumber)(?![A-Za-z@])/.test(row);
    const text = row.replace(/\\tag\*?\s*\{(?:[^{}]|\{[^{}]*\})*\}|\\(?:nonumber|notag|IEEEnonumber|IEEEyesnumber)(?![A-Za-z@])/g, "");
    const cells = topLevelAmpersands(text) + 1;
    const slot = tag ? `\\text{${tag[1] ? "" : "("}}${tag[2]}\\text{${tag[1] ? "" : ")"}}` : numbered && !unnumbered && text.trim() ? NUMBER_SLOT : "";
    if (slot) any = true;
    if (slot === NUMBER_SLOT) slots++;
    return slot ? `${text}${"&".repeat(Math.max(1, columns - cells + 1))}\\qquad ${slot}` : text;
  });
  return any ? { rows: out, slots } : null;
}

/** The `&` at the top level of a row (not in braces or nested environments). */
function topLevelAmpersands(row: string) {
  let count = 0;
  let depth = 0;
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (char === "\\") {
      if (row.startsWith("\\begin", i)) depth++;
      else if (row.startsWith("\\end", i)) depth--;
      i++;
    } else if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === "&" && depth === 0) count++;
  }
  return count;
}

/** empheq's delimiters (`\empheqlbrace`, `\empheqbigrbrack`) as KaTeX's. */
function empheqDelimiter(text: string) {
  return text.replace(/\\empheq(?:big)?([lr])(brace|brack|paren|angle|vert|Vert|floor|ceil)(?![A-Za-z@])/g, (_, side: string, kind: string) => {
    const pairs: Record<string, [string, string]> = { brace: ["\\{", "\\}"], brack: ["[", "]"], paren: ["(", ")"], angle: ["\\langle", "\\rangle"], vert: ["\\vert", "\\vert"], Vert: ["\\Vert", "\\Vert"], floor: ["\\lfloor", "\\rfloor"], ceil: ["\\lceil", "\\rceil"] };
    return `\\${side === "l" ? "left" : "right"}${pairs[kind][side === "l" ? 0 : 1]}`;
  });
}

/**
 * empheq's `\begin{empheq}[left=\empheqlbrace]{align}`: the inner environment, with the delimiters `left=` and `right=`
 * around all its rows; numbered rows keep their numbers in a column of their own. A form not read here (a right
 * delimiter with numbered rows) keeps the empheq environment, which KaTeX does not know: source.
 */
function empheqForKatex(content: string): DisplayMathSource {
  const head = /^\s*(?:\[((?:[^\][{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\])?\s*\{\s*([A-Za-z]+\*?)\s*(?:=\s*(\d+))?\s*\}/.exec(content);
  const keep: DisplayMathSource = { latex: `\\begin{empheq}${content}\\end{empheq}`, numbered: false, inline: false };
  if (!head) return keep;
  const [, options = "", inner, count] = head;
  const body = content.slice(head[0].length);
  const value = (key: string) => {
    const match = new RegExp(`(?:^|,)\\s*${key}\\s*=\\s*(\\{(?:[^{}]|\\{[^{}]*\\})*\\}|[^,]*)`).exec(options)?.[1]?.trim();
    return match ? empheqDelimiter(match.replace(/^\{([\s\S]*)\}$/, "$1")) : "";
  };
  const left = value("left");
  const right = value("right");
  const innerBody = inner.startsWith("alignat") ? `{${count ?? "1"}}${body}` : body;
  if (!left && !right) return katexForEnvironment(inner, innerBody);
  const innerBase = inner.replace(/\*$/, "");
  const numbered = !inner.endsWith("*") && (NUMBERED_ROWS.has(innerBase) || innerBase === "equation" || innerBase === "multline");
  const open = /\\left(?![A-Za-z])/.test(left) ? left : `${left}\\left.`;
  const close = /\\right(?![A-Za-z])/.test(right) ? right : `\\right.${right}`;
  if (innerBase === "equation" || innerBase === "multline") {
    const unnumbered = !numbered || /\\(?:nonumber|notag)(?![A-Za-z@])/.test(body);
    const formula = `${open}${innerBase === "multline" ? `\\begin{gathered}${body}\\end{gathered}` : body}${close}`;
    return { latex: unnumbered ? formula : `\\begin{equation}${formula}\\end{equation}`, numbered: !unnumbered, inline: false };
  }
  if (!["align", "alignat", "flalign", "gather"].includes(innerBase)) return keep;
  const rows = splitMathRows(body);
  if (rows.length > 1 && !rows[rows.length - 1].trim()) rows.pop();
  const gather = innerBase === "gather";
  const columns = gather ? 1 : rows.reduce((most, row) => Math.max(most, topLevelAmpersands(row) + 1), 0);
  const withNumbers = rowsWithNumbers(rows, numbered, gather ? 1 : columns + (columns % 2));
  if (withNumbers && right) return keep;
  const table = (lines: string[], slotColumn: boolean) => (gather ? `\\begin{darray}{c${slotColumn ? "r" : ""}}${lines.join("\\\\")}\\end{darray}` : `\\begin{aligned}${lines.join("\\\\")}\\end{aligned}`);
  const latex = `${open}${table(withNumbers?.rows ?? rows.map((row) => row.replace(/\\(?:nonumber|notag)(?![A-Za-z@])/g, "")), !!withNumbers)}${close}`;
  return { latex, numbered: !!withNumbers?.slots, inline: false };
}

/**
 * IEEEtran's `\begin{IEEEeqnarray}{rCl}`: its rows in a display-style array with the column letters (`l c r`, the
 * `L C R` of relations, spacing columns dropped), numbered rows with a number column. A column specification not read
 * here keeps the environment (source).
 */
function ieeeEqnarrayForKatex(content: string, starred: boolean): DisplayMathSource {
  const head = /^\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/.exec(content);
  const spec = head ? head[1].replace(/[+;'"?.,:]|\s/g, "") : "";
  const keep: DisplayMathSource = { latex: `\\begin{IEEEeqnarray${starred ? "*" : ""}}${content}\\end{IEEEeqnarray${starred ? "*" : ""}}`, numbered: false, inline: false };
  if (!head || !/^[lcrLCR]+$/.test(spec)) return keep;
  const rows = splitMathRows(content.slice(head[0].length));
  if (rows.length > 1 && !rows[rows.length - 1].trim()) rows.pop();
  const columns = spec.toLowerCase();
  const withNumbers = rowsWithNumbers(rows, !starred, columns.length);
  const lines = withNumbers?.rows ?? rows.map((row) => row.replace(/\\(?:nonumber|notag|IEEEnonumber|IEEEyesnumber)(?![A-Za-z@])/g, ""));
  return { latex: `\\begin{darray}{${columns}${withNumbers ? "r" : ""}}${lines.join("\\\\")}\\end{darray}`, numbered: !!withNumbers?.slots, inline: false };
}

/** Puts the numbering pass's numbers on KaTeX's number slots, in row order (rows with a `\tag` have their own, drawn by KaTeX). */
export function applyEquationNumbers(element: HTMLElement, numbers: Array<string | null>, tagged: boolean[] = []) {
  const slots = element.querySelectorAll<HTMLElement>(".eqn-num");
  const values = numbers.filter((number, index): number is string => number !== null && !tagged[index]);
  slots.forEach((slot, index) => {
    const value = values[index];
    if (value === undefined) slot.removeAttribute("data-vis-num");
    else slot.setAttribute("data-vis-num", value);
  });
}

export function clearKatexCache() {
  cache.clear();
}
