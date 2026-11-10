/* Presentation MathML as TeX, for formulas pasted without a TeX annotation
 * (Word, some web pages). Covers the elements formulas are usually written
 * with; anything else keeps its content. Unicode symbols are left as they are:
 * the converter maps them to commands for pdfLaTeX (mathSymbolsToCommands). */

const FUNCTIONS = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "coth", "log", "ln", "lg", "exp",
  "lim", "liminf", "limsup", "max", "min", "sup", "inf", "det", "dim", "ker", "deg", "gcd", "arg", "hom", "Pr"]);

const ACCENTS: Record<string, string> = {
  "^": "hat", "ˆ": "hat", "\u0302": "hat", "¯": "bar", "‾": "overline", "\u0304": "bar", "―": "overline", "_": "overline", "→": "vec", "\u20d7": "vec",
  "~": "tilde", "˜": "tilde", "\u0303": "tilde", "˙": "dot", "\u0307": "dot", "¨": "ddot", "\u0308": "ddot", "⏞": "overbrace", "⌢": "widehat",
};
const UNDER_ACCENTS: Record<string, string> = { "_": "underline", "¯": "underline", "‾": "underline", "⏟": "underbrace" };

/** Operators that take limits below and above (`\sum_{i}^{n}`), so `munder`/`munderover` write them as scripts. */
const LIMIT_OPERATORS = /^(?:[∑∏∐⋃⋂⨁⨂⨀⋁⋀∫∬∭∮]|\\(?:lim|max|min|sup|inf|limsup|liminf|sum|prod|bigcup|bigcap|int)\b)/;

/** Invisible operators (function application, invisible times…) write nothing. */
const INVISIBLE = /[\u2061-\u2064]/g;

const TOKEN_SPECIALS: Record<string, string> = { "\\": "\\backslash ", "{": "\\{", "}": "\\}", "%": "\\%", "#": "\\#", "&": "\\&", "$": "\\$", "~": "\\sim ", "^": "\\wedge ", "_": "\\_" };

