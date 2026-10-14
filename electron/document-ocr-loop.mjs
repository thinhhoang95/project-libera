// Finds repetition loops in the PDF reading model's output, used by
// document-ocr-worker.mjs while it generates.
//
// A loop: the last LOOP_SPAN tokens repeat a cycle of at most LOOP_MAX_PERIOD
// tokens, at least three times for long cycles. Location tags (<loc_N>) are
// left out first: a repeated block sits at a new position each time, so its
// tags differ while its text repeats.

export const LOOP_SPAN = 192;
export const LOOP_MAX_PERIOD = 96;

/** The length of a cycle that fills the tail of `tokens`, or 0. */
export function loopPeriod(tokens) {
  for (let period = 1; period <= LOOP_MAX_PERIOD; period += 1) {
    const span = Math.max(LOOP_SPAN, period * 3);
    if (tokens.length < span) return 0;
    let periodic = true;
    for (let index = tokens.length - span + period; index < tokens.length; index += 1) {
      if (tokens[index] !== tokens[index - period]) {
        periodic = false;
        break;
      }
    }
    if (periodic) return period;
  }
  return 0;
}

/**
 * When `generated` ends in a loop, the number of tokens to keep: everything
 * up to the end of the cycle's first copy in the looping tail. Otherwise null.
 */
export function loopCutoff(generated, locationIds) {
  const content = [];
  const positions = [];
  generated.forEach((token, index) => {
    if (locationIds.has(token)) return;
    content.push(token);
    positions.push(index);
  });

  const period = loopPeriod(content);
  if (!period) return null;
  return positions[content.length - Math.max(LOOP_SPAN, period * 3) + period];
}

/**
 * Cut DocTags back to the end of the last closed block. After a loop, the
 * unfinished block is usually invented text, so it is dropped.
 */
export function completeBlocks(doctags) {
  const close = doctags.lastIndexOf("</");
  if (close < 0) return doctags.startsWith("<doctag>") ? "<doctag>" : "";
  const end = doctags.indexOf(">", close);
  return end < 0 ? doctags.slice(0, close) : doctags.slice(0, end + 1);
}
