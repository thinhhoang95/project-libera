"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { FindFlavor } from "@/lib/find";
import type { CodeMirrorFindSession } from "@/lib/find/codemirror-session";
import type { FindEditorKind } from "@/lib/find/settings-store";
import { FindReplaceBar } from "./find-replace-bar";
import { useFindQuery } from "./use-find-query";

/* The shared find & replace bar over a CodeMirror editor (LaTeX, code). The
 * session does the searching and replacing; this passes it the compiled query
 * and draws its state. Rendered inside the editor's positioned wrapper; the
 * editor attaches its view to the session (not passed here: React's dev
 * render logging walks changed props, and a view reaches the whole DOM). */

export function CodeMirrorFindBar({ session, kind, flavor, showScopes = false }: {
  session: CodeMirrorFindSession;
  kind: FindEditorKind;
  flavor: FindFlavor;
  showScopes?: boolean;
}) {
  const t = useTranslations("find");
  const find = useFindQuery(kind, flavor);
  const { setQuery } = find;
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const findInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => session.dispose(), [session]);

  useEffect(() => {
    session.setQuery({ query: find.query, finder: find.finder, replacer: find.replacer });
  }, [session, find.query, find.finder, find.replacer]);

  useEffect(() => session.onOpenRequest(({ focus, seed }) => {
    if (seed !== null) setQuery(seed);
    // After the bar has rendered (it may have just opened).
    window.requestAnimationFrame(() => {
      if (focus === "replace" && replaceInputRef.current) {
        replaceInputRef.current.focus();
        replaceInputRef.current.select();
      } else {
        findInputRef.current?.focus();
        findInputRef.current?.select();
      }
    });
  }), [session, setQuery]);

  if (!snapshot.open) return null;
  return (
    <FindReplaceBar
      find={find}
      matchCount={snapshot.matchCount}
      activeIndex={snapshot.active}
      incomplete={snapshot.incomplete}
      preview={snapshot.preview}
      summary={snapshot.summary}
      placeholder={t("findInFile")}
      findInputRef={findInputRef}
      replaceInputRef={replaceInputRef}
      onNext={session.next}
      onPrevious={session.previous}
      onClose={session.close}
      onReplace={() => { void session.replace(); }}
      onReplaceAll={() => { void session.replaceAll(); }}
      showScopes={showScopes}
      inSelection={{ active: snapshot.inSelection, onToggle: session.toggleInSelection }}
    />
  );
}
