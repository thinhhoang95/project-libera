// The collaborator-content sanitizer (src/lib/markdown-sanitize.ts): a table
// of hostile HTML for the allowlist, hostile Markdown through the real
// renderer, the shared-document image policy, and proof that Libera's own
// syntax renders exactly as before (the sanitized tree equals the
// unsanitized one) in the renderer, the preview worker and PDF notes.

import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DOMParser", "MutationObserver", "getComputedStyle"] as const) {
  Object.defineProperty(globalThis, key, {
    value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key],
    configurable: true,
  });
}

import { generateHTML } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import type { Root, RootContent } from "hast";
import { fromHtmlIsomorphic } from "hast-util-from-html-isomorphic";
import katex from "katex";
import { Marked, type marked } from "marked";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import rehypeKatex from "rehype-katex";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import { MarkdownRenderer } from "../../src/components/markdown-renderer";
import { prepareMarkdownPreview } from "../../src/lib/markdown-preview";
import { cachedPreviewMath } from "../../src/lib/markdown-preview-math";
import { markdownRemarkPlugins } from "../../src/lib/markdown-rendering";
import { safeImageUrl, safeLinkUrl, sanitizeHast, sanitizeHtmlFragment } from "../../src/lib/markdown-sanitize";
import { normalizeMarkdownHighlightDelimiters } from "../../src/lib/markdown-highlights";
import { createAnnotationMarkdownExtensions, renderAnnotationMarkdown } from "../../src/lib/pdf-annotation-markdown";

// ---------------------------------------------------------------- the allowlist

const HOSTILE: Array<[label: string, input: string, expected: string]> = [
  ["script element", "<p>a<script>alert(1)</script>b</p>", "<p>ab</p>"],
  ["script in svg", '<svg viewBox="0 0 1 1"><script>alert(1)</script><path d="M0 0"></path></svg>', '<svg viewBox="0 0 1 1"><path d="M0 0"></path></svg>'],
  ["img onerror", '<img src="x.png" onerror="alert(1)">', '<img src="x.png">'],
  ["svg onload", '<svg onload="alert(1)"></svg>', "<svg></svg>"],
  ["event handler on anything", '<span onclick="alert(1)" onmouseover="x()" class="ok">t</span>', '<span class="ok">t</span>'],
  ["javascript: link", '<a href="javascript:alert(1)">x</a>', '<a href="">x</a>'],
  ["mixed-case javascript:", '<a href="JaVaScRiPt:alert(1)">x</a>', '<a href="">x</a>'],
  ["entity-encoded javascript:", '<a href="&#106;avascript:alert(1)">x</a>', '<a href="">x</a>'],
  ["tab inside the scheme", '<a href="java&#9;script:alert(1)">x</a>', '<a href="">x</a>'],
  ["leading space", '<a href=" javascript:alert(1)">x</a>', '<a href="">x</a>'],
  ["data: link", '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>', '<a href="">x</a>'],
  ["vbscript: link", '<a href="vbscript:msgbox(1)">x</a>', '<a href="">x</a>'],
  ["file: link", '<a href="file:///C:/Windows/win.ini">x</a>', '<a href="">x</a>'],
  ["safe links stay", '<a href="https://example.com/a?b#c">x</a><a href="mailto:a@b.c">m</a><a href="notes/a.md#h">r</a>', '<a href="https://example.com/a?b#c">x</a><a href="mailto:a@b.c">m</a><a href="notes/a.md#h">r</a>'],
  ["href only on links", '<span href="https://x">t</span>', "<span>t</span>"],
  ["svg xlink:href", '<svg><a xlink:href="javascript:alert(1)"><path d="M0 0"></path></a></svg>', '<svg><path d="M0 0"></path></svg>'],
  ["iframe", '<iframe src="https://evil.example"></iframe>ok', "ok"],
  ["object and embed", '<object data="x.swf"><param name="a" value="b"></object><embed src="x.swf">ok', "ok"],
  ["style element", "<style>body{display:none}</style>ok", "ok"],
  ["link and meta", '<link rel="stylesheet" href="https://evil/x.css"><meta http-equiv="refresh" content="0;url=https://evil">ok', "ok"],
  ["base element", '<base href="https://evil/">ok', "ok"],
  ["forms", '<form action="https://evil"><input type="text" name="q"><button>go</button></form>ok', "ok"],
  ["text inputs", '<input type="text" value="x"><input type="checkbox" checked="" disabled="">', '<input type="checkbox" checked="" disabled="">'],
  ["foreignObject", "<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>", "<svg></svg>"],
  ["MathML annotation-xml", '<math><semantics><mi>x</mi><annotation-xml encoding="text/html"><img src=x onerror=alert(1)></annotation-xml></semantics></math>', "<math><semantics><mi>x</mi></semantics></math>"],
  ["math href", '<math><mi href="javascript:alert(1)">x</mi></math>', "<math><mi>x</mi></math>"],
  ["style with url()", '<div style="background:url(javascript:alert(1))">t</div>', "<div>t</div>"],
  ["style with expression()", '<div style="width:expression(alert(1))">t</div>', "<div>t</div>"],
  ["style with escapes", '<div style="background:u\\72l(x)">t</div>', "<div>t</div>"],
  ["fixed overlay", '<div style="position:fixed;inset:0">t</div>', "<div>t</div>"],
  ["safe style stays", '<span style="color:#dc2626;font-size:20px">t</span>', '<span style="color:#dc2626;font-size:20px">t</span>'],
  ["unknown element unwrapped", "<blink>t<marquee>u</marquee></blink>", "tu"],
  ["details ontoggle", '<details open="" ontoggle="alert(1)"><summary>s</summary></details>', '<details open=""><summary>s</summary></details>'],
  ["target other than _blank", '<a href="https://x" target="_top">x</a><a href="https://y" target="_blank" rel="noopener">y</a>', '<a href="https://x">x</a><a href="https://y" target="_blank" rel="noopener">y</a>'],
  ["comments", "a<!-- secret -->b", "ab"],
  ["srcdoc and formaction", '<div srcdoc="<script>" formaction="javascript:x">t</div>', "<div>t</div>"],
  ["data and aria attributes stay", '<span data-markdown-color="#dc2626" aria-hidden="true">t</span>', '<span data-markdown-color="#dc2626" aria-hidden="true">t</span>'],
];

