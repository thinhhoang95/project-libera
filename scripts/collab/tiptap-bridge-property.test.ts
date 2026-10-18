import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Selection, TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { editorMarkdownCodec } from "../../src/lib/collab/bindings/tiptap-blocks";
import { applyTextOps, diffText, rebaseOps } from "../../src/lib/collab/bindings/tiptap-text-diff";
import { assertConverged, settle, setupTrio } from "./tiptap-bridge-harness.test";

const FIXTURE = "# Title\n\nAlpha beta.\n\n- one\n- two\n\nGamma *delta*.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nEnd.";

type Action =
  | { who: 0 | 1; kind: "type"; at: number; text: string }
  | { who: 0 | 1; kind: "delete"; at: number; length: number }
  | { who: 0 | 1; kind: "split" | "join"; at: number }
  | { who: 0 | 1; kind: "bold"; at: number; length: number }
  | { who: 0 | 1; kind: "flush" | "undo" | "redo" }
  | { who: 0 | 1; kind: "paste"; at: number; markdown: string }
  | { who: 2; kind: "insert"; at: number; text: string }
  | { who: 2; kind: "remove"; at: number; length: number }
  | { who: 3; kind: "deliver"; pick: number };

const editorText = fc.constantFrom("x", "yz", " ", "*", "#", "1.");
const sourceText = fc.constantFrom("a", "bc ", " ", "\n", "\n\n", "- ", "# ", "*", "`", "|", "> ", "1. ", "**q**", "_");
const unit = fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true });
const who = fc.constantFrom(0 as const, 1 as const);

const action: fc.Arbitrary<Action> = fc.oneof(
  fc.record({ who, kind: fc.constant("type" as const), at: unit, text: editorText }),
  fc.record({ who, kind: fc.constant("delete" as const), at: unit, length: fc.integer({ min: 1, max: 6 }) }),
  fc.record({ who, kind: fc.constantFrom("split" as const, "join" as const), at: unit }),
  fc.record({ who, kind: fc.constant("bold" as const), at: unit, length: fc.integer({ min: 1, max: 4 }) }),
  fc.record({ who, kind: fc.constantFrom("flush" as const, "undo" as const, "redo" as const) }),
  fc.record({ who, kind: fc.constant("paste" as const), at: unit, markdown: fc.constantFrom("P1.\n\nP2.", "- i\n- j", "## H\n\ntext", "x **y**") }),
  fc.record({ who: fc.constant(2 as const), kind: fc.constant("insert" as const), at: unit, text: sourceText }),
  fc.record({ who: fc.constant(2 as const), kind: fc.constant("remove" as const), at: unit, length: fc.integer({ min: 1, max: 5 }) }),
  fc.record({ who: fc.constant(3 as const), kind: fc.constant("deliver" as const), pick: unit }),
);

function textPosition(editor: Editor, at: number) {
  const doc = editor.state.doc;
  return Selection.near(doc.resolve(Math.floor(at * (doc.content.size + 1)))).from;
}

function runEditorAction(editor: Editor, step: Exclude<Action, { who: 2 | 3 }>) {
  if (!("at" in step)) return;
  const pos = textPosition(editor, step.at);
  const { doc } = editor.state;
  editor.view.dispatch(editor.state.tr.setSelection(Selection.near(doc.resolve(pos))));
  switch (step.kind) {
    case "type":
      for (const char of step.text) editor.view.dispatch(editor.state.tr.insertText(char));
      break;
    case "delete": {
      const to = Math.min(doc.content.size, pos + step.length);
      if (to > pos) editor.view.dispatch(editor.state.tr.delete(pos, to));
      break;
    }
    case "split": editor.commands.splitBlock(); break;
    case "paste": {
      const nodes = editorMarkdownCodec(editor).parse(step.markdown);
      const slice = nodes.length > 1 ? new Slice(Fragment.fromArray(nodes), 1, 1) : new Slice(nodes[0].content, 0, 0);
      editor.view.dispatch(editor.state.tr.replaceSelection(slice).setMeta("paste", true));
      break;
    }
    case "join": editor.commands.joinBackward(); break;
    case "bold": {
      const to = Math.min(doc.content.size, pos + step.length);
      const selection = TextSelection.between(doc.resolve(pos), doc.resolve(to));
      editor.view.dispatch(editor.state.tr.setSelection(selection));
      editor.commands.toggleBold();
      break;
    }
  }
}

