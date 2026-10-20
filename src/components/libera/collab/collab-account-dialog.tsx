"use client";

import {
  Check,
  CloudOff,
  LoaderCircle,
  LogIn,
  RefreshCw,
  ShieldAlert,
  TriangleAlert,
  Users,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type { HostConnection, HostStatus, LocalAccount, SharedSignInOffer } from "@/lib/collab/local-api";
import { nudgeHost } from "@/lib/collab/ui/bridge";
import { collabClient, describeError } from "@/lib/collab/ui/client";
import { useCollabStatus } from "@/lib/collab/ui/hooks";
import { isValidServerUrl, lastServerUrl, normalizeServerUrl, rememberServerUrl } from "@/lib/collab/ui/server-url";
import { connectionWording, initials, readableTextColor, ROLE_LABEL } from "@/lib/collab/ui/wording";
import { ReportSyncProblem } from "./diagnostics/report-sync-problem";
import "./collab.css";

/** Cursor colours: saturated enough to see on white and on the dark canvas. */
export const COLLAB_COLORS = [
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#dc2626",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0d9488",
  "#0891b2",
  "#475569",
] as const;

const CONNECTION_ICON: Record<HostConnection, LucideIcon> = {
  "signed-out": LogIn,
  connecting: LoaderCircle,
  connected: Wifi,
  offline: CloudOff,
  "needs-sign-in": TriangleAlert,
  "update-required": ShieldAlert,
};

const FIELD = "mt-1 h-10 w-full rounded-xl border border-input px-3 text-sm outline-none transition focus:border-ring";
const LABEL = "block text-sm font-medium text-foreground";
const SECONDARY_BUTTON =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";
const PRIMARY_BUTTON =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60";

export interface CollabAccountDialogProps {
  open: boolean;
  onClose: () => void;
  /** Opens the join dialog; the button is hidden without it. */
  onJoin?: () => void;
}

/** Preferences → Collaboration: sign in, profile, connection state, sign out. */
export function CollabAccountDialog({ open, onClose, onJoin }: CollabAccountDialogProps) {
  const collab = useCollabStatus();
  const status = collab.status;
  const connection = status?.connection ?? "signed-out";
  const showSignIn = !status?.account || connection === "signed-out" || connection === "needs-sign-in";

  return (
    <ModalDialog
      open={open}
      panelClassName="max-w-xl"
      sectioned
      title="Collaboration"
      description="Share notebooks and edit them together. Your edits are always saved on this device first."
      onClose={onClose}
      footer={
        <button className={SECONDARY_BUTTON} type="button" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="space-y-4">
        {collab.phase === "loading" ? (
          <p className="libera-dialog-section flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <LoaderCircle aria-hidden className="h-4 w-4 animate-spin" /> Checking the collaboration service…
          </p>
        ) : collab.phase === "disabled" ? (
          <p className="libera-dialog-section text-sm text-muted-foreground">Collaboration is not enabled on this device.</p>
        ) : collab.phase === "error" && !status ? (
          <div className="libera-dialog-section space-y-2 text-sm" role="alert">
            <p className="text-destructive">{collab.error}</p>
            <button className={SECONDARY_BUTTON} type="button" onClick={() => void collab.refresh()}>
              <RefreshCw aria-hidden className="h-3.5 w-3.5" /> Try again
            </button>
          </div>
        ) : (
          <>
            {status?.account ? <ConnectionSection status={status} /> : null}
            {showSignIn ? (
              <section className="libera-dialog-section space-y-4">
                <ContinueFromOtherComputer
                  account={status?.account ?? null}
                  onSignedIn={(next) => (next ? collab.setStatus(next) : void collab.refresh())}
                />
                <SignInForm
                  key={status?.account?.id ?? "new"}
                  account={status?.account ?? null}
                  onSignedIn={(next) => (next ? collab.setStatus(next) : void collab.refresh())}
                />
              </section>
            ) : null}
            {status?.account ? (
              <>
                <ProfileSection key={status.account.id} account={status.account} onSaved={() => void collab.refresh()} />
                <ProjectsSection status={status} onJoin={onJoin} />
                <SignOutSection onSignedOut={() => void collab.refresh()} />
              </>
            ) : onJoin ? (
              <p className="px-1 text-xs text-muted-foreground">
                Got a notebook invitation? Create an account with the server’s registration code and the invitation, or sign in and choose “Join a shared notebook”.
              </p>
            ) : null}
            <ReportSyncProblem />
          </>
        )}
      </div>
    </ModalDialog>
  );
}

function ConnectionSection({ status }: { status: HostStatus }) {
  const wording = connectionWording(status.connection);
  const Icon = CONNECTION_ICON[status.connection];
  const account = status.account!;
  return (
    <section aria-label="Connection" className="libera-dialog-section space-y-3">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
          style={{ backgroundColor: account.color, color: readableTextColor(account.color) }}
        >
          {initials(account.displayName)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{account.displayName}</p>
          <p className="truncate text-xs text-muted-foreground">
            {account.email} · {account.serverUrl}
          </p>
        </div>
      </div>
      <div className="libera-collab-tone flex items-start gap-2 rounded-lg px-3 py-2 text-sm" data-tone={wording.tone} role="status">
        <Icon aria-hidden className={`mt-0.5 h-4 w-4 shrink-0 ${status.connection === "connecting" ? "libera-collab-spin animate-spin" : ""}`} />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{wording.label}</p>
          <p className="text-xs opacity-90">{wording.detail}</p>
          {status.detail ? <p className="mt-1 text-xs opacity-80">{status.detail}</p> : null}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {status.pendingCommands > 0
          ? `${status.pendingCommands} ${status.pendingCommands === 1 ? "comment or decision is" : "comments or decisions are"} waiting on this device to be sent.`
          : "Nothing is waiting to be sent."}
      </p>
      {status.connection === "offline" || status.connection === "connecting" ? (
        <button className={SECONDARY_BUTTON} type="button" onClick={nudgeHost}>
          <RefreshCw aria-hidden className="h-3.5 w-3.5" /> Reconnect now
        </button>
      ) : null}
      {status.connection === "update-required" ? <UpdateAction /> : null}
    </section>
  );
}

function UpdateAction() {
  const [state, setState] = useState<"idle" | "checking" | "done" | "unsupported">(
    typeof window !== "undefined" && window.liberaUpdater ? "idle" : "unsupported",
  );
  const [message, setMessage] = useState("");
  if (state === "unsupported") {
    return <p className="text-xs text-muted-foreground">Install the latest version of Libera, then open it again.</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        className={PRIMARY_BUTTON}
        disabled={state === "checking"}
        type="button"
        onClick={() => {
          setState("checking");
          void window.liberaUpdater
            ?.check()
            .then((next) => {
              setMessage(
                next.status === "downloaded"
                  ? "The update is ready. Restart Libera to install it."
                  : next.status === "up-to-date"
                    ? "No update is available yet. Ask the server's administrator."
                    : "Downloading the update. Libera will offer to restart when it is ready.",
              );
              setState("done");
            })
            .catch(() => {
              setMessage("The update check failed. Open About LiBERA to try again.");
              setState("done");
            });
        }}
      >
        {state === "checking" ? "Checking…" : "Check for updates"}
      </button>
      {message ? <p className="text-xs text-muted-foreground" role="status">{message}</p> : null}
    </div>
  );
}

/**
 * "Continue as ...": the account another computer shares through the synced
 * data folder. Also the way back after signing out of this computer, which
 * turns automatic sign-in off here.
 */
function ContinueFromOtherComputer({ account, onSignedIn }: { account: LocalAccount | null; onSignedIn: (status: HostStatus | undefined) => void }) {
  const id = useId();
  const [offer, setOffer] = useState<SharedSignInOffer | null>(null);
  const [masterPassword, setMasterPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    collabClient
      .sharedSignIn()
      .then((next) => live && setOffer(next))
      .catch(() => live && setOffer({ state: "none" }));
    return () => {
      live = false;
    };
  }, []);

  if (!offer || offer.state === "none") return null;

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!masterPassword) {
      setError("Enter your Libera master password.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await collabClient.unlockSharedSignIn(masterPassword);
      setMasterPassword("");
      const next = await collabClient.sharedSignIn();
      // Unlocking may already have signed in (automatic sign-in was on here).
      if (next.state === "none") onSignedIn(undefined);
      else if (next.state === "locked") setError("Your other computer used a different master password. Sign in with your email and password instead.");
      setOffer(next.state === "locked" ? { state: "none" } : next);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function continueAs() {
    setBusy(true);
    setError("");
    try {
      const next = await collabClient.continueSharedSignIn();
      onSignedIn(next && typeof next === "object" && "connection" in next ? next : undefined);
    } catch (caught) {
      setError(describeError(caught));
      setOffer({ state: "none" });
    } finally {
      setBusy(false);
    }
  }

  const replaces = offer.state === "available" && account && account.id !== offer.accountId;
  return (
    <div aria-label="Sign in from your other computer" className="space-y-2 rounded-xl border border-input p-3" role="group">
      {offer.state === "available" ? (
        <>
          <p className="text-sm">You are signed in to collaboration on another computer.</p>
          <button className={PRIMARY_BUTTON} disabled={busy} type="button" onClick={() => void continueAs()}>
            {busy ? <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <LogIn aria-hidden className="h-3.5 w-3.5" />}
            Continue as {offer.email}
          </button>
          <p className="text-xs text-muted-foreground">
            {offer.serverUrl}
            {replaces ? ` · Replaces ${account.email} on this computer.` : ""} This computer will sign in automatically again.
          </p>
        </>
      ) : (
        <form className="space-y-2" onSubmit={(event) => void unlock(event)}>
          <p className="text-sm">Another computer shares its collaboration sign-in. Enter your Libera master password to use it here.</p>
          <label className={LABEL} htmlFor={`${id}-master`}>
            Libera master password
          </label>
          <input
            autoComplete="current-password"
            className={FIELD}
            id={`${id}-master`}
            type="password"
            value={masterPassword}
            onChange={(event) => setMasterPassword(event.target.value)}
          />
          <button className={SECONDARY_BUTTON} disabled={busy} type="submit">
            {busy ? "Checking…" : "Unlock"}
          </button>
        </form>
      )}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">Or sign in with your email and password below.</p>
    </div>
  );
}

function SignInForm({ account, onSignedIn }: { account: LocalAccount | null; onSignedIn: (status: HostStatus | undefined) => void }) {
  const id = useId();
  const [mode, setMode] = useState<"sign-in" | "register">("sign-in");
  const [serverUrl, setServerUrl] = useState(() => account?.serverUrl || lastServerUrl());
  const [email, setEmail] = useState(account?.email ?? "");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [invitation, setInvitation] = useState("");
  const [registrationCode, setRegistrationCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const reauth = Boolean(account);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = normalizeServerUrl(serverUrl);
    if (!isValidServerUrl(url)) {
      setError("Enter the server address, for example https://collab.example.com.");
      return;
    }
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    if (mode === "register" && !displayName.trim()) {
      setError("Enter the name collaborators will see.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const base = { serverUrl: url, email: email.trim(), password };
      const next =
        mode === "register"
          ? await collabClient.register({ ...base, displayName: displayName.trim(), invitationToken: invitation.trim() || undefined, registrationCode: registrationCode.trim() || undefined })
          : await collabClient.signIn(base);
      rememberServerUrl(url);
      setPassword("");
      onSignedIn(next && typeof next === "object" && "connection" in next ? next : undefined);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form aria-label={mode === "register" ? "Create a collaboration account" : "Sign in"} className="space-y-3" noValidate onSubmit={submit}>
      {reauth ? null : (
        <div aria-label="Account" className="inline-flex rounded-lg border border-input p-0.5" role="group">
          {(["sign-in", "register"] as const).map((value) => (
            <button
              key={value}
              aria-pressed={mode === value}
              className={`rounded-md px-3 py-1 text-sm font-medium ${mode === value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              type="button"
              onClick={() => {
                setMode(value);
                setError("");
              }}
            >
              {value === "sign-in" ? "Sign in" : "Create account"}
            </button>
          ))}
        </div>
      )}
      {reauth ? <p className="text-sm font-medium">Sign in again</p> : null}
      <div>
        <label className={LABEL} htmlFor={`${id}-server`}>
          Server
        </label>
        <input
          autoComplete="url"
          className={FIELD}
          id={`${id}-server`}
          inputMode="url"
          spellCheck={false}
          value={serverUrl}
          onChange={(event) => setServerUrl(event.target.value)}
        />
      </div>
      {mode === "register" ? (
        <div>
          <label className={LABEL} htmlFor={`${id}-name`}>
            Your name
          </label>
          <input autoComplete="name" className={FIELD} id={`${id}-name`} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </div>
      ) : null}
      <div>
        <label className={LABEL} htmlFor={`${id}-email`}>
          Email
        </label>
        <input autoComplete="email" className={FIELD} id={`${id}-email`} type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
      </div>
      <div>
        <label className={LABEL} htmlFor={`${id}-password`}>
          Password
        </label>
        <input
          autoComplete={mode === "register" ? "new-password" : "current-password"}
          className={FIELD}
          id={`${id}-password`}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      {mode === "register" ? (
        <div>
          <label className={LABEL} htmlFor={`${id}-registration`}>
            Registration code <span className="font-normal text-muted-foreground">(from the server administrator)</span>
          </label>
          <input autoComplete="off" className={FIELD} id={`${id}-registration`} spellCheck={false} value={registrationCode} onChange={(event) => setRegistrationCode(event.target.value)} />
          <p className="mt-1 text-xs text-muted-foreground">New accounts need a code unless the server is open to everyone.</p>
        </div>
      ) : null}
      {mode === "register" ? (
        <div>
          <label className={LABEL} htmlFor={`${id}-invitation`}>
            Invitation link or code <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <input className={FIELD} id={`${id}-invitation`} spellCheck={false} value={invitation} onChange={(event) => setInvitation(event.target.value)} />
          <p className="mt-1 text-xs text-muted-foreground">A notebook invitation adds you to that notebook after sign-up.</p>
        </div>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <button className={PRIMARY_BUTTON} disabled={submitting} type="submit">
        {submitting ? <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <LogIn aria-hidden className="h-3.5 w-3.5" />}
        {submitting ? (mode === "register" ? "Creating account…" : "Signing in…") : mode === "register" ? "Create account" : "Sign in"}
      </button>
    </form>
  );
}

function ProfileSection({ account, onSaved }: { account: LocalAccount; onSaved: () => void }) {
  const id = useId();
  const [displayName, setDisplayName] = useState(account.displayName);
  const [color, setColor] = useState(account.color);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const changed = displayName.trim() !== account.displayName || color.toLowerCase() !== account.color.toLowerCase();

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!displayName.trim()) {
      setMessage({ error: true, text: "Your name cannot be empty." });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await collabClient.updateAccount({ displayName: displayName.trim(), color });
      setMessage({ error: false, text: "Saved." });
      onSaved();
    } catch (caught) {
      setMessage({ error: true, text: describeError(caught) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form aria-label="Profile" className="libera-dialog-section space-y-3" onSubmit={save}>
      <div>
        <label className={LABEL} htmlFor={`${id}-name`}>
          Name shown to collaborators
        </label>
        <input className={FIELD} id={`${id}-name`} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
      </div>
      <div>
        <p className={LABEL} id={`${id}-color`}>
          Cursor colour
        </p>
        <div aria-labelledby={`${id}-color`} className="mt-2 flex flex-wrap items-center gap-2" role="radiogroup">
          {COLLAB_COLORS.map((swatch) => {
            const selected = swatch.toLowerCase() === color.toLowerCase();
            return (
              <button
                key={swatch}
                aria-checked={selected}
                aria-label={`Colour ${swatch}`}
                className="flex h-7 w-7 items-center justify-center rounded-full border border-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
                role="radio"
                style={{ backgroundColor: swatch }}
                type="button"
                onClick={() => setColor(swatch)}
              >
                {selected ? <Check aria-hidden className="h-4 w-4 text-white drop-shadow" /> : null}
              </button>
            );
          })}
          <label className="ml-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              aria-label="Custom colour"
              className="h-7 w-9 cursor-pointer rounded border border-input bg-transparent p-0.5"
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#2563eb"}
              onChange={(event) => setColor(event.target.value)}
            />
            Custom
          </label>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button className={PRIMARY_BUTTON} disabled={!changed || saving} type="submit">
          {saving ? "Saving…" : "Save profile"}
        </button>
        {message ? (
          <p className={`text-sm ${message.error ? "text-destructive" : "text-muted-foreground"}`} role={message.error ? "alert" : "status"}>
            {message.text}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function ProjectsSection({ status, onJoin }: { status: HostStatus; onJoin?: () => void }) {
  return (
    <section aria-label="Shared notebooks" className="libera-dialog-section space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Shared notebooks</h3>
        {onJoin ? (
          <button className={SECONDARY_BUTTON} type="button" onClick={onJoin}>
            <Users aria-hidden className="h-3.5 w-3.5" /> Join a shared notebook…
          </button>
        ) : null}
      </div>
      {status.projects.length ? (
        <ul className="divide-y divide-border text-sm">
          {status.projects.map((project) => (
            <li key={project.projectId} className="flex items-center gap-2 py-1.5">
              <Users aria-hidden className={`h-3.5 w-3.5 shrink-0 ${project.revoked ? "text-destructive" : "text-muted-foreground"}`} />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {project.revoked ? "No longer shared" : ROLE_LABEL[project.role]}
                {project.reconcilePending > 0 ? ` · ${project.reconcilePending} to review` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">None yet. Share a notebook from its menu in the Library.</p>
      )}
    </section>
  );
}

function SignOutSection({ onSignedOut }: { onSignedOut: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [everywhere, setEverywhere] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section aria-label="Sign out" className="libera-dialog-section space-y-2">
      {confirming ? (
        <>
          <p className="text-sm">Shared notebooks stay on this device but stop syncing until you sign in again.</p>
          <p className="text-xs text-muted-foreground">
            This computer will not sign in automatically again until you sign in here yourself.
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input checked={everywhere} className="mt-0.5" disabled={busy} type="checkbox" onChange={(event) => setEverywhere(event.target.checked)} />
            <span>
              Also stop automatic sign-in on my other computers
              <span className="block text-xs text-muted-foreground">Computers that are already signed in stay signed in.</span>
            </span>
          </label>
          <div className="flex gap-2">
            <button
              className="inline-flex items-center rounded-lg bg-destructive px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
              disabled={busy}
              type="button"
              onClick={() => {
                setBusy(true);
                setError("");
                collabClient
                  .signOut({ everywhere })
                  .then(() => {
                    setConfirming(false);
                    onSignedOut();
                  })
                  .catch((caught) => setError(describeError(caught)))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "Signing out…" : "Sign out"}
            </button>
            <button className={SECONDARY_BUTTON} type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <button className={SECONDARY_BUTTON} type="button" onClick={() => setConfirming(true)}>
          Sign out of collaboration…
        </button>
      )}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
