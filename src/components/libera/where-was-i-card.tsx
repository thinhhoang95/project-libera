"use client";

import { History, Pencil, Plus, RefreshCw, RotateCcw, Sparkles, Users, X } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { apiRequest } from "@/components/libera/api-client";
import { FileTypeIcon } from "@/components/libera/file-type";
import type { LiberaFileNode, LiberaNotebookNode } from "@/lib/types";
import { changesSinceSession, type RecapFileEntry, type RecapSummary, type RecapView } from "@/lib/where-was-i";
import { whereWasITracker } from "./where-was-i-tracker";
import styles from "./where-was-i.module.css";

// The notebook home's "Where you left off" card: the AI recap of the last
// session, the files it touched, and what changed since (a collaborator's
// edits, or another computer's in a synced folder).

const MAX_TRAIL_FILES = 6;
const MAX_AWAY_FILES = 5;
/** Saves still landing while the app quit are not changes made "while you were away". */
const AWAY_TOLERANCE_MS = 60_000;

// Per window: a summary is requested at most once per session (its result
// outlives the card, which remounts as tabs open and close), and a dismissed
// card stays hidden until the app restarts.
type SummaryRequest = { status: "loading" | "failed" } | { status: "done"; summary: RecapSummary };
const summaryRequests = new Map<string, SummaryRequest>();
const summaryListeners = new Set<() => void>();
const dismissed = new Set<string>();

function setSummaryRequest(key: string, request: SummaryRequest) {
  summaryRequests.set(key, request);
  for (const listener of summaryListeners) listener();
}

function requestSummary(notebook: string, sessionId: string, force = false) {
  const key = `${notebook}\0${sessionId}`;
  if (!force && summaryRequests.has(key)) return;
  setSummaryRequest(key, { status: "loading" });
  apiRequest<{ summary: RecapSummary }>("/api/where-was-i", {
    method: "POST",
    body: JSON.stringify({ notebook, sessionId, ...(force ? { retry: true } : {}) }),
  })
    .then(({ summary }) => setSummaryRequest(key, { status: "done", summary }))
    .catch(() => setSummaryRequest(key, { status: "failed" }));
}

function relativeTime(value: string) {
  const seconds = (new Date(value).getTime() - Date.now()) / 1000;
  // English, like the rest of the card.
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [["day", 86_400], ["hour", 3_600], ["minute", 60]];
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return "just now";
}

