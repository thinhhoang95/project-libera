"use client";

import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  AudioLines,
  Check,
  ChevronRight,
  ChevronsDown,
  Copy,
  Cpu,
  Download,
  FilePlus2,
  FileText,
  Globe,
  Link2,
  Loader2,
  MessageSquareQuote,
  MoreVertical,
  Pencil,
  Languages,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EditableLine, useFlushWhenEditingEnds, type LineFocus, type SegmentDraft } from "@/components/libera/audio/editable-lines";
import { RailSection, RailSwitch, railIconButton, railStyles } from "@/components/libera/audio/rail-ui";
import { speakerColor, speakerInitials } from "@/components/libera/audio/speaker-colors";
import { formatBytesIn, formatDurationIn } from "@/components/libera/audio/media-format";
import { transcriptionLanguageChoices } from "@/lib/transcription/languages";
import { isJobActive, useTranscriptionSetup, type StartTranscriptionOptions, type useTranscript } from "@/components/libera/audio/use-voice-memo";
import { encodeFilePath } from "@/components/libera/api-client";
import { CHAT_QUOTE_EVENT, type ChatQuoteDetail } from "@/lib/document-chat";
import { findTermRanges } from "@/lib/global-search";
import {
  formatClock,
  parseTranscriptQuery,
  segmentIndexAt,
  speakerName,
  transcriptLine,
  transcriptToMarkdown,
  transcriptToSrt,
  transcriptToText,
  transcriptToVtt,
} from "@/lib/transcription/format";
import type { Transcript, TranscriptionJob, TranscriptionSetupStatus, TranscriptSegment } from "@/lib/transcription/types";

/**
 * A voice memo's transcript. The page shows it as a document the reader can
 * correct (TranscriptDocument); its tools, from transcribing to exporting
 * and naming speakers, are in the Voice Memo rail tab (TranscriptControls).
 */

export type TranscriptState = ReturnType<typeof useTranscript>;

const FOLLOW_PAUSE_MS = 5000;
const NO_RANGES: Array<[number, number]> = [];

type Translate = ReturnType<typeof useTranslations>;

function jobLabel(job: TranscriptionJob, t: Translate) {
  return job.state === "transcribing" && job.total ? t("transcribingPart", { current: Math.min(job.done + 1, job.total), total: job.total }) : t(`stage.${job.state}`);
}

export function openSpeechPreferences() {
  void window.liberaPreferences?.open("speech");
}

const SAVE_FORMATS = {
  md: { type: "text/markdown" },
  txt: { type: "text/plain" },
  srt: { type: "application/x-subrip" },
  vtt: { type: "text/vtt" },
} as const;
type SaveFormat = keyof typeof SAVE_FORMATS;

