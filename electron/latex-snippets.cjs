/** LaTeX snippets the user saved from the LaTeX editor. They are kept in the
 * Electron config under `latexSnippets`, so they survive restarts and travel
 * with preferences backups. Shared by the Electron main process and the app. */

const MAX_LATEX_SNIPPETS = 200;
const MAX_LATEX_SNIPPET_NAME_LENGTH = 64;
const MAX_LATEX_SNIPPET_LENGTH = 50_000;
const LATEX_SNIPPET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const LATEX_SNIPPET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** @param {unknown} value */
function normalizeLatexSnippetName(value) {
  return typeof value === "string" ? value.trim().replace(/^\/+/, "") : "";
}

/** Why a name cannot be used, or null when it can.
 * @param {string} name
 * @param {{ id: string; name: string }[]} snippets
 * @param {string} [exceptId] the snippet being renamed */
function latexSnippetNameError(name, snippets, exceptId) {
  if (!name) return "Give the snippet a name.";
  if (name.length > MAX_LATEX_SNIPPET_NAME_LENGTH) return `Use at most ${MAX_LATEX_SNIPPET_NAME_LENGTH} characters.`;
  if (!LATEX_SNIPPET_NAME_PATTERN.test(name)) return "Use letters, numbers, hyphens and underscores, starting with a letter or number.";
  const key = name.toLocaleLowerCase();
  if (snippets.some((snippet) => snippet.id !== exceptId && snippet.name.toLocaleLowerCase() === key)) return `A snippet named /${name} already exists.`;
  return null;
}

/** Keeps the valid snippets of stored or imported data, dropping the rest.
 * @param {unknown} input
 * @returns {{ id: string; name: string; body: string }[]} */
function normalizeLatexSnippets(input) {
  if (!Array.isArray(input)) return [];
  /** @type {{ id: string; name: string; body: string }[]} */
  const snippets = [];
  const ids = new Set();
  for (const value of input.slice(0, MAX_LATEX_SNIPPETS)) {
    if (!value || typeof value !== "object") continue;
    const id = typeof value.id === "string" && LATEX_SNIPPET_ID_PATTERN.test(value.id) ? value.id : "";
    const name = normalizeLatexSnippetName(value.name);
    const body = typeof value.body === "string" ? value.body : "";
    if (!id || ids.has(id) || !body.trim() || body.length > MAX_LATEX_SNIPPET_LENGTH || latexSnippetNameError(name, snippets)) continue;
    ids.add(id);
    snippets.push({ id, name, body });
  }
  return snippets;
}

module.exports = {
  MAX_LATEX_SNIPPETS,
  MAX_LATEX_SNIPPET_NAME_LENGTH,
  MAX_LATEX_SNIPPET_LENGTH,
  LATEX_SNIPPET_NAME_PATTERN,
  latexSnippetNameError,
  normalizeLatexSnippetName,
  normalizeLatexSnippets,
};
