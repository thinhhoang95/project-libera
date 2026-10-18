import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { YSyncConfig } from "y-codemirror.next";
import { applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { undoDepth } from "@tiptap/pm/history";
import { Fragment, Slice } from "@tiptap/pm/model";
import { editorMarkdownCodec, sourceBlocks } from "../../src/lib/collab/bindings/tiptap-blocks";
import { reviewBlocks } from "../../src/lib/markdown-review";
import { bindTiptapToYText, provenanceOfOrigin } from "../../src/lib/collab/bindings/tiptap-ytext";
import { Editor } from "@tiptap/core";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { relativePositionToSourceOffset } from "../../src/lib/collab/bindings/tiptap-cursors";
import type { Provenance } from "../../src/lib/collab/protocol/actor";
import { assertConverged, createEditor, dom, posOf, select, serializedMarkdown, settle, setupTrio, type } from "./tiptap-bridge-harness.test";

/** Tiptap's own serialization of `source`, so fixtures start canonical. */
function canonical(source: string) {
  const editor = createEditor(source);
  try { return serializedMarkdown(editor); } finally { editor.destroy(); }
}

test("concurrent typing in one paragraph by two Visual editors and a Source user converges", () => {
  const trio = setupTrio("# Title\n\nThe quick brown fox jumps.\n\nAfter.");
  const { a, b, c, network } = trio;
  try {
    select(a.editor, posOf(a.editor, "quick", 5));
    type(a.editor, " red");
    select(b.editor, posOf(b.editor, "fox", 3));
    type(b.editor, "es");
    c.ytext.insert(c.ytext.toString().indexOf("jumps") + 5, " high");
    a.bridge.flush();
    b.bridge.flush();
    settle(network, a, b);
    const text = assertConverged(trio, { canonical: true });
    assert.equal(text, "# Title\n\nThe quick red brown foxes jumps high.\n\nAfter.");
    assert.equal(a.editor.state.doc.child(1).textContent, "The quick red brown foxes jumps high.");
  } finally { trio.destroy(); }
});

test("concurrent typing in a list, a heading and a table cell converges", () => {
  const source = canonical("## Heading here\n\n- one\n- two\n  - nested\n- three\n\n| A | B |\n| - | - |\n| x | y |");
  const trio = setupTrio(source);
  const { a, b, c, network } = trio;
  try {
    // Heading: both editors type at different ends.
    select(a.editor, posOf(a.editor, "Heading", 0));
    type(a.editor, "My ");
    select(b.editor, posOf(b.editor, "here", 4));
    type(b.editor, " now");
    // List: same item from A and C, nested item from B.
    select(a.editor, posOf(a.editor, "two", 3));
    type(a.editor, "-A");
    select(b.editor, posOf(b.editor, "nested", 6));
    type(b.editor, " deep");
    c.ytext.insert(c.ytext.toString().indexOf("two"), "C:");
    // Table: A types in cell x, B in cell y, C in the header.
    select(a.editor, posOf(a.editor, "x", 1));
    type(a.editor, "x");
    select(b.editor, posOf(b.editor, "y", 1));
    type(b.editor, "yy");
    c.ytext.insert(c.ytext.toString().indexOf("A   |") + 1, "1");
    settle(network, a, b);
    const text = assertConverged(trio);
    assert.match(text, /^## My Heading here now\n\n/);
    assert.match(text, /- C:two-A\n/);
    assert.match(text, /nested deep/);
    for (const participant of [a, b]) {
      const json = JSON.stringify(participant.editor.getJSON());
      for (const expected of ["xx", "yyy", "A1"]) assert.ok(json.includes(`"${expected}"`), `${expected} missing`);
    }
  } finally { trio.destroy(); }
});

test("pasting several blocks into a paragraph sends them with paste provenance", () => {
  const trio = setupTrio("Alpha beta.\n\nOmega.");
  const { a, b, network } = trio;
  const provenances: (Provenance | undefined)[] = [];
  a.doc.on("update", (_update: Uint8Array, origin: unknown) => provenances.push(provenanceOfOrigin(origin)));
  try {
    select(a.editor, posOf(a.editor, "Alpha", 5));
    type(a.editor, " typed");
    const pasted = editorMarkdownCodec(a.editor).parse("Pasted one.\n\n- item 1\n- item 2\n\n## Pasted heading");
    // A slice open on both sides splits the paragraph like a real paste does.
    const slice = new Slice(Fragment.fromArray(pasted), 1, 1);
    a.editor.view.dispatch(a.editor.state.tr.replaceSelection(slice).setMeta("paste", true).setMeta("uiEvent", "paste"));
    a.bridge.flush();
    settle(network, a, b);
    const text = assertConverged(trio, { canonical: true });
    assert.equal(text, "Alpha typedPasted one.\n\n- item 1\n- item 2\n\n## Pasted heading beta.\n\nOmega.");
    assert.deepEqual(provenances.map((p) => p?.source), ["typing", "paste"]);
  } finally { trio.destroy(); }
});

test("deleting across blocks while others edit inside them converges", () => {
  const trio = setupTrio("First para.\n\nSecond para.\n\n- list a\n- list b\n\nThird para.\n\nFourth para.");
  const { a, b, c, network } = trio;
  try {
    const from = posOf(a.editor, "First", 5), to = posOf(a.editor, "Third", 5);
    a.editor.view.dispatch(a.editor.state.tr.delete(from, to));
    select(b.editor, posOf(b.editor, "Second", 6));
    type(b.editor, " (B)");
    c.ytext.insert(c.ytext.toString().indexOf("Fourth") + 6, " (C)");
    settle(network, a, b);
    const text = assertConverged(trio);
    assert.ok(text.startsWith("First"), text);
    assert.ok(text.includes("Fourth (C) para."), text);
    assert.ok(!text.includes("list a"), text);
  } finally { trio.destroy(); }
});

test("splitting, merging, inserting and deleting blocks round-trips", () => {
  const trio = setupTrio("Onetwo.\n\nThree four.\n\nFive.");
  const { a, b, network } = trio;
  try {
    select(a.editor, posOf(a.editor, "two", 0));
    a.editor.commands.splitBlock();
    settle(network, a, b);
    assert.equal(assertConverged(trio, { canonical: true }), "One\n\ntwo.\n\nThree four.\n\nFive.");
    // Two Enters at the end of a paragraph: an empty paragraph, stored as blank lines.
    select(a.editor, posOf(a.editor, "four.", 5));
    a.editor.commands.splitBlock();
    a.editor.commands.splitBlock();
    settle(network, a, b);
    assert.equal(b.editor.state.doc.childCount, a.editor.state.doc.childCount);
    assertConverged(trio, { canonical: true });
    // Merge "Five." into the previous (empty) paragraph and then into "Three four.".
    select(b.editor, posOf(b.editor, "Five", 0));
    b.editor.commands.joinBackward();
    b.editor.commands.joinBackward();
    b.editor.commands.joinBackward();
    settle(network, a, b);
    const text = assertConverged(trio, { canonical: true });
    assert.ok(text.endsWith("Three four.Five."), JSON.stringify(text));
    // Delete a whole block.
    const second = a.editor.state.doc.child(0).nodeSize;
    a.editor.view.dispatch(a.editor.state.tr.delete(second, second + a.editor.state.doc.child(1).nodeSize));
    settle(network, a, b);
    assert.equal(assertConverged(trio, { canonical: true }), "One\n\nThree four.Five.");
  } finally { trio.destroy(); }
});

test("editing one block leaves non-canonical Markdown elsewhere byte-identical", () => {
  const source = [
    "Some *em* and _em_ and __strong__ text.",
    "+ plus list\n+ second",
    "* star list",
    "Odd   spacing,  kept.  ",
    "Target paragraph.",
    "Setext heading\n==============",
    "1) paren list",
    "| a |  b |\n|---|:-:|\n| 1 | 2 |",
  ].join("\n\n\n");
  const trio = setupTrio(source);
  const { a, b, c, network } = trio;
  try {
    assert.equal(a.ytext.toString(), source, "binding must not rewrite the source");
    select(a.editor, posOf(a.editor, "Target", 6));
    type(a.editor, " edited");
    settle(network, a, b);
    const expected = source.replace("Target paragraph.", "Target edited paragraph.");
    assert.equal(c.ytext.toString(), expected);
    assertConverged(trio);
    // B edits another block: only that block is normalized.
    select(b.editor, posOf(b.editor, "paren", 0));
    type(b.editor, "a ");
    settle(network, a, b);
    assert.equal(c.ytext.toString(), expected.replace("1) paren list", "1. a paren list"));
    assertConverged(trio);
  } finally { trio.destroy(); }
});

test("a remote edit in the same block or another block keeps the local caret on its text", () => {
  const trio = setupTrio("Intro text.\n\nHello world, again.\n\nOutro.");
  const { a, c, network } = trio;
  try {
    select(a.editor, posOf(a.editor, "world", 0));
    c.ytext.insert(c.ytext.toString().indexOf("Hello"), "Big ");
    network.deliver();
    const after = () => a.editor.state.doc.textBetween(a.editor.state.selection.head, a.editor.state.selection.head + 5);
    assert.equal(after(), "world");
    // Remote edit before the caret's block and after it.
    c.ytext.insert(0, "New first paragraph.\n\n");
    c.ytext.insert(c.ytext.length, "\n\nTail.");
    network.deliver();
    assert.equal(after(), "world");
    // Remote typing right after the caret in the same block.
    c.ytext.insert(c.ytext.toString().indexOf("world"), "wide ");
    network.deliver();
    assert.equal(a.editor.state.doc.textBetween(a.editor.state.selection.head, a.editor.state.selection.head + 5), "wide ");
    // A range selection inside formatted text survives a remote edit.
    c.ytext.insert(c.ytext.toString().indexOf("again"), "**bold** ");
    network.deliver();
    select(a.editor, posOf(a.editor, "again", 0), posOf(a.editor, "again", 5));
    c.ytext.insert(c.ytext.toString().indexOf("**bold**"), "x");
    network.deliver();
    const { from, to } = a.editor.state.selection;
    assert.equal(a.editor.state.doc.textBetween(from, to), "again");
    // Local typing interleaved with remote edits stays contiguous.
    select(a.editor, posOf(a.editor, "Outro", 5));
    for (const char of "ABCDE") {
      type(a.editor, char);
      a.bridge.flush();
      c.ytext.insert(0, "-");
      network.deliver();
    }
    assert.ok(c.ytext.toString().includes("OutroABCDE."), c.ytext.toString());
    assertConverged(trio);
  } finally { trio.destroy(); }
});

test("IME composition holds outgoing and incoming changes until it ends", async () => {
  const trio = setupTrio("Xin chào.\n\nOther.");
  const { a, c, network } = trio;
  const input = (a.editor.view as unknown as { input: { composing: boolean } }).input;
  try {
    select(a.editor, posOf(a.editor, "chào", 4));
    input.composing = true;
    type(a.editor, " Việt");
    a.bridge.flush();
    network.deliver();
    assert.equal(c.ytext.toString(), "Xin chào.\n\nOther.", "outgoing change must wait for the composition");
    c.ytext.insert(c.ytext.toString().indexOf("Other"), "The ");
    c.ytext.insert(0, ">> ");
    network.deliver();
    assert.equal(a.editor.state.doc.textContent, "Xin chào Việt.Other.", "incoming change must wait for the composition");
    assert.equal(a.bridge.isSynced(), false);
    input.composing = false;
    a.editor.view.dom.dispatchEvent(new dom.window.CompositionEvent("compositionend", { data: "Việt" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    network.deliver();
    const text = assertConverged(trio);
    assert.equal(text, ">> Xin chào Việt.\n\nThe Other.");
    assert.equal(a.editor.state.doc.textBetween(a.editor.state.selection.head - 4, a.editor.state.selection.head), "Việt");
  } finally { trio.destroy(); }
});

test("undo reverts only the local user's changes, through the command and Mod-z", () => {
  const trio = setupTrio("Mine here.\n\nTheirs here.");
  const { a, c, network } = trio;
  try {
    select(a.editor, posOf(a.editor, "Mine", 4));
    type(a.editor, " own");
    a.bridge.flush();
    network.deliver();
    c.ytext.insert(c.ytext.toString().indexOf("Theirs") + 6, " remote");
    network.deliver();
    assert.equal(undoDepth(a.editor.state), 0, "ProseMirror history stays empty while bound");
    assert.equal(a.editor.commands.undo(), true);
    network.deliver();
    assert.equal(c.ytext.toString(), "Mine here.\n\nTheirs remote here.");
    a.editor.commands.redo();
    network.deliver();
    assert.equal(c.ytext.toString(), "Mine own here.\n\nTheirs remote here.");
    // Keyboard: Ctrl+Z (Mod on non-Mac) goes to the UndoManager too.
    a.editor.view.dom.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    network.deliver();
    assert.equal(c.ytext.toString(), "Mine here.\n\nTheirs remote here.");
    // The caret returns to where the undone change was.
    const head = a.editor.state.selection.head;
    assert.ok(head <= a.editor.state.doc.child(0).nodeSize && /Mine ?$/.test(a.editor.state.doc.textBetween(1, head)), `caret at ${head}`);
    a.editor.view.dom.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true }));
    network.deliver();
    assert.equal(c.ytext.toString(), "Mine own here.\n\nTheirs remote here.");
    assertConverged(trio);
  } finally { trio.destroy(); }
});

test("AI changes carry their provenance and undo as one step", () => {
  const trio = setupTrio("Draft sentence.\n\nKeep.");
  const { a, c, network } = trio;
  const provenances: (Provenance | undefined)[] = [];
  a.doc.on("update", (_update: Uint8Array, origin: unknown) => provenances.push(provenanceOfOrigin(origin)));
  try {
    select(a.editor, posOf(a.editor, "Draft", 5));
    type(a.editor, "ed");
    a.bridge.captureTransaction(() => {
      const from = posOf(a.editor, "Drafted", 0);
      a.editor.view.dispatch(a.editor.state.tr.insertText("Rewritten by AI.", from, from + "Drafted sentence.".length));
      a.editor.view.dispatch(a.editor.state.tr.insertText(" More.", a.editor.state.doc.child(0).nodeSize - 1));
    }, { source: "ai", feature: "rewrite" });
    network.deliver();
    assert.equal(c.ytext.toString(), "Rewritten by AI. More.\n\nKeep.");
    assert.deepEqual(provenances.map((p) => p && `${p.source}${p.feature ? `:${p.feature}` : ""}`), ["typing", "ai:rewrite"]);
    a.bridge.setNextProvenance({ source: "ai", feature: "format" });
    select(a.editor, posOf(a.editor, "Keep", 4));
    type(a.editor, "!");
    a.bridge.flush();
    assert.equal(provenances.at(-1)?.feature, "format");
    type(a.editor, "?");
    a.bridge.flush();
    assert.equal(provenances.at(-1)?.source, "typing");
    a.bridge.undo();
    a.bridge.undo();
    network.deliver();
    assert.equal(c.ytext.toString(), "Rewritten by AI. More.\n\nKeep.", "typing and the format step undo separately");
    a.bridge.undo();
    network.deliver();
    assert.equal(c.ytext.toString(), "Drafted sentence.\n\nKeep.", "the AI rewrite is one undo step");
    assert.equal(provenances.at(-1)?.source, "undo");
  } finally { trio.destroy(); }
});

test("cursor positions round-trip and the awareness format matches y-codemirror.next", async () => {
  const source = "# Head\n\nPlain text and **bold *mixed*** with `code` and [a link](https://example.com).\n\n- item one\n- item two";
  const trio = setupTrio(source);
  const { a, c } = trio;
  try {
    const editor = a.editor;
    // Every position in plain text maps to a source offset and back.
    const plain = posOf(editor, "Plain", 0);
    for (let pos = plain; pos <= plain + "Plain text and ".length; pos++) {
      const offset = a.bridge.posToSourceOffset(pos);
      assert.equal(source.slice(offset, offset + 1), editor.state.doc.textBetween(pos, pos + 1) || source[offset], `pos ${pos}`);
      assert.equal(a.bridge.sourceOffsetToPos(offset), pos);
    }
    // Inside formatting the mapping is approximate but lands on the same character.
    for (const word of ["mixed", "code", "link", "two"]) {
      const pos = posOf(editor, word, 1);
      const offset = a.bridge.posToSourceOffset(pos);
      assert.equal(source.slice(offset - 1, offset - 1 + word.length), word, word);
      assert.equal(a.bridge.sourceOffsetToPos(offset), pos, word);
      const relative = a.bridge.posToRelativePosition(pos);
      assert.equal(a.bridge.relativePositionToPos(Y.relativePositionToJSON(relative)), pos);
    }
    // Publishing: same shape as y-codemirror.next (RelativePosition from type index, assoc 0).
    select(editor, posOf(editor, "bold", 0), posOf(editor, "bold", 4));
    const cursor = a.awareness.getLocalState()!.cursor;
    const anchor = source.indexOf("bold"), head = anchor + 4;
    const reference = { anchor: Y.createRelativePositionFromTypeIndex(a.ytext, anchor), head: Y.createRelativePositionFromTypeIndex(a.ytext, head) };
    assert.equal(JSON.stringify(cursor), JSON.stringify(reference));
    // A CodeMirror peer decodes it with y-codemirror.next's own helper.
    const codemirrorAwareness = new (await import("y-protocols/awareness")).Awareness(c.doc);
    applyAwarenessUpdate(codemirrorAwareness, encodeAwarenessUpdate(a.awareness, [a.awareness.clientID]), "test");
    const received = codemirrorAwareness.getStates().get(a.awareness.clientID)!.cursor;
    const config = new YSyncConfig(c.ytext, codemirrorAwareness);
    assert.equal(config.fromYPos(received.anchor).pos, anchor);
    assert.equal(config.fromYPos(received.head).pos, head);
    // And the CodeMirror user's cursor renders in the Visual editor.
    codemirrorAwareness.setLocalStateField("user", { name: "Cody", color: "#ff0000" });
    codemirrorAwareness.setLocalStateField("cursor", { anchor: config.toYPos(source.indexOf("item two") + 5), head: config.toYPos(source.indexOf("item two") + 5) });
    applyAwarenessUpdate(a.awareness, encodeAwarenessUpdate(codemirrorAwareness, [codemirrorAwareness.clientID]), "test");
    const caret = editor.view.dom.querySelector(".libera-collab-caret");
    assert.ok(caret, "remote caret rendered");
    assert.equal(caret!.textContent?.replace(/⁠/g, ""), "Cody");
    assert.equal(caret!.parentElement?.textContent?.replace(/⁠|Cody/g, ""), "item two");
    assert.equal(relativePositionToSourceOffset(a.ytext, received.anchor), anchor);
    codemirrorAwareness.destroy();
  } finally { trio.destroy(); }
});

test("the D1 fallback makes the Visual editor a live read-only view", () => {
  const changes: (string | null)[] = [];
  const trio = setupTrio("Shared.", { onReadOnlyChange: (reason) => changes.push(reason) });
  const { a, c, network } = trio;
  try {
    a.bridge.setReadOnly("Tables in this note cannot be edited in Visual mode yet.");
    assert.equal(a.editor.isEditable, false);
    c.ytext.insert(6, " live");
    network.deliver();
    assert.equal(a.editor.state.doc.textContent, "Shared live.");
    a.bridge.setReadOnly(null);
    assert.equal(a.editor.isEditable, true);
    assert.deepEqual(changes, ["Tables in this note cannot be edited in Visual mode yet.", null]);
  } finally { trio.destroy(); }
});

test("remote structural edits from a Source user re-tile only what they touch", () => {
  const trio = setupTrio("Para one.\n\nPara two.\n\nPara three.");
  const { a, b, c, network } = trio;
  try {
    const keep = a.editor.state.doc.child(2);
    // Turn the first paragraph into a list that then merges with a new list item.
    c.ytext.insert(0, "- ");
    c.ytext.insert(c.ytext.toString().indexOf("Para two"), "- ");
    network.deliver();
    assert.equal(a.editor.state.doc.child(0).type.name, "bulletList");
    assert.equal(a.editor.state.doc.child(0).childCount, 2);
    assert.equal(a.editor.state.doc.child(1), keep, "untouched node keeps its identity");
    // An unclosed fence swallows the rest of the note, then closing it restores the blocks.
    c.ytext.insert(0, "```\n");
    network.deliver();
    assert.equal(a.editor.state.doc.childCount, 1);
    assert.equal(a.editor.state.doc.child(0).type.name, "codeBlock");
    c.ytext.delete(0, 4);
    network.deliver();
    assert.equal(a.editor.state.doc.child(0).type.name, "bulletList");
    // Remote deletion of the blank line merges two paragraphs.
    const at = c.ytext.toString().indexOf("\n\nPara three");
    c.ytext.delete(at, 1);
    network.deliver();
    settle(network, a, b);
    assertConverged(trio);
    assert.equal(a.editor.state.doc.childCount, 1);
  } finally { trio.destroy(); }
});

test("chunked tiling of long notes matches a whole-document remark parse", () => {
  // Constructs that continue across blank lines, placed so some straddle chunk seams.
  const pieces = [
    "Paragraph with text.",
    "```\ncode\n\nAfter a blank line inside a fence\n```",
    "<!--\ncomment\n\nstill comment\n-->",
    "$$\nx\n\ny\n$$",
    "- item\n\n  continued item paragraph\n\n- next",
    "> quote\n>\n> more",
    "    indented code\n\n    more code",
    "Heading\n=======",
    "| a | b |\n| - | - |\n| 1 | 2 |",
  ];
  const parts: string[] = [];
  for (let index = 0; parts.join("\n\n").length < 150_000; index++) parts.push(pieces[index % pieces.length].replace("text", `text ${index}`));
  // An unclosed fence near the end swallows the rest of the note.
  for (const source of [parts.join("\n\n"), `${parts.join("\n\n")}\n\n\`\`\`\nunclosed\n\n${parts.slice(0, 40).join("\n\n")}`]) {
    const whole = reviewBlocks(source).map((block) => [block.start, block.end, block.type]);
    assert.deepEqual(sourceBlocks(source).map((block) => [block.start, block.end, block.type]), whole);
  }
});

test("without the history extension the bridge registers its own undo keymap and removes it on destroy", () => {
  const doc = new Y.Doc();
  const ytext = doc.getText("source");
  ytext.insert(0, "Plain note.");
  const editor = new Editor({ extensions: createMarkdownExtensions("Notes/plain.md"), content: ytext.toString(), contentType: "markdown" });
  const bridge = bindTiptapToYText({ editor, ytext, flushDelay: 1_000_000 });
  try {
    const pluginKeys = () => editor.state.plugins.map((plugin) => (plugin as unknown as { key: string }).key);
    assert.ok(pluginKeys().some((key) => key.startsWith("liberaCollabHistoryKeymap$")));
    select(editor, posOf(editor, "Plain", 5));
    type(editor, " old");
    bridge.flush();
    assert.equal(ytext.toString(), "Plain old note.");
    editor.view.dom.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    assert.equal(ytext.toString(), "Plain note.");
    assert.equal(editor.state.doc.textContent, "Plain note.");
    bridge.destroy();
    assert.ok(!pluginKeys().some((key) => key.startsWith("liberaCollabHistory")), "plugins removed");
    // Unbound, Tiptap's own history works again.
    type(editor, "!");
    editor.commands.undo();
    assert.equal(editor.state.doc.textContent, "Plain note.");
  } finally { bridge.destroy(); editor.destroy(); }
});

test("spaces typed at a paragraph's edges are sent once, never duplicated", () => {
  const trio = setupTrio("First.\n\nword\n\nLast.");
  const { a, b, c, network } = trio;
  try {
    select(a.editor, posOf(a.editor, "word", 4));
    for (const char of "  x") { type(a.editor, char); a.bridge.flush(); network.deliver(); }
    assert.equal(c.ytext.toString(), "First.\n\nword  x\n\nLast.");
    select(a.editor, posOf(a.editor, "word", 0));
    for (let index = 0; index < 3; index++) { type(a.editor, " "); a.bridge.flush(); network.deliver(); }
    assert.equal(c.ytext.toString(), "First.\n\n   word  x\n\nLast.");
    // Another editor appends at the end of the same paragraph.
    select(b.editor, posOf(b.editor, "x", 1));
    type(b.editor, "y ");
    settle(network, a, b);
    assert.equal(c.ytext.toString(), "First.\n\n   word  xy \n\nLast.");
    assertConverged(trio);
  } finally { trio.destroy(); }
});
