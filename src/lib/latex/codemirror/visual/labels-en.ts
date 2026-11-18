import en from "../../../../../messages/en.json";

/* English for the Visual mode's own words, shown when no translator is installed (see labels.ts): tests and headless use.
 * Read from messages/en.json, namespace lib.latex.codemirror.visual (groups widgets, tableEdit, drawingPreview, floatEdit,
 * titleEdit, algorithmEdit), flattened to `<group>.<key>`, so the two never drift apart. */
function flatten(node: unknown, prefix: string, into: Record<string, string>) {
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === "string") into[`${prefix}${key}`] = value;
    else flatten(value, `${prefix}${key}.`, into);
  }
  return into;
}

export const VISUAL_ENGLISH: Record<string, string> = flatten(en.lib.latex.codemirror.visual, "", {});
