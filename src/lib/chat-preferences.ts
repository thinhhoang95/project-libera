export const DEFAULT_CHAT_FONT_SIZE = 14;
export const MIN_CHAT_FONT_SIZE = 10;
export const MAX_CHAT_FONT_SIZE = 32;

export function isChatFontSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_CHAT_FONT_SIZE && value <= MAX_CHAT_FONT_SIZE;
}
