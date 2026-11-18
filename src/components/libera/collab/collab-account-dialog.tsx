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
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type { HostConnection, HostStatus, LocalAccount, SharedSignInOffer } from "@/lib/collab/local-api";
import { nudgeHost } from "@/lib/collab/ui/bridge";
import { collabClient } from "@/lib/collab/ui/client";
import { useDescribeError } from "@/lib/collab/ui/use-describe-error";
import { useCollabStatus } from "@/lib/collab/ui/hooks";
import { isValidServerUrl, lastServerUrl, normalizeServerUrl, rememberServerUrl } from "@/lib/collab/ui/server-url";
import { connectionWording, initials, readableTextColor, roleLabel } from "@/lib/collab/ui/wording";
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
  const t = useTranslations("collab.collabAccountDialog");
  const tCommon = useTranslations("common");
  const collab = useCollabStatus();
  const status = collab.status;
  const connection = status?.connection ?? "signed-out";
  const showSignIn = !status?.account || connection === "signed-out" || connection === "needs-sign-in";

  return (
    <ModalDialog
      open={open}
      panelClassName="max-w-xl"
      sectioned
      title={t("title")}
      description={t("description")}
      onClose={onClose}
      footer={
        <button className={SECONDARY_BUTTON} type="button" onClick={onClose}>
          {tCommon("close")}
        </button>
      }
    >
      <div className="space-y-4">
        {collab.phase === "loading" ? (
          <p className="libera-dialog-section flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <LoaderCircle aria-hidden className="h-4 w-4 animate-spin" /> {t("checking")}
          </p>
        ) : collab.phase === "disabled" ? (
          <p className="libera-dialog-section text-sm text-muted-foreground">{t("disabled")}</p>
        ) : collab.phase === "error" && !status ? (
          <div className="libera-dialog-section space-y-2 text-sm" role="alert">
            <p className="text-destructive">{collab.error}</p>
            <button className={SECONDARY_BUTTON} type="button" onClick={() => void collab.refresh()}>
              <RefreshCw aria-hidden className="h-3.5 w-3.5" /> {tCommon("tryAgain")}
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
                {t("gotInvitation")}
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
  const t = useTranslations("collab.collabAccountDialog");
  const tWording = useTranslations("lib.collab.ui.wording");
  const wording = connectionWording(status.connection, tWording);
  const Icon = CONNECTION_ICON[status.connection];
  const account = status.account!;
  return (
    <section aria-label={t("connection")} className="libera-dialog-section space-y-3">
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
      <p className="text-xs text-muted-foreground">{t("pendingCommands", { count: status.pendingCommands })}</p>
      {status.connection === "offline" || status.connection === "connecting" ? (
        <button className={SECONDARY_BUTTON} type="button" onClick={nudgeHost}>
          <RefreshCw aria-hidden className="h-3.5 w-3.5" /> {t("reconnectNow")}
        </button>
      ) : null}
      {status.connection === "update-required" ? <UpdateAction /> : null}
    </section>
  );
}

function UpdateAction() {
  const t = useTranslations("collab.collabAccountDialog");
  const [state, setState] = useState<"idle" | "checking" | "done" | "unsupported">(
    typeof window !== "undefined" && window.liberaUpdater ? "idle" : "unsupported",
  );
  const [message, setMessage] = useState("");
  if (state === "unsupported") {
    return <p className="text-xs text-muted-foreground">{t("installLatest")}</p>;
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
                  ? t("updateReady")
                  : next.status === "up-to-date"
                    ? t("noUpdate")
                    : t("updateDownloading"),
              );
              setState("done");
            })
            .catch(() => {
              setMessage(t("updateCheckFailed"));
              setState("done");
            });
        }}
      >
        {state === "checking" ? t("checkingShort") : t("checkForUpdates")}
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
  const t = useTranslations("collab.collabAccountDialog");
  const describeError = useDescribeError();
  const [offer, setOffer] = useState<SharedSignInOffer | null>(null);
  const [masterPassword, setMasterPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [discoveryError, setDiscoveryError] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (busy) return;
    let live = true;
    let checking = false;
    async function check() {
      if (!live || checking) return;
      checking = true;
      try {
        const next = await collabClient.sharedSignIn();
        if (live) {
          setOffer(next);
          setDiscoveryError("");
        }
      } catch (caught) {
        if (live) setDiscoveryError(describeError(caught));
      } finally {
        checking = false;
      }
    }
    void check();
    const timer = window.setInterval(() => void check(), 15_000);
    const checkAgain = () => void check();
    window.addEventListener("online", checkAgain);
    window.addEventListener("focus", checkAgain);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("online", checkAgain);
      window.removeEventListener("focus", checkAgain);
    };
  }, [busy, refresh, describeError]);

  if (!offer && !discoveryError && !error) return null;

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!masterPassword) {
      setError(t("enterMasterPassword"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await collabClient.unlockSharedSignIn(masterPassword);
      setMasterPassword("");
      const next = await collabClient.sharedSignIn();
      // Unlocking may already have signed in (automatic sign-in was on here).
      if (next.state === "none") {
        const status = await collabClient.status();
        if (status.account && status.connection !== "signed-out" && status.connection !== "needs-sign-in") onSignedIn(status);
        else setError(t("noUsableSignIn"));
      } else if (next.state === "locked") setError(t("differentMasterPassword"));
      setOffer(next.state === "locked" ? { state: "none" } : next);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function continueAs() {
    if (offer?.state !== "available") return;
    setBusy(true);
    setError("");
    try {
      const next = await collabClient.continueSharedSignIn({ accountId: offer.accountId, serverUrl: offer.serverUrl });
      onSignedIn(next && typeof next === "object" && "connection" in next ? next : undefined);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  const replaces = offer?.state === "available" && account && (account.id !== offer.accountId || account.serverUrl !== offer.serverUrl);
  return (
    <div aria-label={t("otherComputer")} className="space-y-2 rounded-xl border border-input p-3" role="group">
      {offer?.state === "available" ? (
        <>
          <p className="text-sm">{t("signedInElsewhere")}</p>
          <button className={PRIMARY_BUTTON} disabled={busy} type="button" onClick={() => void continueAs()}>
            {busy ? <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <LogIn aria-hidden className="h-3.5 w-3.5" />}
            {t("continueAs", { email: offer.email })}
          </button>
          <p className="text-xs text-muted-foreground">
            {t("continueNote", { serverUrl: offer.serverUrl, replaces: replaces ? "yes" : "no", email: account?.email ?? "" })}
          </p>
        </>
      ) : offer?.state === "locked" ? (
        <form className="space-y-2" onSubmit={(event) => void unlock(event)}>
          <p className="text-sm">{t("lockedIntro")}</p>
          <label className={LABEL} htmlFor={`${id}-master`}>
            {t("masterPassword")}
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
            {busy ? t("checkingShort") : t("unlock")}
          </button>
        </form>
      ) : (
        <p className="text-sm">{t("noOtherSignIn")}</p>
      )}
      {error || discoveryError ? (
        <p className="text-sm text-destructive" role="alert">
          {error || discoveryError}
        </p>
      ) : null}
      <button
        className={SECONDARY_BUTTON}
        disabled={busy}
        type="button"
        onClick={() => {
          setError("");
          setRefresh((value) => value + 1);
        }}
      >
        <RefreshCw aria-hidden className="h-3.5 w-3.5" /> {t("checkAgain")}
      </button>
      <p className="text-xs text-muted-foreground">{t("orSignInBelow")}</p>
    </div>
  );
}

function SignInForm({ account, onSignedIn }: { account: LocalAccount | null; onSignedIn: (status: HostStatus | undefined) => void }) {
  const id = useId();
  const t = useTranslations("collab.collabAccountDialog");
  const describeError = useDescribeError();

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
      setError(t("enterServer"));
      return;
    }
    if (!email.trim() || !password) {
      setError(t("enterCredentials"));
      return;
    }
    if (mode === "register" && !displayName.trim()) {
      setError(t("enterName"));
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
    <form aria-label={mode === "register" ? t("createAccountForm") : t("signIn")} className="space-y-3" noValidate onSubmit={submit}>
      {reauth ? null : (
        <div aria-label={t("account")} className="inline-flex rounded-lg border border-input p-0.5" role="group">
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
              {value === "sign-in" ? t("signIn") : t("createAccount")}
            </button>
          ))}
        </div>
      )}
      {reauth ? <p className="text-sm font-medium">{t("signInAgain")}</p> : null}
      <div>
        <label className={LABEL} htmlFor={`${id}-server`}>
          {t("server")}
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
            {t("yourName")}
          </label>
          <input autoComplete="name" className={FIELD} id={`${id}-name`} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </div>
      ) : null}
      <div>
        <label className={LABEL} htmlFor={`${id}-email`}>
          {t("email")}
        </label>
        <input autoComplete="email" className={FIELD} id={`${id}-email`} type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
      </div>
      <div>
        <label className={LABEL} htmlFor={`${id}-password`}>
          {t("password")}
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
            {t.rich("registrationCode", { hint: (chunks) => <span className="font-normal text-muted-foreground">{chunks}</span> })}
          </label>
          <input autoComplete="off" className={FIELD} id={`${id}-registration`} spellCheck={false} value={registrationCode} onChange={(event) => setRegistrationCode(event.target.value)} />
          <p className="mt-1 text-xs text-muted-foreground">{t("registrationHint")}</p>
        </div>
      ) : null}
      {mode === "register" ? (
        <div>
          <label className={LABEL} htmlFor={`${id}-invitation`}>
            {t.rich("invitationOptional", { hint: (chunks) => <span className="font-normal text-muted-foreground">{chunks}</span> })}
          </label>
          <input className={FIELD} id={`${id}-invitation`} spellCheck={false} value={invitation} onChange={(event) => setInvitation(event.target.value)} />
          <p className="mt-1 text-xs text-muted-foreground">{t("invitationHint")}</p>
        </div>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <button className={PRIMARY_BUTTON} disabled={submitting} type="submit">
        {submitting ? <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <LogIn aria-hidden className="h-3.5 w-3.5" />}
        {submitting ? (mode === "register" ? t("creatingAccount") : t("signingIn")) : mode === "register" ? t("createAccount") : t("signIn")}
      </button>
    </form>
  );
}

