/* sgame's strategic-form game, `\begin{game}{2}{2}[Row player][Column player] & $a$ & $b$\\ $a$ & 1,1 & 0,0\\ … \end{game}`
 * (2611.05706): a grid of the players' actions and payoffs, drawn as a table. The package sets the column player's name over
 * the columns and the row player's at the left; here they head the table, over the columns and in the corner. */

const HEAD = /^\\begin\s*\{game\}\s*\{(\d+)\}\s*\{(\d+)\}\s*(?:\[([^\]\n]*)\])?\s*(?:\[([^\]\n]*)\])?/;

/** `text` split at the top-level `separator` (not in braces or `$…$`); null when its braces or dollars do not balance. */
function splitTopLevel(text: string, separator: "&" | "\\\\"): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let math = false;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "%" ) { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (ch === "\\") {
      if (separator === "\\\\" && text[i + 1] === "\\" && depth === 0 && !math) {
        parts.push(text.slice(last, i));
        i++;
        // An optional length (`\\[2pt]`) is not part of the next row.
        const length = /^\[[^\]\n]*\]/.exec(text.slice(i + 1));
        if (length) i += length[0].length;
        last = i + 1;
      } else i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") { if (--depth < 0) return null; }
    else if (ch === "$" && depth === 0) math = !math;
    else if (ch === separator && separator === "&" && depth === 0 && !math) { parts.push(text.slice(last, i)); last = i + 1; }
  }
  if (depth !== 0 || math) return null;
  parts.push(text.slice(last));
  return parts;
}

/**
 * The game as a tabular (source for the table model) and where its body starts, from the text of the environment up to its
 * `\end` (`opening` starts at `\begin{game}`); null when its rows and columns are not those the header says.
 */
export function gameTabular(opening: string): { tabular: string; bodyFrom: number } | null {
  const head = HEAD.exec(opening);
  if (!head) return null;
  const rows = Number(head[1]);
  const columns = Number(head[2]);
  if (!rows || !columns || rows > 12 || columns > 12) return null;
  const lines = splitTopLevel(opening.slice(head[0].length), "\\\\");
  if (!lines) return null;
  // A final `\\` leaves an empty line.
  if (lines.length === rows + 2 && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length !== rows + 1) return null;
  const grid: string[][] = [];
  for (const line of lines) {
    const cells = splitTopLevel(line, "&");
    if (!cells || cells.length !== columns + 1) return null;
    grid.push(cells.map((cell) => cell.replace(/\s+/g, " ").trim()));
  }
  const rowName = head[3]?.trim();
  const columnName = head[4]?.trim();
  const out: string[] = [`\\begin{tabular}{r|${"c".repeat(columns)}}`];
  if (columnName) out.push(` & \\multicolumn{${columns}}{c}{\\emph{${columnName}}} \\\\`);
  grid[0][0] = grid[0][0] || (rowName ? `\\emph{${rowName}}` : "");
  out.push(`${grid[0].join(" & ")} \\\\ \\hline`);
  for (const row of grid.slice(1)) out.push(`${row.join(" & ")} \\\\`);
  out.push("\\end{tabular}");
  return { tabular: out.join("\n"), bodyFrom: head[0].length };
}
