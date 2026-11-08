import type { MdNode } from "./analyze";

/* Clipboard HTML (Word, Google Docs, web pages) as the Markdown tree the
 * converter reads, so a rich-text paste is written with the same choices,
 * the same dialog and the same settings as a Markdown paste
 * (docs/latex-markdown-paste-plan.md §9). The DOM walk follows html2latex.ts:
 * Google Docs' wrapper is unwrapped, formatting on spans counts, TeX comes
 * from MathML and KaTeX annotations, and what has no equivalent is dropped. */

const BLOCKS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "TABLE", "PRE", "BLOCKQUOTE", "SECTION", "ARTICLE", "HEADER", "FOOTER", "FIGURE", "HR", "MAIN", "ASIDE", "NAV", "DL", "DT", "DD", "FIGCAPTION", "CENTER"]);
const SKIP = new Set(["SCRIPT", "STYLE", "HEAD", "META", "LINK", "TITLE", "NOSCRIPT", "TEMPLATE", "SVG", "VIDEO", "AUDIO", "IFRAME", "OBJECT", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "CANVAS"]);

type Context = { pre: boolean };

/** HTML that only wraps plain source text (code editors' clipboards): its text/plain is the thing to paste. */
export function isSourceWrapperBody(body: HTMLElement) {
  return Array.from(body.querySelectorAll("*")).every((element) => /^(?:HTML|HEAD|BODY|META|STYLE|DIV|SPAN|BR)$/.test(element.tagName))
    && !body.querySelector("[style*='font-weight'], [style*='font-style']");
}

function texAnnotation(element: Element) {
  const annotation = element.querySelector("annotation[encoding='application/x-tex'], annotation[encoding='TeX']");
  return annotation?.textContent?.trim() || element.getAttribute("data-latex") || element.getAttribute("alttext") || null;
}

function isBlockElement(node: Node): node is HTMLElement {
  return node.nodeType === 1 && BLOCKS.has((node as HTMLElement).tagName);
}

function textNode(value: string): MdNode {
  return { type: "text", value };
}

function wrapInline(type: string, children: MdNode[], extra: Partial<MdNode> = {}): MdNode[] {
  if (!children.some((child) => child.type !== "text" || (child.value ?? "").trim())) return children;
  return [{ type, children, ...extra }];
}

