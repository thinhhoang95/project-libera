export const MARKDOWN_TABLE_FIRST_HEADER = "Column 1";

/** An empty GFM table: a header row of column names, then `rows - 1` blank rows. */
export function markdownTable(rows: number, columns: number) {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const count = Math.max(1, columns);
  return [
    line(Array.from({ length: count }, (_, index) => `Column ${index + 1}`)),
    line(Array.from({ length: count }, () => "---")),
    ...Array.from({ length: Math.max(0, rows - 1) }, () => line(Array.from({ length: count }, () => " "))),
  ].join("\n");
}