/** A Save dialog in the desktop app; a download in a browser. */
async function saveText(name: string, text: string, format: SaveFormat, filterName: string) {
  const { type } = SAVE_FORMATS[format];
  const save = window.liberaExport?.saveTextFile;
  if (save) {
    await save({ content: text, fileName: name, filterName, extensions: [format] });
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The transcript lines a text selection covers, each with its time and speaker. */
function selectedTranscriptLines(list: HTMLElement, transcript: Transcript, segments: TranscriptSegment[]) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
  const range = selection.getRangeAt(0);
  if (!list.contains(range.commonAncestorContainer)) return "";
  const lines: string[] = [];
  for (const row of list.querySelectorAll<HTMLElement>("[data-segment]")) {
    if (!range.intersectsNode(row)) continue;
    const textElement = row.querySelector("[role='textbox']");
    const segment = segments[Number(row.dataset.segment)];
    if (!textElement || !segment) continue;
    const part = document.createRange();
    part.selectNodeContents(textElement);
    if (textElement.contains(range.startContainer)) part.setStart(range.startContainer, range.startOffset);
    if (textElement.contains(range.endContainer)) part.setEnd(range.endContainer, range.endOffset);
    const text = part.toString().replace(/\s+/g, " ").trim();
    if (text) lines.push(transcriptLine(transcript, segment, text));
  }
  return lines.join("\n");
}

/** Text with the find box's matches marked; `activeMatch` is the index (within this text) of the current one. */
function Marked({ text, ranges, activeMatch }: { text: string; ranges: Array<[number, number]>; activeMatch: number }) {
  const parts: ReactNode[] = [];
  let position = 0;
  ranges.forEach(([start, end], index) => {
    if (start > position) parts.push(text.slice(position, start));
    parts.push(
      <mark key={start} data-active={index === activeMatch || undefined} className="rounded-[3px] bg-[var(--markdown-editor-find-match)] px-px text-inherit data-[active]:bg-[var(--markdown-editor-find-match-active)] data-[active]:outline data-[active]:outline-1 data-[active]:outline-[var(--markdown-editor-find-match-active-ring)]">
        {text.slice(start, end)}
      </mark>,
    );
    position = end;
  });
  if (position < text.length) parts.push(text.slice(position));
  return <>{parts}</>;
}

type LineActions = Pick<SegmentDraft, "type" | "commit" | "split" | "joinPrevious" | "joinNext" | "move">;

const SegmentRow = memo(function SegmentRow({
  segment,
  index,
  name,
  showSpeaker,
  active,
  ranges,
  activeMatch,
  matched,
  focus,
  joinsPrevious,
  lines,
  onSeek,
  onQuote,
  onCopyLink,
}: {
  segment: TranscriptSegment;
  index: number;
  name: string;
  showSpeaker: boolean;
  active: boolean;
  ranges: Array<[number, number]>;
  activeMatch: number;
  /** The current search result, when the search finds whole passages (a `speaker:` filter alone). */
  matched: boolean;
  focus: LineFocus | null;
  /** Whether the passage before is shown, so Backspace at the start may join it. */
  joinsPrevious: boolean;
  lines: LineActions;
  onSeek: (time: number, play?: boolean) => void;
  onQuote: (index: number) => void;
  onCopyLink: (index: number) => void;
}) {
  const t = useTranslations("audio.transcriptPanel");
  const color = speakerColor(segment.speaker);
  return (
    <div
      data-segment={index}
      className={`group relative rounded-lg pr-3 transition-colors ${showSpeaker ? "mt-4 pt-2" : "pt-0.5"} pb-1 ${active ? "bg-[color-mix(in_srgb,var(--accent)_9%,transparent)]" : "hover:bg-muted/50 focus-within:bg-muted/40"} ${matched ? "outline outline-1 outline-[var(--markdown-editor-find-match-active-ring)]" : ""}`}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 56px" }}
    >
      {showSpeaker && name ? (
        <div className="mb-1 ml-[3.75rem] flex items-center gap-2">
          <span aria-hidden className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-white" style={{ background: color }}>
            {speakerInitials(name)}
          </span>
          <span className="text-[12.5px] font-semibold" style={{ color }}>{name}</span>
        </div>
      ) : null}
      <div className="flex items-start gap-2">
        <div className="flex w-14 shrink-0 flex-col items-end gap-0.5 pt-[3px]">
          <button
            type="button"
            className={`rounded px-1 font-mono text-[11px] tabular-nums transition-colors ${active ? "text-accent" : "text-muted-foreground hover:text-foreground"}`}
            title={t("playFromHere")}
            onClick={() => onSeek(segment.start, true)}
          >
            {formatClock(segment.start)}
          </button>
          <span className="hidden items-center gap-0.5 group-hover:flex">
            <button type="button" className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={t("quoteInChat")} title={t("quoteInChat")} onClick={() => onQuote(index)}>
              <MessageSquareQuote aria-hidden className="h-3 w-3" />
            </button>
            <button type="button" className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={t("copyLinkLabel")} title={t("copyLinkTitle")} onClick={() => onCopyLink(index)}>
              <Link2 aria-hidden className="h-3 w-3" />
            </button>
          </span>
        </div>
        <EditableLine
          text={segment.text}
          label={t("passageAt", { time: formatClock(segment.start) })}
          placeholder={t("typeHere")}
          className={`flex-1 py-px text-[15px] leading-[1.65] ${active ? "text-foreground" : "text-foreground/85"}`}
          focus={focus}
          onType={(text) => lines.type(index, text)}
          onCommit={(text) => lines.commit(index, text)}
          onSplit={(text, offset) => lines.split(index, text, offset)}
          onJoinPrevious={joinsPrevious ? (text) => lines.joinPrevious(index, text) : undefined}
          onJoinNext={(text) => lines.joinNext(index, text)}
          onMove={(direction) => lines.move(index, direction)}
        >
          {ranges.length ? <Marked text={segment.text} ranges={ranges} activeMatch={activeMatch} /> : undefined}
        </EditableLine>
      </div>
    </div>
  );
});

function ProgressBar({ value, indeterminate }: { value: number; indeterminate?: boolean }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={`h-full rounded-full bg-accent transition-[width] duration-500 ${indeterminate ? "w-1/3 animate-pulse" : ""}`}
        style={indeterminate ? undefined : { width: `${Math.max(2, Math.min(100, value * 100))}%` }}
      />
    </div>
  );
}

