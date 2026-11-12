"use client";

import { AlertCircle, CheckCircle2, ChevronRight, Download, Info, Mail, RefreshCw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { appMetadata } from "@/lib/app-metadata";
import { ModalDialog } from "@/components/libera/modal-dialog";

type AboutDialogProps = {
  open: boolean;
  onClose: () => void;
};

const FEEDBACK_EMAIL = "dthoang@intuelle.com";

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

function UpdateStatusIcon({ status }: { status: LiberaUpdaterState["status"] }) {
  const className = "mt-0.5 h-4 w-4 shrink-0";

  switch (status) {
    case "checking":
      return <RefreshCw aria-hidden className={`${className} animate-spin text-muted-foreground`} />;
    case "available":
    case "downloading":
    case "downloaded":
      return <Download aria-hidden className={`${className} text-[var(--about-brand)]`} />;
    case "idle":
    case "up-to-date":
      return <CheckCircle2 aria-hidden className={`${className} text-[var(--about-brand)]`} />;
    case "error":
      return <AlertCircle aria-hidden className={`${className} text-destructive`} />;
    default:
      return <Info aria-hidden className={`${className} text-muted-foreground`} />;
  }
}

export function AboutDialog({ open, onClose }: AboutDialogProps) {
  const [updateState, setUpdateState] = useState(DEFAULT_UPDATE_STATE);
  // Update details stay collapsed until asked for; each opening of the dialog starts collapsed.
  const [updatesExpanded, setUpdatesExpanded] = useState(false);
  const updatesPanelId = useId();

  function handleClose() {
    setUpdatesExpanded(false);
    onClose();
  }

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
  const updateNeedsAttention = ["available", "downloading", "downloaded", "error"].includes(
    updateState.status,
  );
  const aboutRows = [
    ["Author", appMetadata.author],
    ["Customized for", appMetadata.customizedFor],
    ["Release date", appMetadata.releaseDate],
  ] as const;

  return (
    <ModalDialog
      sectioned
      open={open}
      panelClassName="max-w-md"
      title={`About ${appMetadata.name}`}
      onClose={handleClose}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <a
            className="mr-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
            href={`mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(
              `${appMetadata.name} feedback (version ${updateState.currentVersion})`,
            )}`}
            title={`Email ${FEEDBACK_EMAIL}`}
          >
            <Mail aria-hidden className="h-4 w-4" />
            Feedback
          </a>
          {updaterAvailable ? (
            <button
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              disabled={updateInProgress}
              type="button"
              onClick={() => {
                // Show the result of a check the user just asked for.
                setUpdatesExpanded(true);
                void window.liberaUpdater?.check().catch(() => undefined);
              }}
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
            onClick={handleClose}
          >
            Close
          </button>
        </div>
      }
    >
      {/* Brand green, lifted in dark mode so it stays legible on the dark surface. */}
      <div className="[--about-brand:#106660] [--about-brand-to:#2fa597] [--about-brand-deep:#0a4743] [.dark_&]:[--about-brand:#5cc2b6] [[data-theme=dark]_&]:[--about-brand:#5cc2b6] [.dark_&]:[--about-brand-to:#b4f0e4] [[data-theme=dark]_&]:[--about-brand-to:#b4f0e4] [.dark_&]:[--about-brand-deep:#2f9c90] [[data-theme=dark]_&]:[--about-brand-deep:#2f9c90]">
        <div className="relative isolate flex flex-col items-center px-6 pb-5 pt-4 text-center">
          {/* Soft brand glow behind the mark. */}
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-0 -z-10 h-44 w-72 -translate-x-1/2 rounded-full blur-2xl"
            style={{
              background:
                "radial-gradient(closest-side, color-mix(in srgb, var(--about-brand) 22%, transparent), transparent)",
            }}
          />
          {/* The shadow sits on the wrapper because the mask would clip it away. */}
          <div
            aria-hidden
            className="aspect-[516/564] w-[76px] select-none"
            style={{
              filter:
                "drop-shadow(0 10px 18px color-mix(in srgb, var(--about-brand) 32%, transparent))",
            }}
          >
            <span
              className="block h-full w-full"
              style={{
                background:
                  "linear-gradient(140deg, var(--about-brand-to) 5%, var(--about-brand) 55%, var(--about-brand-deep) 100%)",
                mask: 'url("/libera-logo-white.png") center / contain no-repeat',
                WebkitMask: 'url("/libera-logo-white.png") center / contain no-repeat',
              }}
            />
          </div>
          <div className="mt-5 text-[22px] font-semibold tracking-tight text-foreground">
            {appMetadata.name}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">A liberal notetaking app.</p>
          <span className="mt-3 inline-flex items-center rounded-full border border-[color-mix(in_srgb,var(--about-brand)_30%,transparent)] bg-[color-mix(in_srgb,var(--about-brand)_10%,transparent)] px-2.5 py-0.5 text-xs font-medium tabular-nums text-[var(--about-brand)]">
            Version {updateState.currentVersion}
          </span>
        </div>

        <dl className="divide-y divide-border border-t border-border px-1 text-sm">
          {aboutRows.map(([label, value]) => (
            <div className="flex items-baseline justify-between gap-4 py-2.5" key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 truncate text-right font-medium text-foreground">{value}</dd>
            </div>
          ))}
        </dl>

        <div className="border-t border-border px-1 text-sm">
          <button
            aria-controls={updatesPanelId}
            aria-expanded={updatesExpanded}
            className="flex w-full items-center justify-between gap-4 rounded-md py-2.5 text-left text-muted-foreground hover:text-foreground"
            type="button"
            onClick={() => setUpdatesExpanded((expanded) => !expanded)}
          >
            <span className="flex items-center gap-2">
              Updates
              {updateNeedsAttention && !updatesExpanded ? (
                <span
                  aria-label="Update information available"
                  className={`h-1.5 w-1.5 rounded-full ${
                    updateState.status === "error" ? "bg-destructive" : "bg-[var(--about-brand)]"
                  }`}
                  role="img"
                />
              ) : null}
            </span>
            <ChevronRight
              aria-hidden
              className={`h-4 w-4 transition-transform duration-200 ${updatesExpanded ? "rotate-90" : ""}`}
            />
          </button>
          <div aria-live="polite" id={updatesPanelId}>
            {updatesExpanded ? (
              <div className="mb-1 flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-muted-foreground">
                <UpdateStatusIcon status={updateState.status} />
                <div className="min-w-0 flex-1">
                  {updateStatusText(updateState)}
                  {updateState.status === "downloading" ? (
                    <div className="mt-2 h-1 overflow-hidden rounded-full bg-border">
                      <div
                        className="h-full rounded-full bg-[var(--about-brand)] transition-[width] duration-300"
                        style={{ width: `${Math.min(100, Math.max(0, updateState.percent ?? 0))}%` }}
                      />
                    </div>
                  ) : null}
                  {updateReady && updateState.hasUnsavedDocuments ? (
                    <div className="mt-1 text-foreground">Save all open edits before restarting.</div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </ModalDialog>
  );
}
