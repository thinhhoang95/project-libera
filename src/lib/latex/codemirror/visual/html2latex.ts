/* Clipboard HTML (Word, Google Docs, web pages) as LaTeX, for pasting in the
 * Visual mode (docs/latex-visual-editor-plan.md §6.7). Deterministic: text is
 * escaped, symbols become commands, structure that has a LaTeX equivalent
 * keeps it, and anything else is dropped. */

import { escapeLatexText, isSafeMathTex, latexUrl } from "../../latex-text";

export { escapeLatexText, isSafeMathTex, latexUrl };

/** HTML that only wraps plain source text (code editors' clipboards): paste its text/plain instead. */
export function isSourceWrapperHtml(body: HTMLElement) {
  return Array.from(body.querySelectorAll("*")).every((element) => /^(?:HTML|HEAD|BODY|META|STYLE|DIV|SPAN|BR)$/.test(element.tagName))
    && !body.querySelector("[style*='font-weight'], [style*='font-style']");
}

type Context = { pre: boolean; listDepth: number };

const BLOCKS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "TABLE", "PRE", "BLOCKQUOTE", "SECTION", "ARTICLE", "HEADER", "FOOTER", "FIGURE", "HR"]);
const SKIP = new Set(["SCRIPT", "STYLE", "HEAD", "META", "LINK", "TITLE", "NOSCRIPT", "TEMPLATE", "IMG", "SVG", "VIDEO", "AUDIO", "IFRAME", "OBJECT", "BUTTON", "INPUT", "SELECT", "TEXTAREA"]);

function texAnnotation(element: Element) {
  const annotation = element.querySelector("annotation[encoding='application/x-tex'], annotation[encoding='TeX']");
  return annotation?.textContent?.trim() || null;
}

function wrap(command: string, content: string) {
  return content.trim() ? `\\${command}{${content}}` : content;
}

function inline(node: Node, context: Context): string {
  if (node.nodeType === 3) {
    const text = node.textContent ?? "";
    return context.pre ? text : escapeLatexText(text.replace(/[ \t\r\n]+/g, " "));
  }
  if (node.nodeType !== 1) return "";
  const element = node as HTMLElement;
  // MathML and SVG elements keep lower-case tag names.
  const tag = element.tagName.toUpperCase();
  if (SKIP.has(tag)) return "";
  if (tag === "MATH" || element.classList.contains("katex") || element.classList.contains("MathJax")) {
    const tex = texAnnotation(element) ?? element.getAttribute("data-latex") ?? element.getAttribute("alttext");
    if (tex && isSafeMathTex(tex)) return element.getAttribute("display") === "block" ? `\n\\[\n${tex}\n\\]\n` : `$${tex}$`;
    // TeX that could leave its formula (or read files) is pasted as the text it shows.
    if (tex) {
      const shown = element.cloneNode(true) as HTMLElement;
      for (const hidden of Array.from(shown.querySelectorAll("annotation, annotation-xml, .katex-mathml"))) hidden.remove();
      return escapeLatexText((shown.textContent ?? "").replace(/[ \t\r\n]+/g, " "));
    }
  }
  if (tag === "BR") return context.pre ? "\n" : "\\\\\n";
  const children = () => Array.from(element.childNodes).map((child) => inline(child, context)).join("");
  const style = element.getAttribute("style") ?? "";
  let content: string;
  switch (tag) {
    case "B": case "STRONG": content = wrap("textbf", children()); break;
    case "I": case "EM": case "CITE": case "DFN": content = wrap("emph", children()); break;
    case "U": case "INS": content = wrap("underline", children()); break;
    case "SUP": content = wrap("textsuperscript", children()); break;
    case "SUB": content = wrap("textsubscript", children()); break;
    case "CODE": case "KBD": case "SAMP": case "TT": content = context.pre ? children() : wrap("texttt", children()); break;
    case "A": {
      const href = element.getAttribute("href") ?? "";
      const text = children();
      if (/^(?:https?:|mailto:)/i.test(href)) {
        const url = latexUrl(href);
        content = text.trim() && (element.textContent ?? "").trim() !== href ? `\\href{${url}}{${text}}` : `\\url{${url}}`;
      } else content = text;
      break;
    }
    default: content = children();
  }
  // Word and Google Docs mark formatting with styles on spans.
  if (tag === "SPAN" || tag === "FONT") {
    if (/font-weight\s*:\s*(?:bold|[6-9]00)/i.test(style)) content = wrap("textbf", content);
    if (/font-style\s*:\s*italic/i.test(style)) content = wrap("emph", content);
    if (/text-decoration[^;]*underline/i.test(style)) content = wrap("underline", content);
    if (/vertical-align\s*:\s*super/i.test(style)) content = wrap("textsuperscript", content);
    if (/vertical-align\s*:\s*sub/i.test(style)) content = wrap("textsubscript", content);
  }
  return content;
}

