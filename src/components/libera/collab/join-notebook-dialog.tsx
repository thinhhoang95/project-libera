"use client";

import { LoaderCircle, LogIn, Users } from "lucide-react";
import { useId, useState } from "react";
import type { FormEvent } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type { LocalProject } from "@/lib/collab/local-api";
import { collabClient, describeError } from "@/lib/collab/ui/client";
import { useCollabStatus } from "@/lib/collab/ui/hooks";
import { getCollabStatusStore } from "@/lib/collab/ui/status-store";

export interface JoinNotebookDialogProps {
  onClose: () => void;
  /** Called with the joined project once its folder exists; the caller opens the notebook. */
  onJoined: (project: LocalProject) => void;
  /** Shown when no account is signed in. */
  onSignIn?: () => void;
  /** Prefills the field, e.g. from an invitation link the app was opened with. */
  initialInvitation?: string;
}

/**
 * The host accepts a full invitation URL or a bare token (JoinProjectRequest),
 * so only paste noise is removed: whitespace and the <angle brackets> some
 * mail clients wrap links in.
 */
export function normalizeInvitation(input: string): string {
  return input.trim().replace(/^<|>$/g, "");
}

/** "Join a shared notebook…": paste an invitation link or code, join, open. */
export function JoinNotebookDialog({ onClose, onJoined, onSignIn, initialInvitation = "" }: JoinNotebookDialogProps) {
  const id = useId();
  const { signedIn } = useCollabStatus();
  const [invitation, setInvitation] = useState(initialInvitation);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = normalizeInvitation(invitation);
    if (!value) {
      setError("Paste the invitation link or code you received.");
      return;
    }
    setJoining(true);
    setError("");
    const store = getCollabStatusStore();
    const before = new Set((store.getSnapshot().status?.projects ?? []).map((project) => project.projectId));
    try {
      const result = await collabClient.join({ invitation: value });
      await store.refreshProjects();
      const projects = store.getSnapshot().status?.projects ?? [];
      // The host answers with the project; older builds may answer 204, so
      // fall back to whichever project is new in the list.
      const joined =
        (result && typeof result === "object" && "projectId" in result
          ? projects.find((project) => project.projectId === result.projectId) ?? result
          : undefined) ?? projects.find((project) => !before.has(project.projectId));
      if (!joined) {
        setError("You joined, but the notebook has not appeared yet. It shows up in the Library once it has downloaded.");
        return;
      }
      onJoined(joined);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setJoining(false);
    }
  }

  return (
    <ModalDialog
      open
      title="Join a shared notebook"
      description="Paste the invitation link or code someone sent you. The notebook is downloaded into your Library and keeps syncing."
      onClose={onClose}
      footer={
        <>
          <button className="rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted" type="button" onClick={onClose}>
            Cancel
          </button>
          {signedIn ? (
            <button
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={joining}
              form={`${id}-form`}
              type="submit"
            >
              {joining ? <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Users aria-hidden className="h-3.5 w-3.5" />}
              {joining ? "Joining…" : "Join"}
            </button>
          ) : null}
        </>
      }
    >
      {signedIn ? (
        <form className="space-y-3" id={`${id}-form`} noValidate onSubmit={join}>
          <div>
            <label className="block text-sm font-medium text-foreground" htmlFor={`${id}-invitation`}>
              Invitation link or code
            </label>
            <input
              autoFocus
              className="mt-1 h-10 w-full rounded-xl border border-input px-3 font-mono text-sm outline-none transition focus:border-ring"
              disabled={joining}
              id={`${id}-invitation`}
              placeholder="https://… or the code"
              spellCheck={false}
              value={invitation}
              onChange={(event) => setInvitation(event.target.value)}
            />
          </div>
          {joining ? (
            <p className="text-xs text-muted-foreground" role="status">
              Downloading the notebook. Large notebooks can take a minute.
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : (
        <div className="space-y-3 text-sm">
          <p>Sign in to your collaboration account first. If you do not have one, create it with the invitation link.</p>
          {onSignIn ? (
            <button className="inline-flex items-center gap-1.5 rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted" type="button" onClick={onSignIn}>
              <LogIn aria-hidden className="h-3.5 w-3.5" /> Sign in or create account
            </button>
          ) : null}
        </div>
      )}
    </ModalDialog>
  );
}
