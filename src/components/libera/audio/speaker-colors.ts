// Speaker colors, distinct from one another and legible on light and dark panels.
const SPEAKER_COLORS = ["#5b8def", "#e0815a", "#3fae84", "#a77bd6", "#d4a22c", "#d0607e", "#3ba6b8", "#8d8f99", "#7b9b3a", "#c46bc0", "#5f6fd6", "#c98a5d"];

export function speakerColor(speaker: number | null | undefined) {
  if (speaker === null || speaker === undefined || speaker < 0) return "var(--muted-foreground)";
  return SPEAKER_COLORS[speaker % SPEAKER_COLORS.length];
}

export function speakerInitials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  // "Speaker 3" reads better as its number than as "S3".
  if (/^speaker$/i.test(words[0]) && words[1]) return words[1].slice(0, 2);
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}
