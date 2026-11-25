/**
 * Source editors remember the drafts they published, to tell the workspace
 * handing one back (an echo, possibly after more typing) from a real outside
 * change. A link rewrite is an outside change that can return the text to a
 * string the editor published earlier (a target moved A to B and back to A); the
 * remembered string would make the editor ignore it. The workspace announces the
 * text it put in a tab, and editors forget that string.
 */
const listeners = new Set<(text: string) => void>();

/** Drops every remembered draft equal to `text`, in place. */
export function forgetPublished(published: string[], text: string) {
  for (let index = published.length - 1; index >= 0; index--) if (published[index] === text) published.splice(index, 1);
}

export function announceTextReplaced(text: string) {
  for (const listener of [...listeners]) listener(text);
}

export function onTextReplaced(listener: (text: string) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
