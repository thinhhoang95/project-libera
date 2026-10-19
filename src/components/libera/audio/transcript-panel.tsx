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
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { speakerColor, speakerInitials } from "@/components/libera/audio/speaker-colors";
import { isJobActive, useTranscriptionSetup, type StartTranscriptionOptions, type useTranscript } from "@/components/libera/audio/use-voice-memo";
import { encodeFilePath } from "@/components/libera/api-client";
import { CHAT_QUOTE_EVENT, type ChatQuoteDetail } from "@/lib/document-chat";
import { findTermRanges } from "@/lib/global-search";
import {
  formatClock,
  formatDuration,
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

type TranscriptState = ReturnType<typeof useTranscript>;

const FOLLOW_PAUSE_MS = 5000;

const STAGE_LABELS: Record<TranscriptionJob["state"], string> = {
  queued: "Waiting for another recording to finish",
  decoding: "Reading the audio",
  diarizing: "Telling the speakers apart",
  transcribing: "Transcribing",
  saving: "Saving the transcript",
  done: "Done",
  error: "Transcription failed",
  cancelled: "Cancelled",
};

function formatBytes(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function openPreferences() {
  void window.liberaPreferences?.open("speech");
}

const SAVE_FORMATS = {
  md: { label: "Markdown", filterName: "Markdown", type: "text/markdown" },
  txt: { label: "Plain text", filterName: "Text", type: "text/plain" },
  srt: { label: "Subtitles (SRT)", filterName: "SubRip subtitles", type: "application/x-subrip" },
  vtt: { label: "Subtitles (WebVTT)", filterName: "WebVTT subtitles", type: "text/vtt" },
} as const;
type SaveFormat = keyof typeof SAVE_FORMATS;

/** A Save dialog in the desktop app; a download in a browser. */
async function saveText(name: string, text: string, format: SaveFormat) {
  const { filterName, type } = SAVE_FORMATS[format];
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
function selectedTranscriptLines(list: HTMLElement, transcript: Transcript) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
  const range = selection.getRangeAt(0);
  if (!list.contains(range.commonAncestorContainer)) return "";
  const lines: string[] = [];
  for (const row of list.querySelectorAll<HTMLElement>("[data-segment]")) {
    if (!range.intersectsNode(row)) continue;
    const textElement = row.querySelector("[data-segment-text]");
    const segment = transcript.segments[Number(row.dataset.segment)];
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
  if (!ranges.length) return <>{text}</>;
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

const SegmentRow = memo(function SegmentRow({
  segment,
  index,
  name,
  showSpeaker,
  active,
  ranges,
  activeMatch,
  matched,
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
  onSeek: (time: number, play?: boolean) => void;
  onQuote: (index: number) => void;
  onCopyLink: (index: number) => void;
}) {
  const color = speakerColor(segment.speaker);
  return (
    <div
      data-segment={index}
      className={`group relative rounded-lg px-3 transition-colors ${showSpeaker ? "mt-3 pt-2" : "pt-0.5"} pb-1.5 ${active ? "bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]" : "hover:bg-muted/70"} ${matched ? "outline outline-1 outline-[var(--markdown-editor-find-match-active-ring)]" : ""}`}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 64px" }}
    >
      {active ? <span aria-hidden className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-full bg-accent" /> : null}
      <span className="absolute right-1.5 top-1 z-10 hidden items-center gap-0.5 rounded-md border border-border bg-card p-0.5 shadow-sm group-focus-within:flex group-hover:flex">
        <button type="button" className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Quote in AI Chat" title="Quote in AI Chat" onClick={() => onQuote(index)}>
          <MessageSquareQuote aria-hidden className="h-3.5 w-3.5" />
        </button>
        <button type="button" className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Copy link to this moment" title="Copy a link to this moment, for a note" onClick={() => onCopyLink(index)}>
          <Link2 aria-hidden className="h-3.5 w-3.5" />
        </button>
      </span>
      {showSpeaker && name ? (
        <div className="mb-1 flex items-center gap-2">
          <span aria-hidden className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-white" style={{ background: color }}>
            {speakerInitials(name)}
          </span>
          <span className="text-[12.5px] font-semibold" style={{ color }}>{name}</span>
        </div>
      ) : null}
      <div className="flex items-baseline gap-2.5">
        <button
          type="button"
          className={`shrink-0 rounded px-1 font-mono text-[11px] tabular-nums transition-colors ${active ? "text-accent" : "text-muted-foreground hover:text-foreground"}`}
          title="Play from here"
          onClick={() => onSeek(segment.start, true)}
        >
          {formatClock(segment.start)}
        </button>
        <p
          data-segment-text
          className={`min-w-0 cursor-text text-[13.5px] leading-[1.6] ${active ? "text-foreground" : "text-foreground/85"}`}
          onDoubleClick={() => onSeek(segment.start, true)}
        >
          <Marked text={segment.text} ranges={ranges} activeMatch={activeMatch} />
        </p>
      </div>
    </div>
  );
});

function SpeakerChip({ index, transcript, filtered, onToggle, onRename }: {
  index: number;
  transcript: Transcript;
  filtered: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
}) {
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
          aria-label={`Name for ${speaker.name}`}
          className="w-28 bg-transparent text-xs outline-none"
          value={draft}
          maxLength={80}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setEditing(false); setDraft(speaker.name); } }}
          onBlur={() => { setEditing(false); if (draft.trim() && draft.trim() !== speaker.name) onRename(draft); }}
        />
        <button type="submit" aria-label="Save name" className="inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-muted"><Check aria-hidden className="h-3 w-3" /></button>
      </form>
    );
  }

  return (
    <span className={`group inline-flex h-7 items-center rounded-full border text-xs transition-colors ${filtered ? "border-transparent bg-foreground text-background" : "border-input bg-card hover:bg-muted"}`}>
      <button type="button" className="inline-flex h-full items-center gap-1.5 pl-2.5 pr-1.5" aria-pressed={filtered} title={filtered ? "Show everyone" : `Show only ${speaker.name}`} onClick={onToggle}>
        <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: color }} />
        <span className="max-w-32 truncate font-medium">{speaker.name}</span>
        <span className={`tabular-nums ${filtered ? "text-background/70" : "text-muted-foreground"}`}>{Math.round(speaker.share * 100)}%</span>
      </button>
      <button type="button" className="mr-1 inline-flex h-5 w-5 items-center justify-center rounded-full opacity-60 hover:opacity-100" aria-label={`Rename ${speaker.name}`} title="Rename" onClick={() => { setDraft(speaker.name); setEditing(true); }}>
        <Pencil aria-hidden className="h-3 w-3" />
      </button>
    </span>
  );
}

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