function Notice({ children, action, tone }: { children: ReactNode; action?: ReactNode; tone?: "error" }) {
  return (
    <div className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs leading-5 ${tone === "error" ? "bg-destructive-muted text-destructive" : "bg-muted/70 text-muted-foreground"}`}>
      <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{children}{action ? <> {action}</> : null}</span>
    </div>
  );
}

/**
 * The transcript as the page shows it: a find box, and the passages, which
 * the reader can correct in place. The corrections are saved when the
 * editing ends (see editable-lines.tsx).
 */
export function TranscriptDocument({
  path,
  fileName,
  state,
  draft,
  speakerFilter,
  currentTime,
  onSeek,
  onSearchMatches,
  searchFocusNonce,
  follow,
  onFollowChange,
  onShowControls,
}: {
  path: string;
  fileName: string;
  state: TranscriptState;
  draft: SegmentDraft;
  speakerFilter: number | null;
  currentTime: number;
  onSeek: (time: number, play?: boolean) => void;
  /** Times of the find box's matches, for the waveform. */
  onSearchMatches: (times: number[]) => void;
  searchFocusNonce: number;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  /** Opens the Voice Memo rail tab, where transcribing starts. */
  onShowControls: () => void;
}) {
  const t = useTranslations("audio.transcriptPanel");
  const format = useFormatter();
  const { payload } = state;
  const transcript = payload?.transcript ?? null;
  const job = payload?.job ?? null;
  const active = isJobActive(job);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [jumpVisible, setJumpVisible] = useState(false);
  const [notice, setNotice] = useState("");
  const [selectionQuote, setSelectionQuote] = useState<{ top: number; left: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const userScrollAt = useRef(0);
  const onLeaveLines = useFlushWhenEditingEnds(draft.flush);
  const lines: LineActions = useMemo(
    () => ({ type: draft.type, commit: draft.commit, split: draft.split, joinPrevious: draft.joinPrevious, joinNext: draft.joinNext, move: draft.move }),
    [draft.type, draft.commit, draft.split, draft.joinPrevious, draft.joinNext, draft.move],
  );

  useEffect(() => {
    if (searchFocusNonce) {
      searchRef.current?.focus();
      searchRef.current?.select();
    }
  }, [searchFocusNonce]);

  const segments = draft.segments;
  const parsed = useMemo(() => parseTranscriptQuery(query, transcript?.speakers ?? []), [query, transcript?.speakers]);
  const visible = useMemo(
    () => segments.map((segment, index) => ({ segment, index })).filter(({ segment }) =>
      (speakerFilter === null || segment.speaker === speakerFilter) &&
      (parsed.speakers === null || (segment.speaker !== null && parsed.speakers.includes(segment.speaker)))),
    [parsed.speakers, segments, speakerFilter],
  );

  // Every match of the find box, in reading order, with the segment it is in.
  // `speaker:` alone matches each of that speaker's passages (offset -1).
  const search = useMemo(() => {
    const needle = parsed.text;
    const bySegment = new Map<number, Array<[number, number]>>();
    const matches: Array<{ segment: number; offset: number }> = [];
    if (!needle) {
      if (parsed.speakers !== null) for (const { index } of visible) matches.push({ segment: index, offset: -1 });
      return { bySegment, matches };
    }
    for (const { segment, index } of visible) {
      const ranges = findTermRanges(segment.text, [needle]);
      if (!ranges.length) continue;
      bySegment.set(index, ranges);
      ranges.forEach((_, offset) => matches.push({ segment: index, offset }));
    }
    return { bySegment, matches };
  }, [parsed, visible]);

  // `speaker:` being typed: suggest the names.
  const speakerSuggestion = useMemo(() => {
    const match = /(?:^|\s)speaker:("?)([^"\s]*)$/i.exec(query);
    if (!match || !transcript) return null;
    const typed = match[2].toLowerCase();
    const names = transcript.speakers.map((speaker) => speaker.name).filter((name) => name.toLowerCase().startsWith(typed));
    return names.length ? { names, start: query.length - match[0].trimStart().length } : null;
  }, [query, transcript]);

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? "" : current)), 1800);
  }, []);

  const quote = useCallback((text: string) => {
    if (!text.trim()) return;
    window.dispatchEvent(new CustomEvent<ChatQuoteDetail>(CHAT_QUOTE_EVENT, { detail: { path, name: fileName, text } }));
    flash(t("quotedInChat"));
  }, [fileName, flash, path, t]);

  const quoteSegment = useCallback((index: number) => {
    const segment = segments[index];
    if (transcript && segment) quote(transcriptLine(transcript, segment));
  }, [quote, segments, transcript]);

  const quoteSelection = useCallback(() => {
    const list = listRef.current;
    if (!list || !transcript) return false;
    const text = selectedTranscriptLines(list, transcript, segments);
    if (!text) return false;
    quote(text);
    window.getSelection()?.removeAllRanges();
    setSelectionQuote(null);
    return true;
  }, [quote, segments, transcript]);

  const copyLink = useCallback(async (index: number) => {
    const segment = segments[index];
    if (!segment) return;
    const title = fileName.replace(/\.[^.]+$/, "");
    // A library path: it resolves from any note, and `#t=` opens the recording at that moment.
    await navigator.clipboard.writeText(`[${title} · ${formatClock(segment.start)}](${encodeFilePath(path)}#t=${Math.floor(segment.start)})`);
    flash(t("linkCopied"));
  }, [fileName, flash, path, segments, t]);

  const copyLinkAt = useCallback((index: number) => void copyLink(index), [copyLink]);

  // ⌘/Ctrl+Shift+L quotes the selected lines, as it adds selected paragraphs elsewhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.code !== "KeyL") return;
      if (quoteSelection()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [quoteSelection]);

  // A floating "Quote" button over a selection in the transcript.
  const onListMouseUp = () => {
    const list = listRef.current;
    const selection = window.getSelection();
    if (!list || !selection || selection.isCollapsed || !selection.rangeCount || !list.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      setSelectionQuote(null);
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const box = list.getBoundingClientRect();
    setSelectionQuote({ top: rect.top - box.top + list.scrollTop - 34, left: Math.max(8, Math.min(box.width - 140, rect.left - box.left + rect.width / 2 - 60)) });
  };

  const current = search.matches.length ? search.matches[Math.min(matchIndex, search.matches.length - 1)] : null;

  useEffect(() => {
    const times = [...new Set(search.matches.map((match) => match.segment))].map((index) => segments[index].start);
    onSearchMatches(times);
  }, [onSearchMatches, search.matches, segments]);

  useEffect(() => () => onSearchMatches([]), [onSearchMatches]);

  const scrollToSegment = useCallback((index: number, behavior: ScrollBehavior = "smooth") => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-segment="${index}"]`);
    row?.scrollIntoView({ block: "center", behavior });
  }, []);

  useEffect(() => {
    if (current) scrollToSegment(current.segment);
  }, [current, scrollToSegment]);

  const activeIndex = segmentIndexAt(segments, currentTime);
  const activeVisible = activeIndex >= 0 && (speakerFilter === null || segments[activeIndex]?.speaker === speakerFilter);

  // Keep the segment being played in view, unless the reader has scrolled away to look at something or is typing.
  useLayoutEffect(() => {
    if (!follow || activeIndex < 0 || !activeVisible || current) return;
    if (Date.now() - userScrollAt.current < FOLLOW_PAUSE_MS) return;
    const list = listRef.current;
    if (!list || list.contains(document.activeElement)) return;
    const row = list.querySelector<HTMLElement>(`[data-segment="${activeIndex}"]`);
    if (!row) return;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top < listRect.top + 40 || rowRect.bottom > listRect.bottom - 40) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [activeIndex, activeVisible, current, follow]);

  const onUserScroll = useCallback(() => {
    userScrollAt.current = Date.now();
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-segment="${activeIndex}"]`);
    if (!list || !row) return setJumpVisible(false);
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    setJumpVisible(rowRect.bottom < listRect.top || rowRect.top > listRect.bottom);
  }, [activeIndex]);

  const stepMatch = (direction: 1 | -1) => {
    if (!search.matches.length) return;
    setMatchIndex((index) => (index + direction + search.matches.length) % search.matches.length);
  };

  if (!payload) {
    return <div className="flex flex-1 items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 aria-hidden className="h-4 w-4 animate-spin" /> {t("loadingTranscript")}</div>;
  }

  if (active && job) {
    return (
      <div className="flex flex-1 items-start justify-center px-6 pt-10">
        <div className="w-full max-w-sm space-y-2.5 text-center">
          <p className="text-sm font-medium">{t("jobLabelEllipsis", { label: jobLabel(job, t) })}</p>
          <ProgressBar value={job.progress} indeterminate={job.state === "queued"} />
          <p className="text-xs text-muted-foreground">{t("jobProgress", { percent: format.number(job.progress, { style: "percent", maximumFractionDigits: 0 }) })}</p>
        </div>
      </div>
    );
  }

  if (!transcript) {
    return (
      <div className="flex flex-1 items-start justify-center px-6 pt-10">
        <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-accent"><AudioLines aria-hidden className="h-5 w-5" /></span>
          <div>
            <p className="text-sm font-medium">{job?.state === "error" ? t("transcriptionFailed") : t("noTranscriptYet")}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {job?.state === "error" ? job.error : t("transcriptDescription")}
            </p>
          </div>
          <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90" onClick={onShowControls}>
            <AudioLines aria-hidden className="h-4 w-4" /> {t("transcribeEllipsis")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mx-auto w-full max-w-3xl space-y-2 px-4 pb-2 pt-1 sm:px-8">
        <div className="flex items-center gap-3">
          <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-input bg-background px-2 focus-within:ring-2 focus-within:ring-ring">
            <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              type="search"
              aria-label={t("findLabel")}
              placeholder={t("findPlaceholder")}
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setMatchIndex(0);
              }}
              title={t("findTitle")}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  stepMatch(event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey) ? -1 : 1);
                } else if (event.key === "Escape" && query) {
                  event.stopPropagation();
                  setQuery("");
                  setMatchIndex(0);
                }
              }}
            />
            {query ? (
              <>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{search.matches.length ? t("matchPosition", { current: Math.min(matchIndex, search.matches.length - 1) + 1, total: search.matches.length }) : parsed.unknown.length ? t("noSuchSpeaker") : t("noMatches")}</span>
                <button type="button" className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-muted disabled:opacity-40" aria-label={t("previousMatch")} disabled={!search.matches.length} onClick={() => stepMatch(-1)}><ArrowUp aria-hidden className="h-3 w-3" /></button>
                <button type="button" className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-muted disabled:opacity-40" aria-label={t("nextMatch")} disabled={!search.matches.length} onClick={() => stepMatch(1)}><ArrowDown aria-hidden className="h-3 w-3" /></button>
                <button type="button" className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-muted" aria-label={t("clear")} onClick={() => { setQuery(""); setMatchIndex(0); }}><X aria-hidden className="h-3 w-3" /></button>
              </>
            ) : null}
          </div>
          <span className="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground sm:inline-flex" aria-live="polite">
            <Pencil aria-hidden className="h-3 w-3" />
            {draft.edited ? t("editingSaved") : t("clickToCorrect")}
          </span>
        </div>
        {speakerSuggestion ? (
          <div className="flex flex-wrap items-center gap-1 text-[11px]">
            <span className="text-muted-foreground">{t("speakerLabel")}</span>
            {speakerSuggestion.names.map((name) => (
              <button
                key={name}
                type="button"
                className="rounded-full bg-muted px-2 py-0.5 hover:bg-foreground hover:text-background"
                onClick={() => {
                  const value = /\s/.test(name) ? `"${name}"` : name;
                  setQuery(`${query.slice(0, speakerSuggestion.start)}speaker:${value} `);
                  setMatchIndex(0);
                  searchRef.current?.focus();
                }}
              >
                {name}
              </button>
            ))}
          </div>
        ) : null}
        {state.error ? <Notice tone="error">{state.error}</Notice> : null}
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={listRef} className="relative h-full overflow-y-auto" onWheel={onUserScroll} onTouchMove={onUserScroll} onMouseUp={onListMouseUp} onScroll={() => { if (Date.now() - userScrollAt.current < 200) onUserScroll(); }}>
          {selectionQuote ? (
            <button
              type="button"
              className="absolute z-20 inline-flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background shadow-lg"
              style={{ top: Math.max(0, selectionQuote.top), left: selectionQuote.left }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => quoteSelection()}
            >
              <MessageSquareQuote aria-hidden className="h-3.5 w-3.5" /> {t("quoteInChatButton")}
            </button>
          ) : null}
          <div className="mx-auto max-w-3xl px-2 pb-24 pt-1 sm:px-6" onBlur={onLeaveLines}>
            {visible.length ? visible.map(({ segment, index }, position) => {
              const previous = visible[position - 1];
              const showSpeaker = !previous || previous.segment.speaker !== segment.speaker || segment.start - previous.segment.end > 30;
              return (
                <SegmentRow
                  key={index}
                  segment={segment}
                  index={index}
                  name={speakerName(transcript, segment.speaker)}
                  showSpeaker={showSpeaker}
                  active={index === activeIndex}
                  ranges={search.bySegment.get(index) ?? NO_RANGES}
                  activeMatch={current?.segment === index ? current.offset : -1}
                  matched={current?.segment === index && current.offset === -1}
                  focus={draft.focus?.index === index ? draft.focus : null}
                  joinsPrevious={previous?.index === index - 1}
                  lines={lines}
                  onSeek={onSeek}
                  onQuote={quoteSegment}
                  onCopyLink={copyLinkAt}
                />
              );
            }) : (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">{segments.length ? t("nothingBySpeaker") : t("noSpeech")}</p>
            )}
          </div>
        </div>
        {notice ? (
          <p role="status" className="pointer-events-none absolute left-1/2 top-2 z-30 -translate-x-1/2 rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background shadow-lg">{notice}</p>
        ) : null}
        {jumpVisible && activeVisible ? (
          <button
            type="button"
            className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background shadow-lg hover:opacity-90"
            onClick={() => {
              userScrollAt.current = 0;
              onFollowChange(true);
              setJumpVisible(false);
              scrollToSegment(activeIndex);
            }}
          >
            <ChevronsDown aria-hidden className="h-3.5 w-3.5" /> {t("backToNowPlaying")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function SpeakerChip({ index, transcript, filtered, onToggle, onRename }: {
  index: number;
  transcript: Transcript;
  filtered: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
}) {
  const t = useTranslations("audio.transcriptPanel");
  const format = useFormatter();
  const speaker = transcript.speakers[index];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(speaker.name);
  const color = speakerColor(index);

  if (editing) {
    return (
      <form
        className="inline-flex h-7 items-center gap-1 rounded-full border border-input bg-card pl-2 pr-1"
        onSubmit={(event) => {
          event.preventDefault();
          setEditing(false);
          if (draft.trim() !== speaker.name) onRename(draft);
        }}
      >
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <input
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          aria-label={t("nameFor", { name: speaker.name })}
          className="w-28 bg-transparent text-xs outline-none"
          value={draft}
          maxLength={80}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setEditing(false); setDraft(speaker.name); } }}
          onBlur={() => { setEditing(false); if (draft.trim() && draft.trim() !== speaker.name) onRename(draft); }}
        />
        <button type="submit" aria-label={t("saveName")} className="inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-muted"><Check aria-hidden className="h-3 w-3" /></button>
      </form>
    );
  }

  return (
    <span className={`group inline-flex h-7 max-w-full items-center rounded-full border text-xs transition-colors ${filtered ? "border-transparent bg-foreground text-background" : "border-input bg-card hover:bg-muted"}`}>
      <button type="button" className="inline-flex h-full min-w-0 items-center gap-1.5 pl-2.5 pr-1.5" aria-pressed={filtered} title={filtered ? t("showEveryone") : t("showOnly", { name: speaker.name })} onClick={onToggle}>
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="truncate font-medium">{speaker.name}</span>
        <span className={`tabular-nums ${filtered ? "text-background/70" : "text-muted-foreground"}`}>{format.number(speaker.share, { style: "percent", maximumFractionDigits: 0 })}</span>
      </button>
      <button type="button" className="mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full opacity-60 hover:opacity-100" aria-label={t("renameName", { name: speaker.name })} title={t("rename")} onClick={() => { setDraft(speaker.name); setEditing(true); }}>
        <Pencil aria-hidden className="h-3 w-3" />
      </button>
    </span>
  );
}