/** A token's text with TeX's special characters made harmless, so tokens can never spell out a command. */
function token(value: string) {
  return value.replace(INVISIBLE, "").replace(/[\\{}%#&$~^_]/g, (char) => TOKEN_SPECIALS[char] ?? char).trimEnd();
}

const FENCES: Record<string, string> = { "(": "(", ")": ")", "[": "[", "]": "]", "{": "\\{", "}": "\\}", "|": "|", "‖": "\\|", "⟨": "\\langle", "⟩": "\\rangle", "": "." };

function text(element: Element) {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Pieces joined so a command name never runs into the letters after it (`\alpha x`, not `\alphax`). */
function join(parts: string[]) {
  let out = "";
  for (const part of parts) {
    if (!part) continue;
    out += /\\[A-Za-z]+$/.test(out) && /^[A-Za-z]/.test(part) ? ` ${part}` : part;
  }
  return out;
}

/** A script's base or argument: braced unless it is one token. */
function group(tex: string) {
  return /^(?:[A-Za-z0-9]|\\[A-Za-z]+|\\.|[^\\{}\s^_])$/u.test(tex) ? tex : `{${tex}}`;
}

function escapeText(value: string) {
  return value.replace(/[\\{}$&#%_^~]/g, (char) => char === "\\" ? "\\textbackslash{}" : char === "^" ? "\\^{}" : char === "~" ? "\\~{}" : `\\${char}`);
}

function children(element: Element): Element[] {
  return Array.from(element.children);
}

function convert(element: Element): string {
  const tag = element.localName.toLowerCase();
  const kids = children(element);
  const all = () => join(kids.map(convert));
  switch (tag) {
    case "math": case "mrow": case "mstyle": case "mpadded": case "mphantom": case "menclose": case "merror": case "maction":
      return all();
    case "semantics": return kids.length ? convert(kids[0]) : "";
    case "annotation": case "annotation-xml": case "mprescripts": case "none": return "";
    case "mi": {
      const value = text(element);
      if (FUNCTIONS.has(value)) return `\\${value}`;
      if ([...value].length <= 1) return token(value);
      return /^[A-Za-z0-9 ]+$/.test(value) ? `\\mathrm{${value}}` : `\\text{${escapeText(value)}}`;
    }
    case "mn": return token(text(element));
    case "mo": {
      const value = text(element);
      if (FUNCTIONS.has(value)) return `\\${value}`;
      return token(value);
    }
    case "mtext": case "ms": {
      const value = element.textContent ?? "";
      return value.trim() ? `\\text{${escapeText(value)}}` : value ? "\\ " : "";
    }
    case "mspace": return "\\,";
    case "msup": return kids.length >= 2 ? `${group(convert(kids[0]))}^${group(convert(kids[1]))}` : all();
    case "msub": return kids.length >= 2 ? `${group(convert(kids[0]))}_${group(convert(kids[1]))}` : all();
    case "msubsup": return kids.length >= 3 ? `${group(convert(kids[0]))}_${group(convert(kids[1]))}^${group(convert(kids[2]))}` : all();
    case "mfrac": {
      if (kids.length < 2) return all();
      const thickness = element.getAttribute("linethickness");
      if (thickness !== null && /^0(?:\.0*)?(?:[a-z]+)?$/i.test(thickness.trim())) return `\\genfrac{}{}{0pt}{}{${convert(kids[0])}}{${convert(kids[1])}}`;
      return `\\frac{${convert(kids[0])}}{${convert(kids[1])}}`;
    }
    case "msqrt": return `\\sqrt{${all()}}`;
    case "mroot": return kids.length >= 2 ? `\\sqrt[${convert(kids[1])}]{${convert(kids[0])}}` : `\\sqrt{${all()}}`;
    case "mover": {
      if (kids.length < 2) return all();
      const base = convert(kids[0]);
      const over = text(kids[1]);
      if (ACCENTS[over]) return `\\${ACCENTS[over]}{${base}}`;
      return LIMIT_OPERATORS.test(base) ? `${base}^${group(convert(kids[1]))}` : `\\overset{${convert(kids[1])}}{${base}}`;
    }
    case "munder": {
      if (kids.length < 2) return all();
      const base = convert(kids[0]);
      const under = text(kids[1]);
      if (UNDER_ACCENTS[under]) return `\\${UNDER_ACCENTS[under]}{${base}}`;
      return LIMIT_OPERATORS.test(base) ? `${base}_${group(convert(kids[1]))}` : `\\underset{${convert(kids[1])}}{${base}}`;
    }
    case "munderover": {
      if (kids.length < 3) return all();
      const base = convert(kids[0]);
      return LIMIT_OPERATORS.test(base)
        ? `${base}_${group(convert(kids[1]))}^${group(convert(kids[2]))}`
        : `\\underset{${convert(kids[1])}}{\\overset{${convert(kids[2])}}{${base}}}`;
    }
    case "mmultiscripts": {
      if (!kids.length) return "";
      const base = convert(kids[0]);
      const scripts = kids.slice(1);
      const split = scripts.findIndex((kid) => kid.localName === "mprescripts");
      const post = split < 0 ? scripts : scripts.slice(0, split);
      const pre = split < 0 ? [] : scripts.slice(split + 1);
      const pairs = (list: Element[]) => {
        let out = "";
        for (let index = 0; index + 1 < list.length; index += 2) {
          const sub = convert(list[index]);
          const sup = convert(list[index + 1]);
          out += `${sub ? `_${group(sub)}` : ""}${sup ? `^${group(sup)}` : ""}`;
        }
        return out;
      };
      const before = pairs(pre);
      return `${before ? `{}${before}` : ""}${group(base)}${pairs(post)}`;
    }
    case "mtable": {
      const rows = kids.filter((kid) => kid.localName === "mtr" || kid.localName === "mlabeledtr");
      const body = rows.map((row) => children(row).filter((cell) => cell.localName === "mtd").map(convert).join(" & ")).join(" \\\\ ");
      return `\\begin{matrix} ${body} \\end{matrix}`;
    }
    case "mtr": case "mlabeledtr": return children(element).map(convert).join(" & ");
    case "mtd": return all();
    case "mfenced": {
      const open = element.getAttribute("open") ?? "(";
      const close = element.getAttribute("close") ?? ")";
      const separators = (element.getAttribute("separators") ?? ",").replace(/\s+/g, "");
      const parts: string[] = [];
      kids.forEach((kid, index) => {
        if (index) parts.push(separators ? separators[Math.min(index - 1, separators.length - 1)] : "");
        parts.push(convert(kid));
      });
      return `\\left${FENCES[open] ?? "."}${join(parts)}\\right${FENCES[close] ?? "."}`;
    }
    default: return all() || text(element);
  }
}

/** A MathML `<math>` element as TeX, or null when it holds nothing. */
export function mathmlToTex(element: Element): string | null {
  const tex = convert(element).replace(/\s+/g, " ").trim();
  return tex || null;
}
