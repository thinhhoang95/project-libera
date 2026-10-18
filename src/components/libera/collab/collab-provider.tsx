"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { LocalProject, NotificationInfo } from "@/lib/collab/local-api";
import { collabClient } from "@/lib/collab/ui/client";
import { useCollabProjects, useCollabStatus } from "@/lib/collab/ui/hooks";
import { CollabAccountDialog } from "./collab-account-dialog";
import { useDesktopNotifications } from "./desktop-notifications";
import { useForwardSharedFileChanges } from "./forward-search-changes";
import { JoinNotebookDialog } from "./join-notebook-dialog";
import { ShareNotebookDialog } from "./share-notebook-dialog";

/** What the app shell (rail, notebook menu, Library header) needs from collaboration. */
export interface CollabShellValue {
  /** False when the host reports collaboration disabled, or before the first status arrives. */
  visible: boolean;
  signedIn: boolean;
  projectForNotebook(notebook: string): LocalProject | undefined;
  /** "Share notebook…" applies to normal top-level notebooks only: not linked folders, not already shared. */
  canShareNotebook(notebook: { name: string; folder?: unknown }): boolean;
  openAccount(): void;
  openShare(notebook: string): void;
  openJoin(invitation?: string): void;
  openNotificationTarget(notification: NotificationInfo & { docId: string }): void;
}

const CollabShellContext = createContext<CollabShellValue | null>(null);

/** Null outside CollabProvider, so shell components render nothing collaborative there. */
export function useCollabShell(): CollabShellValue | null {
  return useContext(CollabShellContext);
}

export interface CollabProviderProps {
  children: ReactNode;
  /** A joined notebook's folder now exists: refresh the tree and open it. */
  onNotebookJoined: (notebook: string) => void | Promise<void>;
  /** Opens a Libera path ("Notebook/sub/file.md") in the canvas. */
  onOpenPath: (path: string) => void;
}

/**
 * Owns the collaboration dialogs (account, share, join) and exposes the
 * actions that open them to the shell through context, so the notebook panel
 * and the rail need no extra props.
 */
export function CollabProvider({ children, onNotebookJoined, onOpenPath }: CollabProviderProps) {
  useForwardSharedFileChanges();
  const collab = useCollabStatus();
  const { projectForNotebook } = useCollabProjects();
  const [accountOpen, setAccountOpen] = useState(false);
  const [shareNotebook, setShareNotebook] = useState<string | null>(null);
  const [join, setJoin] = useState<{ invitation: string } | null>(null);
  const visible = collab.enabled && collab.phase !== "loading";
  const signedIn = collab.signedIn;

  // The shell passes fresh callbacks on every render; reading them through
  // refs keeps the context value stable so the Notebooks panel does not
  // re-render for nothing.
  const callbacks = useRef({ onNotebookJoined, onOpenPath });
  useEffect(() => {
    callbacks.current = { onNotebookJoined, onOpenPath };
  });

  const openNotificationTarget = useCallback((notification: NotificationInfo & { docId: string }) => {
    void collabClient
      .doc(notification.docId)
      .then((doc) => callbacks.current.onOpenPath(doc.path))
      // The document may have been deleted, or the notebook left; the
      // notification stays readable in the list either way.
      .catch(() => undefined);
  }, []);
  // A notification that arrives while the window is in the background is
  // also shown on the desktop; clicking it opens the document.
  useDesktopNotifications(openNotificationTarget);

  const value = useMemo<CollabShellValue>(
    () => ({
      visible,
      signedIn,
      projectForNotebook,
      canShareNotebook: (notebook) => visible && signedIn && !notebook.folder && !projectForNotebook(notebook.name),
      openAccount: () => setAccountOpen(true),
      openShare: (notebook) => setShareNotebook(notebook),
      openJoin: (invitation = "") => {
        setAccountOpen(false);
        setJoin({ invitation });
      },
      openNotificationTarget,
    }),
    [visible, signedIn, projectForNotebook, openNotificationTarget],
  );

  return (
    <CollabShellContext.Provider value={value}>
      {children}
      {visible ? (
        <>
          <CollabAccountDialog
            open={accountOpen}
            onClose={() => setAccountOpen(false)}
            onJoin={() => {
              setAccountOpen(false);
              setJoin({ invitation: "" });
            }}
          />
          {shareNotebook ? <ShareNotebookDialog key={shareNotebook} notebook={shareNotebook} onClose={() => setShareNotebook(null)} /> : null}
          {join ? (
            <JoinNotebookDialog
              initialInvitation={join.invitation}
              onClose={() => setJoin(null)}
              onJoined={(project) => {
                setJoin(null);
                void callbacks.current.onNotebookJoined(project.notebook);
              }}
              onSignIn={() => {
                setJoin(null);
                setAccountOpen(true);
              }}
            />
          ) : null}
        </>
      ) : null}
    </CollabShellContext.Provider>
  );
}
