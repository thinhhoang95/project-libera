export type MarkdownWordCountStats = {
  characters: number;
  charactersNoSpaces: number;
  lines: number;
  paragraphs: number;
  readingMinutes: number;
  words: number;
};

function countMarkdownWords(content: string) {
  const visibleText = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^[\s>*+-]*\[[ xX]\]\s+/gm, "")
    .replace(/^[\s>*+-]+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[*_~=#|[\]()>-]/g, " ");

  return visibleText.match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

export function getMarkdownWordCountStats(content: string): MarkdownWordCountStats {
  const words = countMarkdownWords(content);
  return {
    characters: content.length,
    charactersNoSpaces: content.replace(/\s/g, "").length,
    lines: content ? content.split(/\r\n|\r|\n/).length : 0,
    paragraphs: content.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean).length,
    readingMinutes: words ? Math.max(1, Math.ceil(words / 200)) : 0,
    words,
  };
}

export function wordCountStatItems(stats: MarkdownWordCountStats) {
  return [
    { label: "Words", value: stats.words },
    { label: "Characters", value: stats.characters },
    { label: "Characters without spaces", value: stats.charactersNoSpaces },
    { label: "Paragraphs", value: stats.paragraphs },
    { label: "Lines", value: stats.lines },
    { label: "Reading time", value: stats.readingMinutes, suffix: " min" },
  ];
}
