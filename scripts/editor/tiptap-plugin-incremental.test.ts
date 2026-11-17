import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { Editor, Extension } from "@tiptap/core";
import { Node as ProseMirrorNode, Slice } from "@tiptap/pm/model";
import { Step } from "@tiptap/pm/transform";
import { TextSelection, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { createMathExtensions } from "../../src/lib/tiptap-math";
import { TiptapMarkdownMacros, computeMacroState, tiptapMacrosKey } from "../../src/lib/tiptap-macros";
import { TiptapBoldLeadIns, leadInDecorations, leadInKey } from "../../src/lib/tiptap-bold-lead-ins";
import { TiptapHeadingNumbering, setTiptapHeadingNumbering } from "../../src/lib/tiptap-heading-numbering";
import { applyTiptapStructuralNumbers } from "../../src/lib/tiptap-editor-actions";
import { isMacroBlockLanguage } from "../../src/lib/markdown-macros";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DOMParser", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
after(() => dom.window.close());

const FENCE = "```";

function mount(content: string) {
  return new Editor({
    // Mounted: an editor without an element installs no ProseMirror plugins.
    element: document.createElement("div"),
    extensions: [...createMarkdownExtensions("Notes/a.md"), ...createMathExtensions(), TiptapMarkdownMacros, TiptapBoldLeadIns, TiptapHeadingNumbering],
    content, contentType: "markdown",
  });
}

/** A deterministic generator, so a failure can be replayed. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PASTES = [
  "**Lead.** rest of a paragraph",
  "plain paragraph\n\nanother one",
  "## Pasted heading\n\n**Bold** then text",
  "- one\n- **two** items\n\n> quoted **bold** text",
  `${FENCE}libera-macro\n\\x = $y$\n${FENCE}\n\n\\x and \\x`,
  "Counter \\counter-lemma here",
  "# Top\n\n### Deep",
  "$$E=mc^2$$\n\n**a** *b* **c**",
];

function parseBlocks(editor: Editor, markdown: string) {
  return editor.schema.nodeFromJSON(editor.markdown!.parse(markdown));
}

/** One random edit as a transaction; null for an edit the schema rejects. */
function buildEdit(editor: Editor, next: () => number): Transaction | null {
  const { state } = editor;
  const size = state.doc.content.size;
  const pos = () => Math.floor(next() * (size + 1));
  const textPos = () => {
    for (let tries = 0; tries < 20; tries++) {
      const at = pos();
      if (state.doc.resolve(at).parent.inlineContent) return at;
    }
    return 1;
  };
  const kind = Math.floor(next() * 9);
  const tr = state.tr;
  try {
    if (kind === 0 || kind === 1) {
      const at = textPos();
      tr.insertText(["a", "b ", "\\", "\\x", "*", "**"][Math.floor(next() * 6)], at);
    } else if (kind === 2) {
      const a = textPos();
      const b = Math.min(a + 1 + Math.floor(next() * 12), size);
      const bold = state.schema.marks.bold;
      if (next() < 0.5) tr.addMark(a, b, bold.create()); else tr.removeMark(a, b, bold);
    } else if (kind === 3) {
      tr.split(textPos());
    } else if (kind === 4) {
      const at = pos();
      if (tr.doc.resolve(at).parent.type.name === "doc") tr.join(at);
      else tr.join(tr.doc.resolve(at).after());
    } else if (kind === 5) {
      const a = pos();
      tr.delete(a, Math.min(a + 1 + Math.floor(next() * 40), size));
    } else if (kind === 6) {
      const slice = new Slice(parseBlocks(editor, PASTES[Math.floor(next() * PASTES.length)]).content, 0, 0);
      const a = pos();
      tr.replaceRange(a, Math.min(a + Math.floor(next() * 6), size), slice);
    } else if (kind === 7) {
      const a = textPos();
      if (next() < 0.5) tr.setBlockType(a, a, state.schema.nodes.heading, { level: 1 + Math.floor(next() * 3) });
      else tr.setBlockType(a, a, state.schema.nodes.paragraph);
    } else {
      const at = textPos();
      tr.setSelection(TextSelection.create(tr.doc, at));
    }
  } catch {
    return null;
  }
  return recursiveMacros(tr.doc) ? null : tr;
}

/** Random edits can build a macro whose body uses itself, which expands without end; such documents are not generated. */
function recursiveMacros(doc: ProseMirrorNode) {
  let found = false;
  doc.descendants((node) => {
    if (node.type.spec.code && isMacroBlockLanguage(node.attrs.language)) {
      const text = node.textContent;
      for (const [, name] of text.matchAll(/^\\(\w+)\s*=/gm)) if ((text.match(new RegExp(`\\\\${name}\\b`, "g")) ?? []).length > 1) found = true;
    }
    return !node.isTextblock;
  });
  return found;
}

function randomEdit(editor: Editor, next: () => number) {
  const tr = buildEdit(editor, next);
  if (tr) editor.view.dispatch(tr);
  return tr !== null;
}

const describe = (decorations: ReturnType<typeof leadInDecorations>) =>
  decorations.find().map((decoration) => `${decoration.from}-${decoration.to}-${(decoration as unknown as { type: { attrs: { class: string } } }).type.attrs.class}`).sort();

const DOCUMENT_START = [
  `${FENCE}libera-macro`, "\\fset = $\\mathcal{F}$", FENCE, "",
  "# Title", "", "## 1. Intro", "", "**Lead in.** Some text with \\fset and a counter \\counter-lemma.", "",
  "plain paragraph", "", "## 2. Next", "", "- **item** text", "- other", "",
].join("\n");

test("bold lead-ins updated from the edit equal the whole-document computation after random edits", () => {
  let applied = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const editor = mount(DOCUMENT_START);
    const next = random(seed);
    try {
      for (let step = 0; step < 150; step++) {
        if (randomEdit(editor, next)) applied++;
        const actual = describe(leadInKey.getState(editor.state)!);
        const expected = describe(leadInDecorations(editor.state.doc));
        // A mismatch reports only the first difference; a large diff of the lists would exhaust memory.
        const differs = actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index]);
        assert.ok(!differs, `seed ${seed} step ${step}: ${actual.filter((entry) => !expected.includes(entry)).slice(0, 3)} extra, ${expected.filter((entry) => !actual.includes(entry)).slice(0, 3)} missing`);
      }
    } finally {
      editor.destroy();
    }
  }
  assert.ok(applied > 500, `edits applied: ${applied}`);
});

