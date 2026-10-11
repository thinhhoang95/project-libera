/** Lets features outside an editor (like "Add selection to AI chat") read the
 * selected text of code editors whose DOM selection only covers the lines
 * currently rendered. Keyed by the editor's root element. */

const readers = new WeakMap<Element, () => string>();

export function registerEditorSelectionReader(element: Element, read: () => string) {
  readers.set(element, read);
  return () => {
    if (readers.get(element) === read) readers.delete(element);
  };
}

/** The selected text of the registered editor containing `target`, if any. */
export function readRegisteredEditorSelection(target: Element) {
  const root = target.closest("[data-libera-code-editor]");
  const read = root ? readers.get(root) : undefined;
  return read ? read() : null;
}
