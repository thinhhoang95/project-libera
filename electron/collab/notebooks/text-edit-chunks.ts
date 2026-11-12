// Splits a large text edit into several bounded transactions. A Yjs update
// cannot be divided after it is made, and the server refuses updates over
// SyncLimits.maxUpdateBytes, so very large external edits are applied in
// pieces that each stay far below that limit.

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** One delete-then-insert at `pos`. */
export interface TextOp {
  pos: number;
  del: number;
  text: string;
}

/** Inserted characters per transaction (3 bytes each in the worst case: ~1.5 MiB, under the 4 MiB limit). */
export const MAX_CHUNK_CHARS = 512 * 1024;
const MAX_CHUNK_OPS = 2_000;

/**
 * Turns edits (non-overlapping, ascending, offsets in the original text) into
 * groups of operations to apply in order, each group in one transaction. Edits
 * are visited from the back so earlier offsets stay valid; a long insert is
 * cut into consecutive pieces (never inside a surrogate pair).
 */
export function chunkTextEdits(edits: readonly TextEdit[], maxChars = MAX_CHUNK_CHARS): TextOp[][] {
  const chunks: TextOp[][] = [];
  let current: TextOp[] = [];
  let chars = 0;
  const push = (op: TextOp): void => {
    if (current.length > 0 && (chars + op.text.length > maxChars || current.length >= MAX_CHUNK_OPS)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(op);
    chars += op.text.length;
  };
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index];
    let del = edit.end > edit.start ? edit.end - edit.start : 0;
    let offset = 0;
    do {
      let length = Math.min(maxChars, edit.text.length - offset);
      if (length > 0 && offset + length < edit.text.length) {
        const last = edit.text.charCodeAt(offset + length - 1);
        if (last >= 0xd800 && last <= 0xdbff && length > 1) length -= 1;
      }
      push({ pos: edit.start + offset, del, text: edit.text.slice(offset, offset + length) });
      del = 0;
      offset += length;
    } while (offset < edit.text.length);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