test("an edit in one paragraph does not scan every paragraph for lead-ins", () => {
  const paragraphs = Array.from({ length: 300 }, (_, index) => `**Lead ${index}.** body ${index}`).join("\n\n");
  const editor = mount(paragraphs);
  const proto = ProseMirrorNode.prototype;
  const original = proto.child;
  let visited = 0;
  proto.child = function (this: ProseMirrorNode, index: number) {
    if (this.type.name === "paragraph") visited++;
    return original.call(this, index);
  };
  try {
    const middle = editor.state.doc.child(150);
    let pos = 0;
    editor.state.doc.forEach((child, offset) => { if (child === middle) pos = offset; });
    editor.view.dispatch(editor.state.tr.insertText("x", pos + 3));
    assert.ok(visited > 0 && visited < 50, `paragraph children visited: ${visited}`);
    visited = 0;
    leadInDecorations(editor.state.doc);
    assert.ok(visited >= 300, `whole-document computation visits: ${visited}`);
  } finally {
    proto.child = original;
    editor.destroy();
  }
});

/** The old scan: every macro block and whether the whole text holds a counter. */
function referenceScan(doc: ProseMirrorNode) {
  const blocks: string[] = [];
  doc.descendants((node) => {
    if (node.type.spec.code && isMacroBlockLanguage(node.attrs.language)) blocks.push(node.textContent);
    return !node.isTextblock;
  });
  const counter = doc.textBetween(0, doc.content.size, "\n", (leaf) => String(leaf.attrs.latex ?? "")).includes("\\counter-");
  return { blocks, counter };
}

const content = (state: ReturnType<typeof computeMacroState>) => ({
  blocks: state.blocks, invocations: state.invocations, math: [...state.math], macros: [...state.definitions.macros.keys()],
});