test("allowlist: hostile HTML", () => {
  for (const [label, input, expected] of HOSTILE) {
    assert.equal(sanitizeHtmlFragment(input), expected, label);
  }
});

test("image sources: local notes as before, shared documents https and local assets only", () => {
  const cases: Array<[src: string, local: string | null, shared: string | null]> = [
    ["images/a.png", "images/a.png", "images/a.png"],
    ["../assets/b.jpg", "../assets/b.jpg", "../assets/b.jpg"],
    ["https://cdn.example/x.png", "https://cdn.example/x.png", "https://cdn.example/x.png"],
    ["http://tracker.example/x.png?u=1", "http://tracker.example/x.png?u=1", null],
    ["//tracker.example/x.png", "//tracker.example/x.png", null],
    ["/api/markdown-assets/raw?document=a&asset=b", "/api/markdown-assets/raw?document=a&asset=b", "/api/markdown-assets/raw?document=a&asset=b"],
    ["/api/auth/logout", "/api/auth/logout", null],
    ["data:image/png;base64,iVBORw0KGgo=", "data:image/png;base64,iVBORw0KGgo=", null],
    ["data:image/svg+xml;base64,PHN2Zz4=", "", null],
    ["javascript:alert(1)", "", null],
    ["file:///etc/passwd", "", null],
  ];
  for (const [src, local, shared] of cases) {
    assert.equal(safeImageUrl(src, "local"), local, `local ${src}`);
    assert.equal(safeImageUrl(src, "shared"), shared, `shared ${src}`);
  }
  assert.equal(
    sanitizeHtmlFragment('<img src="http://tracker.example/p.png" alt="Chart">', { trust: "shared" }),
    '<span class="markdown-blocked-image" title="Image not shown: shared notebooks show only https images and their own files.">[Chart]</span>',
  );
  assert.equal(sanitizeHtmlFragment('<img src="http://tracker.example/p.png" alt="Chart">'), '<img src="http://tracker.example/p.png" alt="Chart">');
  assert.equal(safeLinkUrl("irc://irc.example/#chan"), "irc://irc.example/#chan");
});