test("random interleavings of edits by two Visual editors and a Source user converge", () => {
  let runs = 0;
  fc.assert(fc.property(fc.array(action, { minLength: 1, maxLength: 24 }), fc.integer(), (actions, seed) => {
    runs++;
    let state = seed >>> 0;
    const random = () => ((state = (state * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const trio = setupTrio(FIXTURE, {}, [1, 2, 3].map(() => 1 + Math.floor(random() * 2 ** 30)));
    const { a, b, c, network } = trio;
    try {
      for (const step of actions) {
        if (step.who === 3) { if (step.pick < 0.5) network.deliver(random); else network.deliver(); continue; }
        if (step.who === 2) {
          const at = Math.floor(step.at * (c.ytext.length + 1));
          if (step.kind === "insert") c.ytext.insert(at, step.text);
          else c.ytext.delete(at, Math.min(step.length, c.ytext.length - at));
          continue;
        }
        const participant = step.who === 0 ? a : b;
        runEditorAction(participant.editor, step);
        if (step.kind === "flush") participant.bridge.flush();
        if (step.kind === "undo") participant.bridge.undo();
        if (step.kind === "redo") participant.bridge.redo();
      }
      settle(network, a, b);
      assertConverged(trio);
    } catch (error) {
      // BRIDGE_DEBUG=1 prints the failing state; fast-check only reports the actions.
      if (process.env.BRIDGE_DEBUG) console.error(String((error as Error).message), "\nY:", JSON.stringify(c.ytext.toString()), "\nA:", JSON.stringify(a.editor.getJSON()), "\nB:", JSON.stringify(b.editor.getJSON()));
      throw error;
    } finally { trio.destroy(); }
  }), { numRuns: Number(process.env.BRIDGE_RUNS ?? 60), seed: Number(process.env.BRIDGE_SEED ?? 20261018), endOnFailure: true, verbose: 1 });
  assert.equal(runs > 0, true);
});

test("character diffs round-trip and never split a surrogate pair", () => {
  const text = fc.string({ unit: fc.constantFrom("a", "b", " ", "\n", "😀", "ệ", "*"), maxLength: 40 });
  fc.assert(fc.property(text, text, (before, after) => {
    const ops = diffText(before, after);
    assert.equal(applyTextOps(before, ops), after);
    for (const op of ops) {
      for (const [source, at] of [[before, op.from], [before, op.to]] as const) {
        assert.ok(!(at > 0 && at < source.length && /[\ud800-\udbff]/.test(source[at - 1]) && /[\udc00-\udfff]/.test(source[at])), "split pair");
      }
      assert.ok(!/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(op.insert), "lone surrogate inserted");
    }
  }), { numRuns: 500 });
});

test("rebasing a local diff over a disjoint remote diff applies both", () => {
  const word = fc.string({ unit: fc.constantFrom("a", "b", "c", " "), minLength: 1, maxLength: 8 });
  fc.assert(fc.property(word, word, word, word, word, (left, middle, right, localPart, remotePart) => {
    // Local rewrites the left word, remote rewrites the right word.
    const base = `${left}|${middle}|${right}`;
    const ours = `${localPart}|${middle}|${right}`, theirs = `${left}|${middle}|${remotePart}`;
    const rebased = rebaseOps(diffText(base, ours), diffText(base, theirs));
    assert.equal(applyTextOps(theirs, rebased), `${localPart}|${middle}|${remotePart}`);
    // Remote text inserted inside a range the local side deleted survives.
    const deleted = rebaseOps([{ from: 0, to: base.length, insert: "" }], [{ from: left.length, to: left.length, insert: "KEEP" }]);
    assert.ok(applyTextOps(`${left}KEEP|${middle}|${right}`, deleted).includes("KEEP"));
  }), { numRuns: 300 });
});