test("macro state after random edits equals a computation on a fresh copy of the document", () => {
  let changes = 0;
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    const editor = mount(DOCUMENT_START);
    const next = random(seed);
    try {
      for (let step = 0; step < 150; step++) {
        const before = tiptapMacrosKey.getState(editor.state)!;
        if (randomEdit(editor, next)) changes++;
        const state = tiptapMacrosKey.getState(editor.state)!;
        // A copy has new node objects, so none of its blocks are cached.
        const fresh = computeMacroState(ProseMirrorNode.fromJSON(editor.schema, editor.state.doc.toJSON()));
        assert.deepEqual(content(state), content(fresh), `seed ${seed} step ${step}`);
        const reference = referenceScan(editor.state.doc);
        assert.deepEqual(state.blocks, reference.blocks);
        if (!reference.blocks.length && !reference.counter) assert.deepEqual(content(state), content(computeMacroState(editor.schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph" }] }))));
        // The previous object is reused exactly when nothing it holds changed.
        if (state !== before && state.blocks.length + before.blocks.length) assert.notDeepEqual(content(state), content(before), `seed ${seed} step ${step}: replaced without change`);
      }
    } finally {
      editor.destroy();
    }
  }
  assert.ok(changes > 500);
});

test("a document with no macros or counters is not searched block by block after an edit in one paragraph", () => {
  const editor = mount(Array.from({ length: 300 }, (_, index) => `paragraph ${index} with $x_${index}$`).join("\n\n"));
  const proto = ProseMirrorNode.prototype;
  const original = proto.textBetween;
  let characters = 0;
  proto.textBetween = function (this: ProseMirrorNode, ...args: Parameters<ProseMirrorNode["textBetween"]>) {
    characters += args[1] - args[0];
    return original.apply(this, args);
  };
  try {
    const size = editor.state.doc.content.size;
    editor.view.dispatch(editor.state.tr.insertText("x", Math.floor(size / 2)));
    assert.ok(characters > 0 && characters < size / 20, `characters searched: ${characters} of ${size}`);
    assert.equal(tiptapMacrosKey.getState(editor.state)!.invocations.length, 0);
  } finally {
    proto.textBetween = original;
    editor.destroy();
  }
});

test("selection moves between other places keep the macro decorations, and the caret in a macro still shows its source", () => {
  const editor = mount(`${DOCUMENT_START}\nOne more \\fset here.\n`);
  try {
    assert.ok(tiptapMacrosKey.getState(editor.state)!.invocations.length >= 2);
    const caret = (at: number) => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)));
    caret(2);
    const before = [...editor.view.dom.querySelectorAll(".libera-macro-expansion")];
    assert.ok(before.length >= 2);
    caret(3);
    const after = [...editor.view.dom.querySelectorAll(".libera-macro-expansion")];
    // The same elements: the decoration set was reused, not rebuilt.
    assert.equal(after.length, before.length);
    assert.ok(after.every((element, index) => element === before[index]));
    const invocation = tiptapMacrosKey.getState(editor.state)!.invocations[0];
    caret(invocation.from + 1);
    assert.ok(editor.view.dom.querySelector(".libera-macro-source"));
  } finally {
    editor.destroy();
  }
});

function numberedEditor() {
  const editor = mount("# Title\n\n## 1. Intro\n\ntext\n\n## 2. Next\n\n### 2.1 Sub\n\nmore text\n");
  setTiptapHeadingNumbering(editor, { enabled: true, skipTitle: true }, true);
  return editor;
}

/** The numbering plugin as it was: the whole pass after every local edit. */
const referenceKey = new PluginKey("referenceNumbering");
function everyEditNumbering(settings: { enabled: boolean; skipTitle: boolean }) {
  return Extension.create({
    name: "liberaHeadingNumberingReference",
    addProseMirrorPlugins: () => [new Plugin({
      key: referenceKey,
      appendTransaction(transactions, oldState, newState) {
        if (!transactions.some((tr) => tr.docChanged) || transactions.some((tr) => tr.getMeta(referenceKey))) return null;
        const shrunk = newState.doc.content.size < oldState.doc.content.size;
        const tr = applyTiptapStructuralNumbers(newState.tr, settings, shrunk && newState.selection.empty ? newState.selection.from : undefined);
        return tr.docChanged ? tr.setMeta(referenceKey, true) : null;
      },
    })],
  });
}