/** Starting a transcription: the engine, how many speakers, and anything still to set up. */
function TranscribeCard({ fileName, setup, onStart, error, onDownload, onCancelDownload, again }: {
  fileName: string;
  setup: ReturnType<typeof useTranscriptionSetup>;
  onStart: (options: StartTranscriptionOptions) => void;
  error: string;
  onDownload: (only?: "diarization") => void;
  onCancelDownload: () => void;
  again?: boolean;
}) {
  const status: TranscriptionSetupStatus | null = setup.status;
  const [engine, setEngine] = useState<"local" | "openrouter" | null>(null);
  const [speakers, setSpeakers] = useState(0);
  const chosen = engine ?? status?.engine ?? "local";
  const models = status?.models;
  const downloading = models?.state === "downloading";
  const isWav = /\.wav$/i.test(fileName);

  if (!status) {
    return <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground"><Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Checking the speech models…</div>;
  }

  const localReady = Boolean(models?.asr);
  const speakersReady = Boolean(models?.segmentation && models.embedding);
  const blocked = (chosen === "local" && !localReady) || (chosen === "openrouter" && !status.hasApiKey) || (!status.decoder.available && !isWav) || downloading;

  return (
    <div className="mx-4 my-4 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-3">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-accent"><AudioLines aria-hidden className="h-5 w-5" /></span>
        <div>
          <h3 className="text-sm font-semibold">{again ? "Transcribe again" : "Transcribe this memo"}</h3>
          <p className="text-xs text-muted-foreground">A timestamped transcript, with who said what.</p>
        </div>
      </div>

      <div role="radiogroup" aria-label="Transcribe with" className="mb-3 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
        {([
          { id: "local", icon: Cpu, title: "On this computer", detail: "Parakeet TDT v3" },
          { id: "openrouter", icon: Globe, title: "OpenRouter", detail: status.openRouterModel.split("/").pop() ?? status.openRouterModel },
        ] as const).map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={chosen === option.id}
            className={`flex items-center gap-2 rounded-md px-2.5 py-2 text-left transition ${chosen === option.id ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
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

      <label className="mb-3 flex items-center justify-between gap-3 text-xs">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Users aria-hidden className="h-3.5 w-3.5" /> Speakers</span>
        <select
          className="h-7 rounded-md border border-input bg-card px-2 text-xs"
          value={speakers}
          disabled={!status.diarization}
          onChange={(event) => setSpeakers(Number(event.target.value))}
        >
          <option value={0}>Detect automatically</option>
          {Array.from({ length: 8 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count === 1 ? "1 person" : `${count} people`}</option>)}
        </select>
      </label>

      <div className="space-y-2 text-xs">
        {chosen === "local" && !localReady ? (
          downloading ? null : (
            <Notice action={<button type="button" className="font-medium text-accent hover:underline" onClick={() => onDownload()}>Download ({formatBytes(models?.totalBytes ?? 0)})</button>}>
              Parakeet and the pyannote speaker models are not downloaded yet. They run on this computer, outside your notes.
            </Notice>
          )
        ) : null}
        {status.diarization && !speakersReady && (chosen === "openrouter" || localReady) && !downloading ? (
          <Notice action={<button type="button" className="font-medium text-accent hover:underline" onClick={() => onDownload("diarization")}>Download (34 MB)</button>}>Speakers are told apart on this computer with pyannote.</Notice>
        ) : null}
        {downloading && models ? (
          <div className="space-y-1.5 rounded-lg bg-muted/70 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Downloading speech models… {formatBytes(models.downloadedBytes)} of {formatBytes(models.totalBytes)}</span>
              <button type="button" className="font-medium text-muted-foreground hover:text-foreground" onClick={onCancelDownload}>Stop</button>
            </div>
            <ProgressBar value={models.totalBytes ? models.downloadedBytes / models.totalBytes : 0} />
          </div>
        ) : null}
        {models?.state === "error" ? <Notice tone="error">{models.error}</Notice> : null}
        {chosen === "openrouter" && !status.hasApiKey ? <Notice>Add an OpenRouter API key in <button type="button" className="font-medium text-accent hover:underline" onClick={openPreferences}>Preferences</button>.</Notice> : null}
        {!status.decoder.available && !isWav ? (
          <Notice>Reading this format needs <span className="font-medium">ffmpeg</span>. Install it, or choose it in <button type="button" className="font-medium text-accent hover:underline" onClick={openPreferences}>Preferences → Speech</button>.</Notice>
        ) : null}
        {chosen === "openrouter" ? <p className="text-[11px] leading-4 text-muted-foreground">The audio is sent to OpenRouter in pieces of a few minutes. Speakers are still told apart on this computer.</p> : null}
        {error || setup.error ? <Notice tone="error">{error || setup.error}</Notice> : null}
      </div>

      <button
        type="button"
        className="mt-4 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={blocked}
        onClick={() => onStart({ engine: chosen, speakers: speakers || undefined })}
      >
        <AudioLines aria-hidden className="h-4 w-4" /> Transcribe
      </button>
    </div>
  );
}

function Notice({ children, action, tone }: { children: ReactNode; action?: ReactNode; tone?: "error" }) {
  return (
    <div className={`flex items-start gap-2 rounded-lg px-3 py-2 leading-5 ${tone === "error" ? "bg-destructive-muted text-destructive" : "bg-muted/70 text-muted-foreground"}`}>
      <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      {action ? <span className="shrink-0">{action}</span> : null}
    </div>
  );
}

function JobCard({ job, onCancel }: { job: TranscriptionJob; onCancel: () => void }) {
  const label = job.state === "transcribing" && job.total ? `${STAGE_LABELS.transcribing} · part ${Math.min(job.done + 1, job.total)} of ${job.total}` : STAGE_LABELS[job.state];
  return (
    <div className="mx-4 my-4 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-3">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-accent"><Loader2 aria-hidden className="h-5 w-5 animate-spin" /></span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{label}</h3>
          <p className="text-xs text-muted-foreground">
            {job.engine === "local" ? "On this computer" : "With OpenRouter"}
            {job.duration ? ` · ${formatDuration(job.duration)} of audio` : ""}
          </p>
        </div>
        <span className="text-xs font-medium tabular-nums text-muted-foreground">{Math.round(job.progress * 100)}%</span>
      </div>
      <ProgressBar value={job.progress} indeterminate={job.state === "queued"} />
      <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>You can keep working; it continues in the background.</span>
        <button type="button" className="font-medium hover:text-foreground" onClick={onCancel}>Cancel</button>
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

export function TranscriptPanel({
  path,
  fileName,
  notes,
  state,
  currentTime,
  onSeek,
  onSearchMatches,
  searchFocusNonce,
  onClose,
  follow,
  onFollowChange,
}: {
  path: string;
  fileName: string;
  notes?: TranscriptNoteActions;
  state: TranscriptState;
  currentTime: number;
  onSeek: (time: number, play?: boolean) => void;
  /** Times of the find box's matches, for the waveform. */
  onSearchMatches: (times: number[]) => void;
  searchFocusNonce: number;
  onClose: () => void;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
}) {
  const { payload } = state;
  const transcript = payload?.transcript ?? null;
  const job = payload?.job ?? null;
  const active = isJobActive(job);
  const [again, setAgain] = useState(false);
  const needsSetup = Boolean(payload) && !active && (!transcript || again);
  const setup = useTranscriptionSetup(needsSetup);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [speakerFilter, setSpeakerFilter] = useState<number | null>(null);
  // Speaker chips start folded away when there are many, so they don't push the transcript out of view.
  const [speakersOpenChoice, setSpeakersOpenChoice] = useState<boolean | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [jumpVisible, setJumpVisible] = useState(false);
  const [notice, setNotice] = useState("");
  const [selectionQuote, setSelectionQuote] = useState<{ top: number; left: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const userScrollAt = useRef(0);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (searchFocusNonce) {
      searchRef.current?.focus();
      searchRef.current?.select();
    }
  }, [searchFocusNonce]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [menuOpen]);

  const segments = useMemo(() => transcript?.segments ?? [], [transcript]);
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
    flash("Quoted in AI Chat");
  }, [fileName, flash, path]);

  const quoteSegment = useCallback((index: number) => {
    const segment = transcript?.segments[index];
    if (transcript && segment) quote(transcriptLine(transcript, segment));
  }, [quote, transcript]);

  const quoteSelection = useCallback(() => {
    const list = listRef.current;
    if (!list || !transcript) return false;
    const text = selectedTranscriptLines(list, transcript);
    if (!text) return false;
    quote(text);
    window.getSelection()?.removeAllRanges();
    setSelectionQuote(null);
    return true;
  }, [quote, transcript]);

  const copyLink = useCallback(async (index: number) => {
    const segment = transcript?.segments[index];
    if (!segment) return;
    const title = fileName.replace(/\.[^.]+$/, "");
    // A library path: it resolves from any note, and `#t=` opens the recording at that moment.
    await navigator.clipboard.writeText(`[${title} · ${formatClock(segment.start)}](${encodeFilePath(path)}#t=${Math.floor(segment.start)})`);
    flash("Link copied. Paste it into a note.");
  }, [fileName, flash, path, transcript]);

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

  // Keep the segment being played in view, unless the reader has scrolled away to look at something.
  useLayoutEffect(() => {
    if (!follow || activeIndex < 0 || !activeVisible || current) return;
    if (Date.now() - userScrollAt.current < FOLLOW_PAUSE_MS) return;
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-segment="${activeIndex}"]`);
    if (!list || !row) return;
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

  const baseName = fileName.replace(/\.[^.]+$/, "");

  const copyTranscript = async (format: "md" | "txt") => {
    if (!transcript) return;
    await navigator.clipboard.writeText(format === "md" ? transcriptToMarkdown(transcript, baseName) : transcriptToText(transcript));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const exportAs = (format: SaveFormat) => {
    if (!transcript) return "";
    return format === "md" ? transcriptToMarkdown(transcript, baseName)
      : format === "txt" ? transcriptToText(transcript)
        : format === "srt" ? transcriptToSrt(transcript)
          : transcriptToVtt(transcript);
  };

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-card" aria-label="Transcript">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="flex-1 text-sm font-semibold">Transcript</h2>
        {transcript ? (
          <div className="relative" ref={menuRef}>
            <button type="button" className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted" aria-label="Transcript actions" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
              <MoreHorizontal aria-hidden className="h-4 w-4" />
            </button>
            {menuOpen ? (
              <div role="menu" className="absolute right-0 top-8 z-20 max-h-[70vh] w-64 overflow-y-auto rounded-lg border border-border bg-card py-1 text-sm shadow-lg">
                <MenuItem icon={copied ? Check : Copy} onClick={() => { void copyTranscript("md"); setMenuOpen(false); }}>{copied ? "Copied" : "Copy as Markdown"}</MenuItem>
                <MenuItem icon={Copy} onClick={() => { void copyTranscript("txt"); setMenuOpen(false); }}>Copy as plain text</MenuItem>
                {notes ? (
                  <>
                    <div className="my-1 h-px bg-border" />
                    <MenuItem icon={FilePlus2} onClick={() => { notes.openUnsaved(`${baseName} transcript.md`, exportAs("md")); setMenuOpen(false); }}>Open as a new note</MenuItem>
                    <MenuItem icon={FileText} onClick={() => {
                      setMenuOpen(false);
                      void notes.saveBeside(exportAs("md")).then(() => flash("Saved as a note beside the recording"), (error: unknown) => flash(error instanceof Error ? error.message : "Could not save the note."));
                    }}>Save as a note beside the recording</MenuItem>
                  </>
                ) : null}
                <div className="my-1 h-px bg-border" />
                <p className="px-3 pb-0.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Save to this computer</p>
                {(Object.keys(SAVE_FORMATS) as SaveFormat[]).map((format) => (
                  <MenuItem key={format} icon={Download} onClick={() => { void saveText(`${baseName}.${format}`, exportAs(format), format); setMenuOpen(false); }}>{`${SAVE_FORMATS[format].label} (.${format})…`}</MenuItem>
                ))}
                <div className="my-1 h-px bg-border" />
                <MenuItem icon={RefreshCw} onClick={() => { setAgain(true); setMenuOpen(false); }}>Transcribe again…</MenuItem>
                <MenuItem icon={Settings2} onClick={() => { openPreferences(); setMenuOpen(false); }}>Transcription settings</MenuItem>
                <MenuItem icon={Trash2} danger onClick={() => { void state.remove(); setMenuOpen(false); }}>Delete transcript</MenuItem>
              </div>
            ) : null}
          </div>
        ) : null}
        <button type="button" className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted" aria-label="Hide transcript" title="Hide transcript (T)" onClick={onClose}>
          <X aria-hidden className="h-4 w-4" />
        </button>
      </header>

      {!payload ? (
        <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground"><Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : active && job ? (
        <JobCard job={job} onCancel={() => void state.cancel()} />
      ) : needsSetup ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {job?.state === "error" ? <div className="mx-4 mt-4"><Notice tone="error">{job.error}</Notice></div> : null}
          <TranscribeCard
            fileName={fileName}
            setup={setup}
            again={again}
            error={state.error}
            onStart={(options) => {
              setAgain(false);
              void state.start(options);
            }}
            onDownload={(only) => void setup.download(only)}
            onCancelDownload={() => void setup.cancelDownload()}
          />
          {again ? <button type="button" className="mx-4 text-xs text-muted-foreground hover:text-foreground" onClick={() => setAgain(false)}>Keep the current transcript</button> : null}
        </div>
      ) : transcript ? (
        <>
          <div className="space-y-2.5 border-b border-border px-4 py-3">
            <div className="flex h-8 items-center gap-1.5 rounded-lg border border-input bg-background px-2 focus-within:ring-2 focus-within:ring-ring">
              <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={searchRef}
                type="search"
                aria-label="Find in transcript"
                placeholder="Find in transcript, or speaker:Name"
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setMatchIndex(0);
                }}
                title="Find words; speaker:Name shows one speaker (speaker:2, speaker:&quot;Two words&quot;)"
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
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{search.matches.length ? `${Math.min(matchIndex, search.matches.length - 1) + 1} of ${search.matches.length}` : parsed.unknown.length ? "No such speaker" : "No matches"}</span>
                  <button type="button" className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-muted disabled:opacity-40" aria-label="Previous match" disabled={!search.matches.length} onClick={() => stepMatch(-1)}><ArrowUp aria-hidden className="h-3 w-3" /></button>
                  <button type="button" className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-muted disabled:opacity-40" aria-label="Next match" disabled={!search.matches.length} onClick={() => stepMatch(1)}><ArrowDown aria-hidden className="h-3 w-3" /></button>
                  <button type="button" className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-muted" aria-label="Clear" onClick={() => { setQuery(""); setMatchIndex(0); }}><X aria-hidden className="h-3 w-3" /></button>
                </>
              ) : null}
            </div>
            {speakerSuggestion ? (
              <div className="flex flex-wrap items-center gap-1 text-[11px]">
                <span className="text-muted-foreground">Speaker:</span>
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
            {transcript.speakers.length ? (() => {
              const speakersOpen = speakersOpenChoice ?? transcript.speakers.length <= 4;
              const shown = speakersOpen ? transcript.speakers.map((_, index) => index) : speakerFilter !== null ? [speakerFilter] : [];
              return (
              <div className="space-y-1.5">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                  aria-expanded={speakersOpen}
                  onClick={() => setSpeakersOpenChoice(!speakersOpen)}
                >
                  <ChevronRight aria-hidden className={`h-3 w-3 transition-transform ${speakersOpen ? "rotate-90" : ""}`} />
                  <Users aria-hidden className="h-3 w-3" /> {transcript.speakers.length} {transcript.speakers.length === 1 ? "speaker" : "speakers"}
                </button>
                {shown.length ? (
              <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                {shown.map((index) => (
                  <SpeakerChip
                    key={`${index}:${transcript.speakers[index].name}`}
                    index={index}
                    transcript={transcript}
                    filtered={speakerFilter === index}
                    onToggle={() => {
                      setSpeakerFilter((value) => (value === index ? null : index));
                      setMatchIndex(0);
                    }}
                    onRename={(name) => void state.renameSpeaker(index, name)}
                  />
                ))}
              </div>
                ) : null}
              </div>
              );
            })() : null}
            {payload.stale ? (
              <Notice action={<button type="button" className="font-medium text-accent hover:underline" onClick={() => setAgain(true)}>Transcribe again</button>}>
                The recording changed after it was transcribed.
              </Notice>
            ) : null}
          </div>

          <div className="relative min-h-0 flex-1">
            <div ref={listRef} className="relative h-full overflow-y-auto px-2 pb-6 pt-1" onWheel={onUserScroll} onTouchMove={onUserScroll} onMouseUp={onListMouseUp} onScroll={() => { if (Date.now() - userScrollAt.current < 200) onUserScroll(); }}>
              {selectionQuote ? (
                <button
                  type="button"
                  className="absolute z-20 inline-flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background shadow-lg"
                  style={{ top: Math.max(0, selectionQuote.top), left: selectionQuote.left }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => quoteSelection()}
                >
                  <MessageSquareQuote aria-hidden className="h-3.5 w-3.5" /> Quote in chat
                </button>
              ) : null}
              {visible.length ? visible.map(({ segment, index }, position) => {
                const previous = visible[position - 1]?.segment;
                const showSpeaker = !previous || previous.speaker !== segment.speaker || segment.start - previous.end > 30;
                const ranges = search.bySegment.get(index) ?? [];
                return (
                  <SegmentRow
                    key={index}
                    segment={segment}
                    index={index}
                    name={speakerName(transcript, segment.speaker)}
                    showSpeaker={showSpeaker}
                    active={index === activeIndex}
                    ranges={ranges}
                    activeMatch={current?.segment === index ? current.offset : -1}
                    matched={current?.segment === index && current.offset === -1}
                    onSeek={onSeek}
                    onQuote={quoteSegment}
                    onCopyLink={(row) => void copyLink(row)}
                  />
                );
              }) : (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">{segments.length ? "Nothing said by this speaker." : "No speech was found in this recording."}</p>
              )}
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
                <ChevronsDown aria-hidden className="h-3.5 w-3.5" /> Back to now playing
              </button>
            ) : null}
          </div>

          <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
            <span title={transcript.engine.kind === "local" ? "Transcribed on this computer" : "Transcribed with OpenRouter"}>{transcript.engine.model}</span>
            {transcript.language ? <span className="uppercase">{transcript.language}</span> : null}
            {transcript.diarization ? (
              <span title={`pyannote: ${transcript.diarization.turns} turns, ${formatDuration(transcript.diarization.speechSeconds)} of speech${transcript.diarization.overlapSeconds ? `, ${formatDuration(transcript.diarization.overlapSeconds)} overlapping` : ""}`}>
                {transcript.diarization.speakerCount === 1 ? "1 speaker" : `${transcript.diarization.speakerCount} speakers`}
                {transcript.diarization.overlapSeconds >= 1 ? ` · ${formatDuration(transcript.diarization.overlapSeconds)} overlap` : ""}
              </span>
            ) : null}
            <span>{transcript.stats.words.toLocaleString()} words</span>
            {payload.shared ? <span title="Everyone in this shared notebook sees this transcript and its speaker names.">Shared</span> : null}
            <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" className="h-3 w-3 accent-[var(--accent)]" checked={follow} onChange={(event) => onFollowChange(event.target.checked)} />
              Follow playback
            </label>
          </footer>
        </>
      ) : null}
    </aside>
  );
}

function MenuItem({ icon: Icon, children, onClick, danger }: { icon: typeof Copy; children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-muted ${danger ? "text-destructive" : ""}`} onClick={onClick}>
      <Icon aria-hidden className="h-3.5 w-3.5" /> {children}
    </button>
  );
}
