import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import { ContentKeys } from "../../src/lib/collab/protocol/schema";
import { createVisualParticipant, Network, posOf, select } from "./tiptap-bridge-harness.test";

// A note of about 1 MB mixing the block kinds people use.
function largeNote(bytes: number) {
  const sections: string[] = [];
  let size = 0;
  for (let index = 0; size < bytes; index++) {
    const section = [
      `## Section ${index}`,
      `Paragraph ${index} with **bold**, *italic*, \`code\` and a [link](https://example.com/${index}). Tiếng Việt có dấu, 日本語のテキスト.`,
      `- item ${index}.1\n- item ${index}.2\n  - nested ${index}`,
      index % 5 === 0 ? `| a${index} | b |\n| --- | --- |\n| 1 | 2 |` : `> Quote ${index} that runs for a little while to make the block longer.`,
      index % 7 === 0 ? "```ts\nconst value = " + index + ";\n```" : `Another paragraph ${index} closing the section.`,
    ].join("\n\n");
    sections.push(section);
    size += section.length + 2;
  }
  return sections.join("\n\n");
}

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { avg: +avg.toFixed(2), p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2), max: +sorted.at(-1)!.toFixed(2) };
};

test("1 MB note: local keystroke and remote apply cost of the bridge", (t) => {
  const source = largeNote(1_000_000);
  const docs = [new Y.Doc(), new Y.Doc()];
  const network = new Network(docs);
  docs[0].getText(ContentKeys.source).insert(0, source);
  network.deliver();
  let started = performance.now();
  const a = createVisualParticipant(docs[0], {}, { emptyEditor: true });
  const bindA = performance.now() - started;
  started = performance.now();
  const b = createVisualParticipant(docs[1], {}, { emptyEditor: true });
  const bindB = performance.now() - started;
  try {
    assert.equal(a.ytext.toString(), source);
    const middle = Math.floor(source.length / 2);
    const marker = source.indexOf("Another paragraph", middle);
    const word = source.slice(marker, source.indexOf(" closing", marker));
    select(a.editor, posOf(a.editor, word, word.length));
    // Time ProseMirror's own dispatch (view update) apart from the bridge's work.
    let viewTime = 0;
    for (const editor of [a.editor, b.editor]) {
      const dispatch = editor.view.dispatch.bind(editor.view);
      editor.view.dispatch = (tr) => { const at = performance.now(); dispatch(tr); viewTime += performance.now() - at; };
    }
    const typing: number[] = [], local: number[] = [], localView: number[] = [], remote: number[] = [], remoteView: number[] = [];
    for (let index = 0; index < 300; index++) {
      const char = "abcdefghij "[index % 11];
      viewTime = 0;
      let at = performance.now();
      a.editor.view.dispatch(a.editor.state.tr.insertText(char));
      typing.push(performance.now() - at);
      viewTime = 0;
      at = performance.now();
      a.bridge.flush();
      local.push(performance.now() - at - viewTime);
      localView.push(viewTime);
      viewTime = 0;
      at = performance.now();
      network.deliver();
      remote.push(performance.now() - at - viewTime);
      remoteView.push(viewTime);
    }
    assert.deepEqual(a.bridge.verify(), []);
    assert.deepEqual(b.bridge.verify(), []);
    assert.equal(b.ytext.toString(), a.ytext.toString());
    const skip = (values: number[]) => stats(values.slice(20));
    const result = {
      sourceBytes: source.length,
      topLevelNodes: a.editor.state.doc.childCount,
      bindMs: { a: Math.round(bindA), b: Math.round(bindB) },
      // Per keystroke, flushed every keystroke (the worst case of the 50 ms throttle).
      localBridgeMs: skip(local),
      localBridgeDispatchMs: skip(localView),
      remoteBridgeMs: skip(remote),
      remoteDispatchMs: skip(remoteView),
      typingDispatchMs: skip(typing),
    };
    t.diagnostic(JSON.stringify(result));
    // jsdom numbers are indicative; guard against regressions far above the budget.
    assert.ok(result.localBridgeMs.p95 < 16, `local p95 ${result.localBridgeMs.p95} ms`);
  } finally {
    for (const participant of [a, b]) { participant.bridge.destroy(); participant.editor.destroy(); participant.awareness.destroy(); }
  }
});