test("hostile Markdown through the renderer: raw HTML is text, bad URLs are emptied", () => {
  const render = (content: string, contentTrust?: "local" | "shared") =>
    renderToStaticMarkup(createElement(MarkdownRenderer, { content, ...(contentTrust ? { contentTrust } : {}) }));
  const html = render(
    [
      "<script>alert(1)</script>",
      "",
      '<img src="x" onerror="alert(1)">',
      "",
      "[click](javascript:alert(1)) [data](data:text/html,hi) [ok](https://example.com)",
      "",
      "![pic](javascript:alert(1)) ![tracker](http://tracker.example/t.png)",
      "",
      "$\\href{javascript:alert(1)}{x}$ and $\\htmlStyle{position:fixed}{y}$",
    ].join("\n"),
  );
  assert.ok(!/<script/i.test(html), "no script element");
  assert.ok(!/<img[^>]*onerror/i.test(html), "no handler attribute");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "raw HTML stays visible as text");
  assert.ok(!/href="javascript:/i.test(html) && !/href="data:/i.test(html));
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.ok(!/src="javascript:/i.test(html));
  assert.ok(!/style="[^"]*position:\s*fixed/.test(html), "KaTeX without trust does not emit styles from input");
  assert.match(html, /src="http:\/\/tracker\.example\/t\.png"/, "local notes keep http images");

  const shared = render("![tracker](http://tracker.example/t.png) ![ok](https://cdn.example/a.png) ![asset](img/a.png)", "shared");
  assert.ok(!shared.includes("tracker.example"), "shared documents do not load http images");
  assert.match(shared, /class="markdown-blocked-image"[^>]*>\[tracker\]</);
  assert.match(shared, /src="https:\/\/cdn\.example\/a\.png"/);
  assert.match(shared, /src="img\/a\.png"/, "relative assets of the notebook still load");
});

// ---------------------------------------------------------------- Libera syntax unchanged

const LIBERA = [
  "# Heading 1",
  "## Heading 2",
  "###### Heading 6",
  "####### Heading 7",
  "",
  "Plain **bold** *em* ~~struck~~ `code` and a [link](https://example.com \"title\") and <https://auto.example>.",
  "",
  "y>>>yellow highlight<<< r>>>red<<< ==classic==",
  "",
  "[color=#dc2626]red text[/color] and [color=#16a34a]green[/color]",
  "",
  "<u>underlined</u> and <span data-font-size=\"20\">big</span> and <span data-line-height=\"2\">tall</span>",
  "",
  "b> Blue box with **bold**",
  "b>",
  "b> - item",
  "",
  "> Plain quote",
  "",
  "- [x] done",
  "- [ ] todo",
  "",
  "1. one",
  "2. two",
  "",
  "| a | b |",
  "|:--|--:|",
  "| 1 | 2 |",
  "",
  "Inline $E=mc^2$ and $\\sqrt{x^2+1}$ and $\\color{red}{x}$ and $\\overrightarrow{AB}$ and $\\underbrace{a+b}_{c}$.",
  "",
  "$$",
  "\\begin{aligned} \\int_0^1 x\\,dx &= \\tfrac12 \\\\ \\left\\{ \\frac{a}{b} \\right\\} \\end{aligned}",
  "$$",
  "",
  "$\\frac{a$ broken",
  "",
  "Footnote[^1].",
  "",
  "[^1]: The note.",
  "",
  "![relative](images/a.png) ![remote](http://example.com/b.png) ![pasted](data:image/png;base64,iVBORw0KGgo=)",
  "",
  "```ts",
  "const x = 1 < 2;",
  "```",
  "",
  "---",
].join("\n");

/** Positions differ between otherwise equal trees; raw nodes become text in react-markdown. */
function normalize(nodes: RootContent[]): unknown[] {
  return nodes.map((node) => {
    if (node.type === "raw") return { type: "text", value: node.value };
    if (node.type === "element") return { type: "element", tagName: node.tagName, properties: node.properties, children: normalize(node.children as RootContent[]) };
    if (node.type === "text") return { type: "text", value: node.value };
    return { type: node.type };
  });
}

