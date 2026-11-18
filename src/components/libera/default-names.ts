/**
 * Names Libera gives new things on disk. They are file and folder names, not interface text, so they stay English
 * for now (an open decision in docs/i18n-plan.md). Everything that invents one goes through here, so translating
 * them later is a change in this file.
 */

/** The name a new, unsaved note starts with. */
export const DEFAULT_UNTITLED_NAME = "Untitled";

/** The name the New folder dialog starts with. */
export const DEFAULT_NEW_FOLDER_NAME = "New folder";

/** The name suggested for a copy of `name`: "notes.md" becomes "notes copy.md". */
export function suggestedCopyName(name: string) {
  const extensionMatch = name.match(/(\.[^.]+)$/);
  const extension = extensionMatch?.[1] ?? "";
  const stem = extension ? name.slice(0, -extension.length) : name;

  return `${stem} copy${extension}`;
}

/** The name of the new note that "Expand macros" opens, from the note's name without its extension. */
export function expandedNoteName(stem: string) {
  return `${stem || DEFAULT_UNTITLED_NAME} (expanded).md`;
}

/** The name of the draft that holds a review document recovered after it was closed. */
export const RECOVERED_REVIEW_NAME = "Recovered review.md";