/** Starting a transcription: the engine, its language, how many speakers, and anything still to set up. */
function TranscribeCard({ fileName, setup, onStart, error, onDownload, onCancelDownload, again }: {
  fileName: string;
  setup: ReturnType<typeof useTranscriptionSetup>;
  onStart: (options: StartTranscriptionOptions) => void;
  error: string;
  onDownload: (only?: "diarization") => void;
  onCancelDownload: () => void;
  again?: boolean;
}) {
  const t = useTranslations("audio.transcriptPanel");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const languageNames = useMemo(() => {
    try {
      return new Intl.DisplayNames(locale, { type: "language" });
    } catch {
      return null;
    }
  }, [locale]);
  const status: TranscriptionSetupStatus | null = setup.status;
  const [engine, setEngine] = useState<"local" | "openrouter" | null>(null);
  const [speakers, setSpeakers] = useState(0);
  const [language, setLanguage] = useState<string | null>(null);
  const chosen = engine ?? status?.engine ?? "local";
  const models = status?.models;
  const downloading = models?.state === "downloading";
  const isWav = /\.wav$/i.test(fileName);
  const chosenLanguage = language ?? status?.language ?? "";

  if (!status) {
    return <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground"><Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> {t("checkingSpeechModels")}</div>;
  }

  const localReady = Boolean(models?.asr);
  const speakersReady = Boolean(models?.segmentation && models.embedding);
  const blocked = (chosen === "local" && !localReady) || (chosen === "openrouter" && !status.hasApiKey) || (!status.decoder.available && !isWav) || downloading;

  return (
    <div className={railStyles.card}>
      <p className="mb-2.5 text-xs text-muted-foreground">{again ? t("transcribeAgainDesc") : t("transcribeDesc")}</p>
      <div role="radiogroup" aria-label={t("transcribeWith")} className="mb-2.5 grid grid-cols-1 gap-1 rounded-lg bg-muted p-1">
        {([
          { id: "local", icon: Cpu, title: t("onThisComputer"), detail: "Parakeet TDT v3" },
          { id: "openrouter", icon: Globe, title: "OpenRouter", detail: status.openRouterModel.split("/").pop() ?? status.openRouterModel },
        ] as const).map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={chosen === option.id}
            className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition ${chosen === option.id ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setEngine(option.id)}
          >
            <option.icon aria-hidden className="h-4 w-4 shrink-0" />
            <span className="min-w-0">
              <span className="block text-xs font-medium">{option.title}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{option.detail}</span>
            </span>
          </button>
        ))}
      </div>

      {chosen === "openrouter" ? (
        <label className="mb-2.5 flex items-center justify-between gap-3 text-xs">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Languages aria-hidden className="h-3.5 w-3.5" /> {t("language")}</span>
          <select
            className="libera-panel-field libera-panel-field--compact min-w-0 pl-2.5 pr-2"
            value={chosenLanguage}
            onChange={(event) => setLanguage(event.target.value)}
          >
            <option value="">{t("detectAutomatically")}</option>
            {transcriptionLanguageChoices(status.language).map(({ code, name }) => <option key={code} value={code}>{languageNames?.of(code) ?? name}</option>)}
          </select>
        </label>
      ) : null}

      <label className="mb-2.5 flex items-center justify-between gap-3 text-xs">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Users aria-hidden className="h-3.5 w-3.5" /> {t("speakers")}</span>
        <select
          className="libera-panel-field libera-panel-field--compact min-w-0 pl-2.5 pr-2"
          value={speakers}
          disabled={!status.diarization}
          onChange={(event) => setSpeakers(Number(event.target.value))}
        >
          <option value={0}>{t("detectAutomatically")}</option>
          {Array.from({ length: 8 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{t("personCount", { count })}</option>)}
        </select>
      </label>

      <div className="space-y-2">
        {chosen === "local" && !localReady ? (
          downloading ? null : (
            <Notice action={<button type="button" className="font-medium text-accent hover:underline" onClick={() => onDownload()}>{t("downloadSize", { size: formatBytesIn(locale, models?.totalBytes ?? 0) })}</button>}>
              {t("speakersNotDownloaded")}
            </Notice>
          )
        ) : null}
        {status.diarization && !speakersReady && (chosen === "openrouter" || localReady) && !downloading ? (
          <Notice action={<button type="button" className="font-medium text-accent hover:underline" onClick={() => onDownload("diarization")}>{t("downloadDiarization")}</button>}>{t("speakersTold")}</Notice>
        ) : null}
        {downloading && models ? (
          <div className="space-y-1.5 rounded-lg bg-muted/70 px-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{t("downloadingProgress", { done: formatBytesIn(locale, models.downloadedBytes), total: formatBytesIn(locale, models.totalBytes) })}</span>
              <button type="button" className="font-medium text-muted-foreground hover:text-foreground" onClick={onCancelDownload}>{tCommon("stop")}</button>
            </div>
            <ProgressBar value={models.totalBytes ? models.downloadedBytes / models.totalBytes : 0} />
          </div>
        ) : null}
        {models?.state === "error" ? <Notice tone="error">{models.error}</Notice> : null}
        {chosen === "openrouter" && !status.hasApiKey ? <Notice>{t.rich("addOpenRouterKey", { link: (chunks) => <button type="button" className="font-medium text-accent hover:underline" onClick={openSpeechPreferences}>{chunks}</button> })}</Notice> : null}
        {!status.decoder.available && !isWav ? (
          <Notice>{t.rich("ffmpegNeeded", { strong: (chunks) => <span className="font-medium">{chunks}</span>, link: (chunks) => <button type="button" className="font-medium text-accent hover:underline" onClick={openSpeechPreferences}>{chunks}</button> })}</Notice>
        ) : null}
        {chosen === "openrouter" ? <p className="text-[11px] leading-4 text-muted-foreground">{t("openRouterAudioNote")}</p> : null}
        {error || setup.error ? <Notice tone="error">{error || setup.error}</Notice> : null}
      </div>

      <button
        type="button"
        className="mt-3 inline-flex h-8 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={blocked}
        onClick={() => onStart({ engine: chosen, speakers: speakers || undefined, language: chosen === "openrouter" ? chosenLanguage : undefined })}
      >
        <AudioLines aria-hidden className="h-4 w-4" /> {t("transcribe")}
      </button>
    </div>
  );
}