test("Libera syntax: the sanitized tree equals the unsanitized one (renderer pipeline)", () => {
  const processor = unified().use(remarkParse).use(markdownRemarkPlugins()).use(remarkRehype, { allowDangerousHtml: true }).use(rehypeKatex);
  const source = normalizeMarkdownHighlightDelimiters(LIBERA);
  const tree = processor.runSync(processor.parse(source)) as Root;
  const before = normalize(structuredClone(tree).children);
  const after = normalize(sanitizeHast(structuredClone(tree)).children);
  assert.deepEqual(after, before);
  const shared = normalize(sanitizeHast(structuredClone(tree), { trust: "shared" }).children);
  assert.notDeepEqual(shared, before, "shared trust blocks the http and data images");
});

test("Libera syntax: the preview worker's tree is unchanged by sanitizing", () => {
  const processor = unified().use(remarkParse).use(markdownRemarkPlugins()).use(remarkRehype, { allowDangerousHtml: true }).use(cachedPreviewMath);
  const source = normalizeMarkdownHighlightDelimiters(LIBERA);
  const unsanitized = normalize((processor.runSync(processor.parse(source)) as Root).children);
  assert.deepEqual(normalize(prepareMarkdownPreview(LIBERA).children), unsanitized);
});

test("Libera syntax: renderer output is the same for the direct and worker paths", () => {
  const direct = renderToStaticMarkup(createElement(MarkdownRenderer, { content: LIBERA }));
  const prepared = renderToStaticMarkup(createElement(MarkdownRenderer, { content: LIBERA, preparedTree: structuredClone(prepareMarkdownPreview(LIBERA)) }));
  assert.equal(prepared, direct);
  for (const fragment of ['class="katex"', "<u", "<mark", 'data-box-color="b"', "markdown-text-color", 'type="checkbox"', 'src="data:image/png;base64', "<table", "data-footnote-ref"]) {
    assert.ok(direct.includes(fragment), `renders ${fragment}`);
  }
});

function htmlTree(html: string): unknown[] {
  return normalize(fromHtmlIsomorphic(html, { fragment: true }).children);
}

test("PDF notes: the sanitized note HTML parses to the same tree as before", () => {
  const notes = [
    "**Key** point\nsecond line\n\n- one\n- two",
    "[link](https://example.com) and ==mark== and y>>>yellow<<< and <u>under</u>",
    "[color=#dc2626]red[/color] <span data-font-size=\"20\">big</span> <span data-line-height=\"2\">tall</span>",
    "b> boxed note",
    "- [x] done\n- [ ] todo",
    "| a | b |\n|---|---|\n| 1 | 2 |",
    "![img](images/a.png)",
    "```js\nlet a = 1 < 2;\n```",
  ];
  const extensions = createAnnotationMarkdownExtensions("");
  const manager = new MarkdownManager({ marked: new Marked({ gfm: true, breaks: true }) as unknown as typeof marked, extensions });
  for (const note of notes) {
    const raw = generateHTML(manager.parse(note), extensions);
    assert.deepEqual(htmlTree(renderAnnotationMarkdown(note)), htmlTree(raw), note);
  }
  const hostile = renderAnnotationMarkdown("[x](javascript:alert(1)) <img src=x onerror=alert(1)> <script>alert(1)</script>");
  assert.ok(!/javascript:|onerror|<script/i.test(hostile), hostile);
});

test("KaTeX output survives the allowlist unchanged (HTML, MathML and SVG)", () => {
  for (const tex of ["E=mc^2", "\\sqrt{x^2+1}", "\\overrightarrow{AB}", "\\underbrace{a+b}_{c}", "\\color{#dc2626}{x}", "\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}", "\\xrightarrow[a]{b}", "\\cancel{x}", "\\boxed{y}"]) {
    for (const displayMode of [false, true]) {
      const html = katex.renderToString(tex, { displayMode, throwOnError: false, trust: false });
      assert.deepEqual(htmlTree(sanitizeHtmlFragment(html)), htmlTree(html), tex);
    }
  }
});
