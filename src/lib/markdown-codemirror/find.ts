import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { TextMatch } from "@/lib/text-find";

/* Find and Replace matches, drawn with the same classes (and so the same
 * colours) as the textarea editor's overlay. The matches themselves come from
 * `findTextMatches`, which also handles the Wildcards option. */

export const setFindMatches = StateEffect.define<{ matches: TextMatch[]; active: number }>();

const matchMark = Decoration.mark({ class: "markdown-editor-find-match" });
const activeMark = Decoration.mark({ class: "markdown-editor-find-match markdown-editor-find-match-active" });

export const findMatchesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setFindMatches)) continue;
      const length = tr.state.doc.length;
      const { matches, active } = effect.value;
      next = Decoration.set(matches.flatMap((match, index) => match.end > match.start && match.end <= length
        ? [(index === active ? activeMark : matchMark).range(match.start, match.end)]
        : []));
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});