function block(element: HTMLElement, context: Context): string[] {
  const tag = element.tagName;
  if (SKIP.has(tag)) return [];
  switch (tag) {
    case "H1": return [wrap("section", inline(element, context).trim())];
    case "H2": return [wrap("subsection", inline(element, context).trim())];
    case "H3": return [wrap("subsubsection", inline(element, context).trim())];
    case "H4": case "H5": case "H6": return [wrap("paragraph", inline(element, context).trim())];
    case "HR": return [];
    case "PRE": {
      const code = (element.textContent ?? "").replace(/\n$/, "");
      // Text that would end the verbatim block early is pasted as escaped lines instead.
      if (!/\\end\s*\{verbatim\}/.test(code)) return [`\\begin{verbatim}\n${code}\n\\end{verbatim}`];
      return [code.split("\n").map((line) => `\\texttt{${escapeLatexText(line)}}`).join("\\\\\n")];
    }
    case "BLOCKQUOTE": {
      const inner = blocks(element, context).join("\n\n");
      return inner.trim() ? [`\\begin{quote}\n${inner}\n\\end{quote}`] : [];
    }
    case "UL": case "OL": {
      const env = tag === "OL" ? "enumerate" : "itemize";
      const outer = "  ".repeat(context.listDepth);
      const indent = "  ".repeat(context.listDepth + 1);
      // Nested lists carry their own indentation; an item's other blocks continue under it.
      const items = Array.from(element.children).filter((child) => child.tagName === "LI").map((item) => {
        const inner = blocks(item as HTMLElement, { ...context, listDepth: context.listDepth + 1 })
          .map((part, index) => (index === 0 || /^\s*\\begin\{(?:itemize|enumerate)\}/.test(part) ? part : `${indent}${part}`))
          .join("\n");
        return `${indent}\\item ${inner.trimStart()}`;
      });
      return items.length ? [`${outer}\\begin{${env}}\n${items.join("\n")}\n${outer}\\end{${env}}`] : [];
    }
    case "TABLE": {
      const rows = Array.from(element.querySelectorAll("tr")).filter((row) => row.closest("table") === element);
      if (!rows.length) return [];
      const cells = rows.map((row) => Array.from(row.children).filter((cell) => cell.tagName === "TD" || cell.tagName === "TH"));
      const width = Math.max(...cells.map((row) => row.reduce((sum, cell) => sum + (Number(cell.getAttribute("colspan")) || 1), 0)));
      const lines = cells.map((row) => `  ${row.map((cell) => {
        const text = inline(cell, { ...context, pre: false }).replace(/\\\\\n/g, " ").trim();
        const span = Number(cell.getAttribute("colspan")) || 1;
        return span > 1 ? `\\multicolumn{${span}}{l}{${text}}` : text;
      }).join(" & ")} \\\\`);
      const header = cells[0]?.every((cell) => cell.tagName === "TH");
      if (header) lines.splice(1, 0, "  \\hline");
      return [`\\begin{tabular}{${"l".repeat(Math.max(1, width))}}\n  \\hline\n${lines.join("\n")}\n  \\hline\n\\end{tabular}`];
    }
    case "LI": case "DIV": case "SECTION": case "ARTICLE": case "HEADER": case "FOOTER": case "FIGURE": case "BODY": case "TD": case "TH":
      return blocks(element, context);
    default: {
      const text = inline(element, context).replace(/[ \t]+/g, " ").trim();
      return text ? [text] : [];
    }
  }
}

/** Block-level children as paragraphs; runs of inline content between blocks form a paragraph of their own. */
function blocks(element: HTMLElement, context: Context): string[] {
  const out: string[] = [];
  let run = "";
  const flush = () => {
    const text = run.replace(/[ \t]+/g, " ").replace(/^\s+|\s+$/g, "");
    if (text) out.push(text);
    run = "";
  };
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 1 && BLOCKS.has((child as HTMLElement).tagName)) {
      flush();
      out.push(...block(child as HTMLElement, context));
    } else run += inline(child, context);
  }
  flush();
  return out;
}

/** LaTeX for clipboard HTML, or null when it should be pasted as plain text. */
export function htmlToLatex(html: string): string | null {
  if (!html.trim()) return null;
  const body = new DOMParser().parseFromString(html, "text/html").body;
  if (!body || isSourceWrapperHtml(body)) return null;
  // Google Docs wraps everything in a <b style="font-weight:normal">.
  for (const wrapper of Array.from(body.querySelectorAll("b[style*='font-weight:normal'], b[style*='font-weight: normal']"))) {
    wrapper.replaceWith(...Array.from(wrapper.childNodes));
  }
  const paragraphs = blocks(body, { pre: false, listDepth: 0 });
  const latex = paragraphs.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return latex || null;
}
