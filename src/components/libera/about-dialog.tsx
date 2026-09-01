"use client";

import { useEffect, useState } from "react";
import { appMetadata } from "@/lib/app-metadata";
import { ModalDialog } from "@/components/libera/modal-dialog";

type AboutDialogProps = {
  open: boolean;
  onClose: () => void;
};

const DEFAULT_UPDATE_STATE: LiberaUpdaterState = {
  status: "unsupported",
  currentVersion: appMetadata.version,
};

function updateStatusText(state: LiberaUpdaterState) {
  switch (state.status) {
    case "idle":
      return "Automatic updates are enabled.";
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Version ${state.availableVersion ?? "new"} is available.`;
    case "downloading":
      return `Downloading version ${state.availableVersion ?? "new"} (${state.percent ?? 0}%)…`;
    case "downloaded":
      return `Version ${state.availableVersion ?? "new"} is ready to install.`;
    case "up-to-date":
      return "Libera is up to date.";
    case "error":
      return state.error || "The update check failed.";
    default:
      return "Automatic updates are available in the installed desktop app.";
  }
}

export function AboutDialog({ open, onClose }: AboutDialogProps) {
  const [updateState, setUpdateState] = useState(DEFAULT_UPDATE_STATE);

  useEffect(() => {
    const updater = window.liberaUpdater;

    if (!updater) {
      return;
    }

    void updater.getState().then(setUpdateState).catch(() => undefined);
    return updater.onStateChanged(setUpdateState);
  }, []);

  const updateInProgress = ["checking", "available", "downloading", "downloaded"].includes(
    updateState.status,
  );
  const updateReady = updateState.status === "downloaded";
  const updaterAvailable = updateState.status !== "unsupported";
  const aboutRows = [
    ["App name", appMetadata.name],
    ["Version", updateState.currentVersion],
    ["Author", appMetadata.author],
    ["Customized for", appMetadata.customizedFor],
    ["Release date", appMetadata.releaseDate],
  ] as const;

  return (
    <ModalDialog
      open={open}
      title={`About ${appMetadata.name}`}
      description="Application information"
      onClose={onClose}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          {updaterAvailable ? (
            <button
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              disabled={updateInProgress}
              type="button"
              onClick={() => void window.liberaUpdater?.check().catch(() => undefined)}
            >
              {updateState.status === "checking" ? "Checking…" : "Check for Updates"}
            </button>
          ) : null}
          {updateReady ? (
            <button
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={updateState.hasUnsavedDocuments}
              title={
                updateState.hasUnsavedDocuments
                  ? "Save all open edits before restarting."
                  : undefined
              }
              type="button"
              onClick={() => void window.liberaUpdater?.restartAndInstall().catch(() => undefined)}
            >
              Restart and Update
            </button>
          ) : null}
          <button
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      }
    >
      <dl className="divide-y divide-border text-sm">
        {aboutRows.map(([label, value]) => (
          <div className="grid grid-cols-[120px_1fr] gap-4 py-3 first:pt-0 last:pb-0" key={label}>
            <dt className="font-medium text-foreground">{label}</dt>
            <dd className="min-w-0 text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        {updateStatusText(updateState)}
        {updateReady && updateState.hasUnsavedDocuments ? (
          <div className="mt-1 text-foreground">Save all open edits before restarting.</div>
        ) : null}
      </div>
    </ModalDialog>
  );
}