function JobCard({ job, onCancel }: { job: TranscriptionJob; onCancel: () => void }) {
  const t = useTranslations("audio.transcriptPanel");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();
  return (
    <div className={railStyles.card}>
      <div className="mb-2 flex items-center gap-2">
        <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin text-accent" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{jobLabel(job, t)}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{format.number(job.progress, { style: "percent", maximumFractionDigits: 0 })}</span>
      </div>
      <ProgressBar value={job.progress} indeterminate={job.state === "queued"} />
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">{t("jobMeta", { engine: job.engine === "local" ? "local" : "openrouter", duration: job.duration ? formatDurationIn(locale, job.duration) : "none" })}</span>
        <button type="button" className="font-medium hover:text-foreground" onClick={onCancel}>{tCommon("cancel")}</button>
      </div>
    </div>
  );
}

export type TranscriptNoteActions = {
  /** An unsaved Markdown tab with the transcript. */
  openUnsaved: (fileName: string, content: string) => void;
  /** A note beside the recording, saved and opened. */
  saveBeside: (content: string) => Promise<void>;
};

/**
 * The transcript's sections of the Voice Memo rail tab: transcribing, or,
 * once there is a transcript, what it is, its speakers and what to do with it.
 */
export function TranscriptControls({
  fileName,
  state,
  transcript,
  again,
  onAgainChange,
  speakerFilter,
  onSpeakerFilterChange,
  follow,
  onFollowChange,
}: {
  fileName: string;
  state: TranscriptState;
  /** The transcript with the corrections being made. */
  transcript: Transcript | null;
  again: boolean;
  onAgainChange: (again: boolean) => void;
  speakerFilter: number | null;
  onSpeakerFilterChange: (speaker: number | null) => void;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
}) {
  const t = useTranslations("audio.transcriptPanel");
  const format = useFormatter();
  const locale = useLocale();
  const { payload } = state;
  const job = payload?.job ?? null;
  const active = isJobActive(job);
  const needsSetup = Boolean(payload) && !active && (!transcript || again);
  const setup = useTranscriptionSetup(needsSetup);
  const [speakersOpenChoice, setSpeakersOpenChoice] = useState<boolean | null>(null);
  if (!payload) {
    return <RailSection title={t("transcript")}><p className={railStyles.note}><Loader2 aria-hidden className="mr-1.5 inline h-3 w-3 animate-spin" />{t("loading")}</p></RailSection>;
  }

  if (active && job) {
    return <RailSection title={t("transcript")}><JobCard job={job} onCancel={() => void state.cancel()} /></RailSection>;
  }

  if (needsSetup) {
    return (
      <RailSection title={again ? t("transcribeAgain") : t("transcribe")}>
        {job?.state === "error" ? <div className="mb-2"><Notice tone="error">{job.error}</Notice></div> : null}
        <TranscribeCard
          fileName={fileName}
          setup={setup}
          again={again}
          error={state.error}
          onStart={(options) => {
            onAgainChange(false);
            void state.start(options);
          }}
          onDownload={(only) => void setup.download(only)}
          onCancelDownload={() => void setup.cancelDownload()}
        />
        {again ? <button type="button" className="mt-2 px-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => onAgainChange(false)}>{t("keepCurrentTranscript")}</button> : null}
      </RailSection>
    );
  }

  if (!transcript) return null;
  const speakersOpen = speakersOpenChoice ?? transcript.speakers.length <= 6;

  return (
    <>
      <RailSection title={t("transcript")}>
        <dl className={railStyles.facts}>
          <dt>{t("engine")}</dt>
          <dd title={transcript.engine.kind === "local" ? t("engineTitleOnComputer") : t("engineTitleOpenRouter")}>{transcript.engine.model || (transcript.engine.kind === "local" ? t("onThisComputer") : "OpenRouter")}</dd>
          {transcript.language ? <><dt>{t("language")}</dt><dd className="uppercase">{transcript.language}</dd></> : null}
          <dt>{t("words")}</dt>
          <dd>{format.number(transcript.stats.words)}</dd>
          <dt>{t("passages")}</dt>
          <dd>{format.number(transcript.segments.length)}</dd>
          {transcript.diarization?.overlapSeconds && transcript.diarization.overlapSeconds >= 1 ? <><dt>{t("overlap")}</dt><dd>{formatDurationIn(locale, transcript.diarization.overlapSeconds)}</dd></> : null}
          {payload.shared ? <><dt>{t("shared")}</dt><dd title={t("sharedTitle")}>{t("withNotebook")}</dd></> : null}
        </dl>
        {job?.state === "error" ? <div className="mt-2"><Notice tone="error">{t("transcribingAgainFailed", { error: job.error ?? "" })}</Notice></div> : null}
        {payload.stale ? (
          <div className="mt-2">
            <Notice action={<button type="button" className="font-medium text-accent hover:underline" onClick={() => onAgainChange(true)}>{t("transcribeAgain")}</button>}>{t("recordingChanged")}</Notice>
          </div>
        ) : null}
        <div className="mt-2">
          <RailSwitch checked={follow} label={t("followPlayback")} hint={t("followHint")} onChange={onFollowChange} />
        </div>
        <button
          type="button"
          className="mt-2 inline-flex h-8 w-full items-center justify-center gap-2 rounded-lg border border-input bg-card text-xs font-medium text-foreground transition hover:bg-muted"
          onClick={() => onAgainChange(true)}
        >
          <RefreshCw aria-hidden className="h-3.5 w-3.5" /> {t("transcribeAgainEllipsis")}
        </button>
      </RailSection>

      {transcript.speakers.length ? (
        <RailSection
          title={t("speakersCount", { count: transcript.speakers.length })}
          aside={(
            <button type="button" className="inline-flex items-center gap-0.5 normal-case tracking-normal hover:text-foreground" aria-expanded={speakersOpen} onClick={() => setSpeakersOpenChoice(!speakersOpen)}>
              <ChevronRight aria-hidden className={`h-3 w-3 transition-transform ${speakersOpen ? "rotate-90" : ""}`} />{speakersOpen ? t("hide") : t("show")}
            </button>
          )}
        >
          {speakersOpen ? (
            <>
              <div className="flex flex-wrap gap-1.5 px-1">
                {transcript.speakers.map((speaker, index) => (
                  <SpeakerChip
                    key={`${index}:${speaker.name}`}
                    index={index}
                    transcript={transcript}
                    filtered={speakerFilter === index}
                    onToggle={() => onSpeakerFilterChange(speakerFilter === index ? null : index)}
                    onRename={(name) => void state.renameSpeaker(index, name)}
                  />
                ))}
              </div>
              <p className={`${railStyles.note} mt-2`}>{t("chooseSpeaker")}</p>
            </>
          ) : null}
        </RailSection>
      ) : null}

    </>
  );
}

/**
 * The Voice Memo panel's menu, beside its title: copying and saving the
 * transcript (with the corrections being made), transcribing again, the
 * speech settings and deleting the transcript. The desktop app shows it as
 * a native menu, like the tab strip's and the sidebar's; a browser, as a
 * menu in the page.
 */
export function TranscriptMenu({ fileName, notes, state, transcript, onTranscribeAgain }: {
  fileName: string;
  notes?: TranscriptNoteActions;
  state: TranscriptState;
  transcript: Transcript | null;
  onTranscribeAgain: () => void;
}) {
  const t = useTranslations("audio.transcriptPanel");
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const baseName = fileName.replace(/\.[^.]+$/, "");
  const busy = isJobActive(state.payload?.job);
  // Only the desktop app has a Preferences window.
  const hasPreferences = typeof window !== "undefined" && Boolean(window.liberaPreferences);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? "" : current)), 2400);
  };

  const exportAs = (format: SaveFormat) => {
    if (!transcript) return "";
    return format === "md" ? transcriptToMarkdown(transcript, baseName)
      : format === "txt" ? transcriptToText(transcript)
        : format === "srt" ? transcriptToSrt(transcript)
          : transcriptToVtt(transcript);
  };

  const act = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  const item = "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] hover:bg-muted disabled:pointer-events-none disabled:opacity-40";
  const heading = "flex items-center gap-2 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";
  const none = !transcript;

  const actions: Record<string, () => void> = {
    "copy-md": () => void navigator.clipboard.writeText(exportAs("md")).then(() => flash(t("resultCopiedMarkdown"))),
    "copy-txt": () => void navigator.clipboard.writeText(exportAs("txt")).then(() => flash(t("resultCopiedPlainText"))),
    "open-note": () => notes?.openUnsaved(`${baseName} transcript.md`, exportAs("md")),
    "save-beside": () => void notes?.saveBeside(exportAs("md")).then(() => flash(t("savedBesideNote")), (error: unknown) => flash(error instanceof Error ? error.message : t("couldNotSaveNote"))),
    ...Object.fromEntries((Object.keys(SAVE_FORMATS) as SaveFormat[]).map((format) => [`save-${format}`, () => void saveText(`${baseName}.${format}`, exportAs(format), format, t(`filter.${format}`))])),
    again: onTranscribeAgain,
    settings: openSpeechPreferences,
    delete: () => {
      if (window.confirm(t("deleteTranscriptConfirm"))) void state.remove();
    },
  };

  const [nativeOpen, setNativeOpen] = useState(false);
  const openMenu = async (button: HTMLButtonElement) => {
    const native = window.liberaMenu;
    if (!native) {
      setOpen((value) => !value);
      return;
    }
    const rect = button.getBoundingClientRect();
    setNativeOpen(true);
    const chosen = await native.popup({
      x: Math.round(rect.left),
      y: Math.round(rect.bottom),
      items: [
        { id: "copy-md", label: t("copyMarkdown"), enabled: !none },
        { id: "copy-txt", label: t("copyPlainTextNative"), enabled: !none },
        ...(notes ? [
          { id: "open-note", label: t("openNoteNative"), enabled: !none },
          { id: "save-beside", label: t("saveBesideNative"), enabled: !none },
        ] : []),
        { type: "separator" as const },
        {
          id: "save",
          label: t("saveToComputerNative"),
          enabled: !none,
          submenu: (Object.keys(SAVE_FORMATS) as SaveFormat[]).map((format) => ({ id: `save-${format}`, label: t("saveFormatItem", { label: t(`format.${format}`), extension: format }) })),
        },
        { type: "separator" as const },
        { id: "again", label: t("transcribeAgainNative"), enabled: !none && !busy },
        ...(hasPreferences ? [{ id: "settings", label: t("speechSettingsNative") }] : []),
        { type: "separator" as const },
        { id: "delete", label: t("deleteTranscriptNative"), enabled: !none && !busy },
      ],
    }).catch(() => null);
    setNativeOpen(false);
    if (chosen) actions[chosen]?.();
  };

  return (
    <div ref={rootRef} className="relative">
      <button type="button" className={railIconButton} aria-label={t("menuLabel")} title={t("menuTitle")} aria-haspopup="menu" aria-expanded={open || nativeOpen} onClick={(event) => void openMenu(event.currentTarget)}>
        <MoreVertical aria-hidden className="h-4 w-4" />
      </button>
      {open ? (
        <div role="menu" aria-label={t("menuLabel")} className="absolute right-0 top-9 z-50 max-h-[70vh] w-64 overflow-auto rounded-lg border border-border bg-card p-1 shadow-lg">
          <p className={heading}><Copy aria-hidden className="h-3.5 w-3.5" /> {t("transcript")}</p>
          <button type="button" role="menuitem" className={item} disabled={none} onClick={act(actions["copy-md"])}>
            <span className="w-4" /> {t("copyMarkdown")}
          </button>
          <button type="button" role="menuitem" className={item} disabled={none} onClick={act(actions["copy-txt"])}>
            <span className="w-4" /> {t("copyPlainText")}
          </button>
          {notes ? (
            <>
              <button type="button" role="menuitem" className={item} disabled={none} onClick={act(actions["open-note"])}>
                <FilePlus2 aria-hidden className="h-4 w-4" /> {t("openNote")}
              </button>
              <button type="button" role="menuitem" className={item} disabled={none} onClick={act(actions["save-beside"])}>
                <FileText aria-hidden className="h-4 w-4" /> {t("saveBeside")}
              </button>
            </>
          ) : null}
          <div className="my-1 h-px bg-border" />
          <p className={heading}><Download aria-hidden className="h-3.5 w-3.5" /> {t("saveToComputer")}</p>
          {(Object.keys(SAVE_FORMATS) as SaveFormat[]).map((format) => (
            <button key={format} type="button" role="menuitem" className={item} disabled={none} onClick={act(actions[`save-${format}`])}>
              <span className="w-4" />
              <span className="min-w-0 flex-1 truncate">{t(`format.${format}`)}…</span>
              <span className="font-mono text-[11px] text-muted-foreground">.{format}</span>
            </button>
          ))}
          <div className="my-1 h-px bg-border" />
          <button type="button" role="menuitem" className={item} disabled={none || busy} onClick={act(actions.again)}>
            <RefreshCw aria-hidden className="h-4 w-4" /> {t("transcribeAgainEllipsis")}
          </button>
          {hasPreferences ? (
            <button type="button" role="menuitem" className={item} onClick={act(actions.settings)}>
              <Settings2 aria-hidden className="h-4 w-4" /> {t("speechSettings")}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className={`${item} text-destructive`}
            disabled={none || busy}
            onClick={act(actions.delete)}
          >
            <Trash2 aria-hidden className="h-4 w-4" /> {t("deleteTranscript")}
          </button>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="pointer-events-none absolute right-0 top-9 z-40 whitespace-nowrap rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background shadow-lg">{notice}</p>
      ) : null}
    </div>
  );
}