function ProfileSection({ account, onSaved }: { account: LocalAccount; onSaved: () => void }) {
  const id = useId();
  const t = useTranslations("collab.collabAccountDialog");
  const tCommon = useTranslations("common");
  const describeError = useDescribeError();

  const [displayName, setDisplayName] = useState(account.displayName);
  const [color, setColor] = useState(account.color);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const changed = displayName.trim() !== account.displayName || color.toLowerCase() !== account.color.toLowerCase();

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!displayName.trim()) {
      setMessage({ error: true, text: t("nameEmpty") });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await collabClient.updateAccount({ displayName: displayName.trim(), color });
      setMessage({ error: false, text: t("saved") });
      onSaved();
    } catch (caught) {
      setMessage({ error: true, text: describeError(caught) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form aria-label={t("profile")} className="libera-dialog-section space-y-3" onSubmit={save}>
      <div>
        <label className={LABEL} htmlFor={`${id}-name`}>
          {t("nameShown")}
        </label>
        <input className={FIELD} id={`${id}-name`} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
      </div>
      <div>
        <p className={LABEL} id={`${id}-color`}>
          {t("cursorColour")}
        </p>
        <div aria-labelledby={`${id}-color`} className="mt-2 flex flex-wrap items-center gap-2" role="radiogroup">
          {COLLAB_COLORS.map((swatch) => {
            const selected = swatch.toLowerCase() === color.toLowerCase();
            return (
              <button
                key={swatch}
                aria-checked={selected}
                aria-label={t("colour", { value: swatch })}
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
              aria-label={t("customColour")}
              className="h-7 w-9 cursor-pointer rounded border border-input bg-transparent p-0.5"
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#2563eb"}
              onChange={(event) => setColor(event.target.value)}
            />
            {t("custom")}
          </label>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button className={PRIMARY_BUTTON} disabled={!changed || saving} type="submit">
          {saving ? tCommon("saving") : t("saveProfile")}
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
  const t = useTranslations("collab.collabAccountDialog");
  const tWording = useTranslations("lib.collab.ui.wording");
  return (
    <section aria-label={t("sharedNotebooks")} className="libera-dialog-section space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t("sharedNotebooksAndAlbums")}</h3>
        {onJoin ? (
          <button className={SECONDARY_BUTTON} type="button" onClick={onJoin}>
            <Users aria-hidden className="h-3.5 w-3.5" /> {t("joinWithInvitation")}
          </button>
        ) : null}
      </div>
      {status.projects.length ? (
        <ul className="divide-y divide-border text-sm">
          {status.projects.map((project) => (
            <li key={project.projectId} className="flex items-center gap-2 py-1.5">
              <Users aria-hidden className={`h-3.5 w-3.5 shrink-0 ${project.revoked ? "text-destructive" : "text-muted-foreground"}`} />
              <span className="min-w-0 flex-1 truncate">{project.kind === "album" ? <span className="text-muted-foreground">{t("albumPrefix")}</span> : null}{project.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {project.revoked ? t("noLongerShared") : roleLabel(project.role, tWording, project.kind === "album")}
                {project.reconcilePending > 0 ? t("toReview", { count: project.reconcilePending }) : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t("noneYet")}</p>
      )}
    </section>
  );
}

function SignOutSection({ onSignedOut }: { onSignedOut: () => void }) {
  const t = useTranslations("collab.collabAccountDialog");
  const tCommon = useTranslations("common");
  const describeError = useDescribeError();
  const [confirming, setConfirming] = useState(false);
  const [everywhere, setEverywhere] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section aria-label={t("signOutSection")} className="libera-dialog-section space-y-2">
      {confirming ? (
        <>
          <p className="text-sm">{t("signOutNote")}</p>
          <p className="text-xs text-muted-foreground">
            {t("signOutAuto")}
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input checked={everywhere} className="mt-0.5" disabled={busy} type="checkbox" onChange={(event) => setEverywhere(event.target.checked)} />
            <span>
              {t("everywhere")}
              <span className="block text-xs text-muted-foreground">{t("everywhereNote")}</span>
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
              {busy ? t("signingOut") : t("signOut")}
            </button>
            <button className={SECONDARY_BUTTON} type="button" onClick={() => setConfirming(false)}>
              {tCommon("cancel")}
            </button>
          </div>
        </>
      ) : (
        <button className={SECONDARY_BUTTON} type="button" onClick={() => setConfirming(true)}>
          {t("signOutOpen")}
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