function inline(node: Node, context: Context): MdNode[] {
  if (node.nodeType === 3) {
    const text = node.textContent ?? "";
    return text ? [textNode(context.pre ? text : text.replace(/[ \t\r\n]+/g, " "))] : [];
  }
  if (node.nodeType !== 1) return [];
  const element = node as HTMLElement;
  // MathML and SVG elements keep lower-case tag names.
  const tag = element.tagName.toUpperCase();
  if (SKIP.has(tag)) return [];
  if (tag === "MATH" || element.classList.contains("katex") || element.classList.contains("katex-display") || element.classList.contains("MathJax")) {
    const tex = texAnnotation(element);
    if (tex) {
      const display = element.getAttribute("display") === "block" || element.classList.contains("katex-display");
      return [{ type: display ? "math" : "inlineMath", value: tex }];
    }
  }
  if (tag === "BR") return [{ type: "break" }];
  if (tag === "IMG") {
    const src = element.getAttribute("src") ?? "";
    return src ? [{ type: "image", url: src, alt: element.getAttribute("alt") ?? "", title: element.getAttribute("title") }] : [];
  }
  if (tag === "INPUT" && element.getAttribute("type") === "checkbox") return [];
  const children = () => Array.from(element.childNodes).flatMap((child) => inline(child, context));
  let content: MdNode[];
  switch (tag) {
    case "B": case "STRONG": content = wrapInline("strong", children()); break;
    case "I": case "EM": case "CITE": case "DFN": case "VAR": content = wrapInline("emphasis", children()); break;
    case "U": case "INS": content = wrapInline("liberaUnderline", children()); break;
    case "S": case "DEL": case "STRIKE": content = wrapInline("delete", children()); break;
    case "SUP": content = wrapInline("superscript", children()); break;
    case "SUB": content = wrapInline("subscript", children()); break;
    case "MARK": content = wrapInline("liberaHighlight", children()); break;
    case "CODE": case "KBD": case "SAMP": case "TT":
      content = context.pre ? children() : (element.textContent ?? "") ? [{ type: "inlineCode", value: (element.textContent ?? "").replace(/[ \t\r\n]+/g, " ") }] : [];
      break;
    case "A": {
      const href = element.getAttribute("href") ?? "";
      content = /^(?:https?:|mailto:|ftp:|#)/i.test(href) ? [{ type: "link", url: href, title: element.getAttribute("title"), children: children() }] : children();
      break;
    }
    default: content = children();
  }
  // Word and Google Docs mark formatting with styles on spans.
  if (tag === "SPAN" || tag === "FONT") {
    const style = element.getAttribute("style") ?? "";
    if (/font-weight\s*:\s*(?:bold|[6-9]00)/i.test(style)) content = wrapInline("strong", content);
    if (/font-style\s*:\s*italic/i.test(style)) content = wrapInline("emphasis", content);
    if (/text-decoration[^;]*underline/i.test(style)) content = wrapInline("liberaUnderline", content);
    if (/text-decoration[^;]*line-through/i.test(style)) content = wrapInline("delete", content);
    if (/vertical-align\s*:\s*super/i.test(style)) content = wrapInline("superscript", content);
    if (/vertical-align\s*:\s*sub/i.test(style)) content = wrapInline("subscript", content);
  }
  return content;
}

/** Inline nodes with runs of whitespace at the paragraph's edges removed. */
function trimInline(nodes: MdNode[]): MdNode[] {
  const out = nodes.map((node) => ({ ...node }));
  while (out.length && out[0].type === "text" && !(out[0].value ?? "").trim()) out.shift();
  while (out.length && out[out.length - 1].type === "text" && !(out[out.length - 1].value ?? "").trim()) out.pop();
  if (out[0]?.type === "text") out[0].value = (out[0].value ?? "").trimStart();
  const last = out[out.length - 1];
  if (last?.type === "text") last.value = (last.value ?? "").trimEnd();
  return out;
}

function paragraphOf(nodes: MdNode[]): MdNode[] {
  const children = trimInline(nodes);
  if (!children.length) return [];
  // A display formula on its own is a block of its own.
  if (children.length === 1 && children[0].type === "math") return children;
  return [{ type: "paragraph", children }];
}

const MAX_TABLE_COLUMNS = 64;
const MAX_TABLE_ROWS = 5000;

/** A `colspan`/`rowspan` attribute as a whole number from 1 to 64 (anything else, `Infinity` or `2.5` included, is read safely). */
function htmlSpan(value: string | null) {
  const span = Math.floor(Number(value));
  return Number.isFinite(span) && span >= 1 ? Math.min(span, MAX_TABLE_COLUMNS) : 1;
}

/** A table cell's content: inline, with its paragraphs, lists and line breaks as line breaks. */
function cellContent(cell: HTMLElement): MdNode[] {
  if (!Array.from(cell.children).some((child) => BLOCKS.has(child.tagName))) return trimInline(inline(cell, { pre: false }));
  const out: MdNode[] = [];
  for (const part of blocks(cell, { pre: false })) {
    if (out.length) out.push({ type: "break" });
    out.push(...(part.type === "paragraph" || part.type === "heading" ? part.children ?? [] : [{ type: "text", value: plainTextOf(part) }]));
  }
  return out;
}

function plainTextOf(node: MdNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(plainTextOf).join(node.type === "list" ? "; " : " ");
}

function alignOf(cell: Element): "left" | "right" | "center" | null {
  const value = (cell.getAttribute("align") ?? /text-align\s*:\s*(left|right|center)/i.exec(cell.getAttribute("style") ?? "")?.[1] ?? "").toLowerCase();
  return value === "left" || value === "right" || value === "center" ? value : null;
}

function block(element: HTMLElement, context: Context): MdNode[] {
  const tag = element.tagName;
  if (SKIP.has(tag)) return [];
  switch (tag) {
    case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": {
      const children = trimInline(inline(element, context));
      return children.length ? [{ type: "heading", depth: Number(tag[1]), children }] : [];
    }
    case "HR": return [{ type: "thematicBreak" }];
    case "PRE": {
      const language = /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(`${element.className} ${element.querySelector("code")?.className ?? ""}`)?.[1] ?? null;
      return [{ type: "code", lang: language, value: (element.textContent ?? "").replace(/\n$/, "") }];
    }
    case "BLOCKQUOTE": {
      const children = blocks(element, context);
      return children.length ? [{ type: "blockquote", children }] : [];
    }
    case "UL": case "OL": {
      const items = Array.from(element.children).filter((child) => child.tagName === "LI").map((item): MdNode => {
        const box = item.querySelector(":scope > input[type='checkbox'], :scope > p > input[type='checkbox']") as HTMLInputElement | null;
        return { type: "listItem", checked: box ? box.hasAttribute("checked") || box.checked : null, children: blocks(item as HTMLElement, context) };
      });
      const start = Number(element.getAttribute("start"));
      return items.length ? [{ type: "list", ordered: tag === "OL", start: tag === "OL" && Number.isFinite(start) && start > 0 ? start : 1, children: items }] : [];
    }
    case "TABLE": {
      const rows = Array.from(element.querySelectorAll("tr")).filter((row) => row.closest("table") === element).slice(0, MAX_TABLE_ROWS);
      if (!rows.length) return [];
      const align: Array<"left" | "right" | "center" | null> = [];
      // Cells a row span carries into the rows below: an empty cell holds their place, so later cells keep their columns.
      const carried: number[] = [];
      let rowSpans = false;
      const tableRows = rows.map((row): MdNode => {
        const cells: MdNode[] = [];
        let column = 0;
        const fillCarried = () => {
          while (column < MAX_TABLE_COLUMNS && (carried[column] ?? 0) > 0) {
            carried[column]--;
            cells.push({ type: "tableCell", children: [] });
            column++;
          }
        };
        for (const cell of Array.from(row.children).filter((child) => child.tagName === "TD" || child.tagName === "TH")) {
          fillCarried();
          if (column >= MAX_TABLE_COLUMNS) break;
          const span = Math.min(htmlSpan(cell.getAttribute("colspan")), MAX_TABLE_COLUMNS - column);
          const down = htmlSpan(cell.getAttribute("rowspan")) - 1;
          if (down > 0) rowSpans = true;
          for (let index = 0; index < span; index++) carried[column + index] = Math.min(down, MAX_TABLE_ROWS);
          if (row === rows[0]) for (let index = 0; index < span; index++) align.push(alignOf(cell));
          cells.push({ type: "tableCell", children: cellContent(cell as HTMLElement), data: span > 1 ? { hProperties: { colspan: span } } : undefined });
          column += span;
        }
        fillCarried();
        return { type: "tableRow", children: cells };
      });
      // Without header cells, the first row is still the header Markdown expects; an empty one is added instead when it is data.
      const header = Array.from(rows[0].children).every((cell) => cell.tagName === "TH");
      const width = Math.max(1, ...tableRows.map((row) => (row.children ?? []).reduce((sum, cell) => sum + Number(cell.data?.hProperties?.colspan ?? 1), 0)));
      const children = header ? tableRows : [{ type: "tableRow", children: Array.from({ length: width }, (): MdNode => ({ type: "tableCell", children: [] })) }, ...tableRows];
      const table: MdNode = { type: "table", align: Array.from({ length: width }, (_, index) => align[index] ?? null), children, data: rowSpans ? { hProperties: { rowspan: true } } : undefined };
      // A <caption> is the table's caption, found as "Table: …" next to it.
      const caption = element.querySelector(":scope > caption")?.textContent?.replace(/\s+/g, " ").trim();
      return caption ? [{ type: "paragraph", children: [{ type: "text", value: `Table: ${caption}` }] }, table] : [table];
    }
    case "LI": case "DIV": case "SECTION": case "ARTICLE": case "HEADER": case "FOOTER": case "FIGURE": case "BODY": case "MAIN": case "ASIDE": case "NAV": case "DL": case "DD": case "CENTER": case "TD": case "TH":
      return blocks(element, context);
    case "DT": case "FIGCAPTION":
      return paragraphOf(inline(element, context));
    default:
      return paragraphOf(inline(element, context));
  }
}

/** Block-level children as blocks; runs of inline content between them form paragraphs. */
function blocks(element: HTMLElement, context: Context): MdNode[] {
  const out: MdNode[] = [];
  let run: MdNode[] = [];
  const flush = () => { out.push(...paragraphOf(run)); run = []; };
  for (const child of Array.from(element.childNodes)) {
    if (isBlockElement(child)) {
      flush();
      out.push(...block(child, context));
    } else run.push(...inline(child, context));
  }
  flush();
  return out;
}

/** Clipboard HTML as a Markdown tree, or null when it should be pasted as plain text. */
export function htmlToMarkdownTree(html: string): MdNode | null {
  if (!html.trim()) return null;
  const body = new DOMParser().parseFromString(html, "text/html").body;
  if (!body || isSourceWrapperBody(body)) return null;
  // Google Docs wraps everything in a <b style="font-weight:normal">.
  for (const wrapper of Array.from(body.querySelectorAll("b[style*='font-weight:normal'], b[style*='font-weight: normal']"))) {
    wrapper.replaceWith(...Array.from(wrapper.childNodes));
  }
  const children = blocks(body, { pre: false });
  return children.length ? { type: "root", children } : null;
}
