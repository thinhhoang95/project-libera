/*
 * How long the editor waits after the last edit before typesetting on its own.
 * A fast document keeps the original 1.2 s pause; a slow one waits in
 * proportion to its last compile so typing does not queue one full typeset
 * after another. On battery, or when nobody is looking at the PDF, the pause is
 * longer still.
 */

export const AUTO_COMPILE_MIN_DELAY_MS = 1200;
export const AUTO_COMPILE_MAX_DELAY_MS = 8000;
export const AUTO_COMPILE_BATTERY_MIN_DELAY_MS = 4000;
export const AUTO_COMPILE_BATTERY_MAX_DELAY_MS = 15000;

export type AutoCompileDelayInput = {
  /** How long the last compile took, or null when none has finished yet. */
  lastCompileMs: number | null;
  onBattery: boolean;
  /** The PDF pane is hidden and no separate PDF window shows it. */
  pdfHidden: boolean;
};

export function autoCompileDelayMs({ lastCompileMs, onBattery, pdfHidden }: AutoCompileDelayInput): number {
  const last = lastCompileMs !== null && Number.isFinite(lastCompileMs) && lastCompileMs > 0 ? lastCompileMs : 0;
  const slow = onBattery || pdfHidden;
  const min = slow ? AUTO_COMPILE_BATTERY_MIN_DELAY_MS : AUTO_COMPILE_MIN_DELAY_MS;
  const max = slow ? AUTO_COMPILE_BATTERY_MAX_DELAY_MS : AUTO_COMPILE_MAX_DELAY_MS;
  const wanted = Math.max(min, (slow ? 2 : 1.5) * last);
  return Math.min(max, Math.max(min, wanted));
}