test("heading numbering after random local edits equals the pass that ran after every edit", () => {
  const settings = { enabled: true, skipTitle: true };
  const initial = "# Title\n\n## 1. Intro\n\ntext\n\n## 2. Next\n\n### 2.1 Sub\n\nmore text\n";
  let edits = 0;
  for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
    const editor = numberedEditor();
    const reference = new Editor({
      element: document.createElement("div"),
      extensions: [...createMarkdownExtensions("Notes/a.md"), ...createMathExtensions(), everyEditNumbering(settings)],
      content: initial, contentType: "markdown",
    });
    reference.view.dispatch(applyTiptapStructuralNumbers(reference.state.tr, settings));
    const next = random(seed);
    try {
      assert.deepEqual(editor.state.doc.toJSON(), reference.state.doc.toJSON());
      for (let step = 0; step < 200; step++) {
        const tr = buildEdit(editor, next);
        if (!tr) continue;
        edits++;
        const twin = reference.state.tr;
        // The reference editor has its own schema, so the steps cross as JSON.
        for (const edit of tr.steps) twin.step(Step.fromJSON(reference.schema, edit.toJSON()));
        if (tr.selectionSet) twin.setSelection(TextSelection.create(twin.doc, tr.selection.from, tr.selection.to));
        reference.view.dispatch(twin);
        editor.view.dispatch(tr);
        assert.deepEqual(editor.state.doc.toJSON(), reference.state.doc.toJSON(), `seed ${seed} step ${step}`);
      }
    } finally {
      editor.destroy();
      reference.destroy();
    }
  }
  assert.ok(edits > 800);
});

test("the numbering pass is skipped for an edit away from headings and run for one that touches them", () => {
  const editor = mount("# Title\n\n## 1. A\n\n" + Array.from({ length: 200 }, (_, index) => `paragraph ${index}`).join("\n\n") + "\n\n## 2. B\n");
  setTiptapHeadingNumbering(editor, { enabled: true, skipTitle: true }, true);
  const proto = ProseMirrorNode.prototype;
  const original = proto.descendants;
  let passes = 0;
  proto.descendants = function (this: ProseMirrorNode, ...args: Parameters<ProseMirrorNode["descendants"]>) {
    if (this.type.name === "doc") passes++;
    return original.apply(this, args);
  };
  try {
    // The first edit after a numbering change verifies the document.
    editor.view.dispatch(editor.state.tr.insertText("x", 12));
    let middle = 0;
    editor.state.doc.forEach((child, offset) => { if (child.textContent === "paragraph 100") middle = offset; });
    passes = 0;
    editor.view.dispatch(editor.state.tr.insertText("y", middle + 2));
    editor.view.dispatch(editor.state.tr.insertText("z", middle + 3));
    assert.equal(passes, 0, "paragraph typing collected headings");
    // Typing in a heading still renumbers: a new heading between two takes number 2 and the next moves on.
    const end = editor.state.doc.content.size;
    editor.view.dispatch(editor.state.tr.insert(end - 0, editor.schema.nodes.heading.create({ level: 2 }, editor.schema.text("C"))));
    assert.ok(passes > 0);
    assert.match(editor.getMarkdown(), /## 3\. C/);
    // Undo returns to the unnumbered text and a later edit renumbers it.
  } finally {
    proto.descendants = original;
    editor.destroy();
  }
});

test("a heading level change and a split of a heading renumber", () => {
  const editor = numberedEditor();
  try {
    const intro = editor.state.doc.child(1);
    assert.equal(intro.type.name, "heading");
    editor.chain().setTextSelection(editor.state.doc.child(0).nodeSize + 3).setNode("heading", { level: 3 }).run();
    assert.equal(applyTiptapStructuralNumbers(editor.state.tr, { skipTitle: true }).docChanged, false);
    const heading = editor.state.doc.child(1);
    assert.equal(heading.attrs.level, 3);
    editor.view.dispatch(editor.state.tr.split(editor.state.doc.child(0).nodeSize + 3));
    assert.equal(applyTiptapStructuralNumbers(editor.state.tr, { skipTitle: true }).docChanged, false);
  } finally {
    editor.destroy();
  }
});