function sessionLength(startedAt: string, endedAt: string) {
  const minutes = Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "";
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60 ? `${minutes % 60} min` : ""}`.trim();
}

function changeLabel(entry: RecapFileEntry) {
  if (entry.created) return "New";
  if (!entry.edited) return "Viewed";
  if (entry.by === "others") return "Collaborators";
  return "Edited";
}

function cropPreview(entry: RecapFileEntry) {
  if (entry.unopened) return `${entry.path}\n\nAdded during the session`;
  const crop = entry.crops?.find((item) => item.added) ?? entry.crops?.[0];
  const text = crop?.added ?? (crop?.removed ? `Removed: ${crop.removed}` : "");
  return text ? `${entry.path}\n\n${text}` : entry.path;
}

export function WhereWasICard({
  notebook,
  files,
  onOpenFile,
}: {
  notebook: LiberaNotebookNode;
  files: LiberaFileNode[];
  onOpenFile: (file: LiberaFileNode) => void;
}) {
  const [view, setView] = useState<{ notebook: string; value: RecapView } | null>(null);
  const [, setRenders] = useState(0);
  const hidden = dismissed.has(notebook.name);

  useEffect(() => {
    const listener = () => setRenders((count) => count + 1);
    summaryListeners.add(listener);
    return () => { summaryListeners.delete(listener); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const refresh = () => {
      const requestGeneration = ++generation;
      const query = new URLSearchParams({ notebook: notebook.name, session: whereWasITracker.sessionId });
      apiRequest<RecapView>(`/api/where-was-i?${query}`)
        .then((value) => {
          if (cancelled || generation !== requestGeneration) return;
          setView({ notebook: notebook.name, value });
          // Returning from Preferences picks up opt-outs and model settings.
          if (!dismissed.has(notebook.name) && !value.disabled && value.summariesEnabled && value.session && !value.summary) requestSummary(notebook.name, value.session.id);
        })
        .catch(() => { if (!cancelled && generation === requestGeneration) setView(null); });
    };
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [notebook.name]);

  const current = view?.notebook === notebook.name ? view.value : null;
  const session = current?.session ?? null;
  const request = session ? summaryRequests.get(`${notebook.name}\0${session.id}`) : undefined;

  const filesByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const trail = useMemo(() => (session?.files ?? [])
    .map((entry) => ({ entry, file: filesByPath.get(`${notebook.name}/${entry.path}`) }))
    .filter((item): item is { entry: RecapFileEntry; file: LiberaFileNode } => !!item.file)
    .slice(0, MAX_TRAIL_FILES), [session, filesByPath, notebook.name]);
  const away = useMemo(() => {
    if (!session) return [];
    const touched = whereWasITracker.touchedPaths(notebook.name);
    return changesSinceSession(files, notebook.name, session, { toleranceMs: AWAY_TOLERANCE_MS, exclude: touched }).slice(0, MAX_AWAY_FILES);
  }, [session, files, notebook.name]);

  if (!current || current.disabled || !session || hidden || (!trail.length && !away.length)) return null;

  const length = sessionLength(session.startedAt, session.endedAt);
  const editedCount = session.files.filter((entry) => entry.edited).length;
  const summary = request?.status === "done" ? request.summary : current.summary;
  const bullets = summary?.sessionId === session.id ? summary.bullets : [];
  // Until the request starts, an enabled summary is shown as on its way.
  const status = current.summariesEnabled ? request?.status ?? "loading" : "off";

  return (
    <section
      className={styles.recap}
      aria-labelledby="where-was-i-title"
      style={{ "--recap-accent": notebook.color } as CSSProperties}
    >
      <header className={styles.header}>
        <span className={styles.badge} aria-hidden><History size={18} /></span>
        <div className={styles.heading}>
          <h3 id="where-was-i-title">Where you left off</h3>
          <p>
            <time dateTime={session.endedAt} title={new Date(session.endedAt).toLocaleString()}>{relativeTime(session.endedAt)}</time>
            {length ? <><span aria-hidden>·</span>{length}</> : null}
            {editedCount ? <><span aria-hidden>·</span>{editedCount} {editedCount === 1 ? "file" : "files"} edited</> : null}
            {current.deviceName ? <><span aria-hidden>·</span>on {current.deviceName}</> : null}
          </p>
        </div>
        <button
          className={styles.dismiss}
          type="button"
          aria-label="Hide where you left off"
          title="Hide until Libera restarts"
          onClick={() => { dismissed.add(notebook.name); setRenders((count) => count + 1); }}
        >
          <X size={15} />
        </button>
      </header>

      <div className={styles.body}>
        <div className={styles.summary} aria-live="polite">
          {bullets.length ? (
            <ul className={styles.bullets}>
              {bullets.map((bullet, index) => <li key={index}>{bullet}</li>)}
            </ul>
          ) : status === "loading" ? (
            <div className={styles.skeleton} aria-label="Summarizing your last session">
              <span /><span /><span />
            </div>
          ) : status === "failed" ? (
            <p className={styles.notice}>
              Couldn’t summarize your last session.
              <button type="button" onClick={() => requestSummary(notebook.name, session.id, true)}><RotateCcw size={13} aria-hidden /> Try again</button>
            </p>
          ) : status === "off" ? (
            <p className={styles.notice}>
              <Sparkles size={14} aria-hidden /> Turn on AI summaries in Preferences → AI → Where Was I to see a short recap here.
            </p>
          ) : null}
        </div>

        {trail.length ? (
          <ul className={styles.trail} aria-label="Files from your last session">
            {trail.map(({ entry, file }) => (
              <li key={entry.path}>
                <button type="button" title={cropPreview(entry)} onClick={() => onOpenFile(file)}>
                  <span className={styles.fileIcon}><FileTypeIcon fileType={file.fileType} name={file.name} /></span>
                  <span className={styles.fileName}>{file.name}</span>
                  <span className={styles.state} data-state={entry.created ? "new" : entry.edited ? entry.by ?? "you" : "viewed"}>
                    {entry.created ? <Plus size={10} aria-hidden /> : entry.edited && entry.by !== "others" ? <Pencil size={10} aria-hidden /> : null}
                    {changeLabel(entry)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {away.length ? (
        <footer className={styles.away}>
          <span className={styles.awayLabel}>
            {current.shared ? <Users size={14} aria-hidden /> : <RefreshCw size={13} aria-hidden />}
            {current.shared ? "Updated by collaborators since" : "Changed since"} you left
          </span>
          <ul>
            {away.map(({ file, kind, at }) => (
              <li key={file.path}>
                <button type="button" title={`${file.path}\n${kind === "new" ? "Added" : "Updated"} ${new Date(at).toLocaleString()}`} onClick={() => onOpenFile(file)}>
                  <span className={styles.fileIcon}><FileTypeIcon fileType={file.fileType} name={file.name} /></span>
                  <span className={styles.fileName}>{file.name}</span>
                  {kind === "new" ? <span className={styles.state} data-state="new">New</span> : null}
                  <time dateTime={at}>{relativeTime(at)}</time>
                </button>
              </li>
            ))}
          </ul>
        </footer>
      ) : null}
    </section>
  );
}
