"use client";

import { AlertCircle, BadgeCheck, Check, GitMerge, Info, Loader2, Paperclip, Pencil, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { FormattedCitationHtml } from "@/components/libera/references/citation-chip";
import { ProvenanceChip } from "@/components/libera/references/reference-card";
import {
  fieldLabel,
  fileBaseName,
  formatFieldValue,
  formatPlainReference,
  PROVENANCE_LABELS,
  STATUS_LABELS,
} from "@/components/libera/references/reference-display";
import { readCustomStyle } from "@/components/libera/references/reference-render-context";
import { isPreprint, mergeEntryFields } from "@/lib/references/dedupe";
import { citationHtmlToText, isBundledCslStyle, loadCslStyle } from "@/lib/references/format";
import { formatCitationDocumentAsync } from "@/lib/references/format-client";
import {
  AUTHORITATIVE_SOURCES,
  DEFAULT_CSL_STYLE,
  type CslItem,
  type FieldAlternative,
  type FieldProvenance,
  type ReferenceAttachment,
  type ReferenceEntry,
  type ReferenceEntryInput,
  type ReferenceIdentifiers,
  type ReferenceLibrary,
  type ReferenceLibraryOp,
  type ReferenceVersionLink,
} from "@/lib/references/types";

// Resolution in the References panel: POST /api/references/resolve and the
// candidate confirmation cards (formatted reference, provenance per field,
// conflicts to settle, duplicates to attach to, merge into or add anyway),
// re-resolving an existing entry with a diff, the shared citeproc formatting
// of single references, rich copy, and the once-per-session privacy notice.
// See docs/references/plan.md §4.4.

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/** The web-search choice for this session; null until the user changes it (the preference cannot be read here, so it starts off). */
let sessionWebSearch: boolean | null = null;
let privacyNoticeShown = false;

export function sessionWebSearchChoice() {
  return sessionWebSearch;
}

export function setSessionWebSearch(value: boolean) {
  sessionWebSearch = value;
}

/** True the first time in this session an online lookup starts, false after. */
export function claimPrivacyNotice() {
  if (privacyNoticeShown) return false;
  privacyNoticeShown = true;
  return true;
}

/** Tests: forget the session's web-search choice and privacy notice. */
export function resetReferenceResolutionSession() {
  sessionWebSearch = null;
  privacyNoticeShown = false;
}

export const PRIVACY_NOTICE_TEXT = "Libera looks up identifiers and titles on Crossref, OpenAlex, arXiv, PubMed and Open Library. With AI on, the first pages of a PDF are sent to your AI provider.";

export function PrivacyNotice({ onDismiss }: { onDismiss: () => void }) {
  const preferences = typeof window !== "undefined" ? window.liberaPreferences : undefined;
  return (
    <div role="note" aria-label="Online lookups" className="libera-panel-card mx-3 mb-2 flex items-start gap-2 p-2 text-[11px] leading-relaxed">
      <Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1">
        {PRIVACY_NOTICE_TEXT}{" "}
        {preferences
          ? <button type="button" className="font-medium text-accent hover:underline" onClick={() => void preferences.open("ai")}>Preferences</button>
          : <>Change this in Preferences → AI.</>}
      </p>
      <button type="button" className="shrink-0" aria-label="Dismiss notice" onClick={onDismiss}><X aria-hidden className="h-3 w-3" /></button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The resolve API
// ---------------------------------------------------------------------------

export type ResolveDuplicate = {
  candidateIndex: number;
  entryId: string;
  reason?: string;
  score?: number;
  /** The candidate and the entry are the preprint and the published version of one work. */
  preprintPair?: boolean;
};

export type ResolveResponse = {
  candidates: ReferenceEntryInput[];
  duplicates: ResolveDuplicate[];
  /** Ops to apply after confirmation, e.g. attaching a converted Markdown file to its PDF's entry. */
  updates: ReferenceLibraryOp[];
  warnings: string[];
};

export type ResolveRequest = { notebook: string; input: string; webSearch?: boolean } | { notebook: string; path: string; webSearch?: boolean };

async function errorMessage(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON.
  }
  return fallback;
}

export function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

/** POST /api/references/resolve. Nothing is written; the caller adds what the user confirms. */
export async function resolveReference(request: ResolveRequest, signal?: AbortSignal): Promise<ResolveResponse> {
  const response = await fetch("/api/references/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) throw new Error(await errorMessage(response, "The reference could not be looked up."));
  const body = await response.json() as Partial<ResolveResponse>;
  return { candidates: body.candidates ?? [], duplicates: body.duplicates ?? [], updates: body.updates ?? [], warnings: body.warnings ?? [] };
}

// ---------------------------------------------------------------------------
// Formatting one reference with the notebook's style
// ---------------------------------------------------------------------------

const styles = new Map<string, Promise<string>>();

/** The CSL XML for a library's style setting: a bundled style, or the notebook's `.csl` file (the default style if it cannot be read). */
export function loadLibraryStyle(notebook: string, setting: string) {
  const id = `${notebook}\u0000${setting}`;
  let style = styles.get(id);
  if (!style) {
    style = (async () => {
      if (!isBundledCslStyle(setting) && /\.csl$/i.test(setting)) {
        const xml = await readCustomStyle(notebook, setting);
        if (xml) return xml;
      }
      return loadCslStyle(setting || DEFAULT_CSL_STYLE);
    })();
    styles.set(id, style);
    style.catch(() => {
      if (styles.get(id) === style) styles.delete(id);
    });
  }
  return style;
}

/** Tests: forget loaded styles. */
export function resetLibraryStyles() {
  styles.clear();
}

type FormattableEntry = Pick<ReferenceEntry, "id" | "key" | "csl">;

function asEntry(entry: FormattableEntry): ReferenceEntry {
  return {
    id: entry.id, key: entry.key, csl: entry.csl, aliases: [], identifiers: {}, provenance: {}, status: "confirmed",
    attachments: [], createdAt: "", updatedAt: "", fieldUpdatedAt: {},
  };
}

function formatSignature(notebook: string, setting: string, entry: FormattableEntry) {
  return ["reference", notebook, setting, entry.id, entry.key, JSON.stringify(entry.csl)].join("\u0000");
}

/** One entry as a bibliography item in the notebook's style (sanitized HTML), through the formatting worker. */
export async function formatReferenceHtml(notebook: string, setting: string, entry: FormattableEntry) {
  const style = await loadLibraryStyle(notebook, setting);
  const key = entry.key || "reference";
  const result = await formatCitationDocumentAsync(formatSignature(notebook, setting, entry), {
    citations: [{ items: [{ key }], raw: `[@${key}]` }],
    entries: { [key]: asEntry({ ...entry, key }) },
    style,
  });
  const html = result.bibliographyEntries[entry.id];
  if (!html) throw new Error("The reference could not be formatted.");
  return html;
}

/**
 * The formatted reference for display: citeproc HTML in the notebook's style
 * once it is ready, and the plain "Authors (Year). Title. Venue." text while
 * it loads or when formatting fails.
 */
export function useFormattedReference(notebook: string, setting: string, entry: FormattableEntry) {
  const signature = formatSignature(notebook, setting, entry);
  const entryRef = useRef(entry);
  useEffect(() => {
    entryRef.current = entry;
  });
  const [state, setState] = useState<{ signature: string; html: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    formatReferenceHtml(notebook, setting, entryRef.current).then(
      (html) => { if (!cancelled) setState({ signature, html }); },
      () => { if (!cancelled) setState({ signature, html: null }); },
    );
    return () => {
      cancelled = true;
    };
    // The signature covers the notebook, the style and the entry's fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  const html = state?.signature === signature ? state.html : null;
  return { html, text: html ? citationHtmlToText(html) : formatPlainReference(entry.csl), pending: state?.signature !== signature };
}

export function FormattedReference({ notebook, setting, entry, className }: { notebook: string; setting: string; entry: FormattableEntry; className?: string }) {
  const { html, text, pending } = useFormattedReference(notebook, setting, entry);
  return (
    <div className={className} aria-label="Formatted reference" data-formatted={html ? "citeproc" : "plain"} aria-busy={pending || undefined}>
      {html ? <FormattedCitationHtml html={html} /> : text}
    </div>
  );
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

/** The formatted reference as text and HTML for the clipboard; the plain reference when formatting fails. */
export async function formattedReferenceForCopy(notebook: string, setting: string, entry: FormattableEntry) {
  const html = await formatReferenceHtml(notebook, setting, entry).catch(() => null);
  if (html) return { text: citationHtmlToText(html), html };
  const text = formatPlainReference(entry.csl);
  return { text, html: text.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char]) };
}

/**
 * Put text/plain and text/html on the clipboard: an async ClipboardItem
 * where available, else a copy event that sets both formats (as the editors'
 * copy handlers do), else plain text.
 */
export async function writeRichClipboard(text: string, html: string) {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (clipboard?.write && typeof ClipboardItem !== "undefined") {
    await clipboard.write([new ClipboardItem({
      "text/plain": new Blob([text], { type: "text/plain" }),
      "text/html": new Blob([html], { type: "text/html" }),
    })]);
    return;
  }
  let written = false;
  const listener = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/plain", text);
    event.clipboardData.setData("text/html", html);
    event.preventDefault();
    written = true;
  };
  document.addEventListener("copy", listener);
  try {
    document.execCommand?.("copy");
  } catch {
    // Not supported here; fall back to plain text.
  } finally {
    document.removeEventListener("copy", listener);
  }
  if (written) return;
  if (!clipboard?.writeText) throw new Error("The clipboard is not available.");
  await clipboard.writeText(text);
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** Confidence an authoritative field needs for "Add & confirm". */
export const CONFIRM_CONFIDENCE = 0.9;

function hasValue(value: unknown) {
  return value !== undefined && value !== null && !(typeof value === "string" && !value.trim()) && !(Array.isArray(value) && !value.length);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function pendingConflicts(candidate: Pick<ReferenceEntryInput, "conflicts">) {
  return Object.entries(candidate.conflicts ?? {}).filter(([, alternatives]) => alternatives?.length).map(([field]) => field);
}

/**
 * Why a candidate cannot be added as confirmed, or null when it can: every
 * field must come from an authoritative source (Crossref, DataCite,
 * OpenAlex, arXiv, PubMed, Open Library) with confidence ≥ 0.9, and no
 * sources may still disagree.
 */
export function confirmBlocker(candidate: ReferenceEntryInput): string | null {
  const fields = Object.keys(candidate.csl).filter((field) => field !== "type" && hasValue(candidate.csl[field]));
  if (!fields.length) return "There are no fields to confirm.";
  const conflicts = pendingConflicts(candidate);
  if (conflicts.length) return `Sources disagree on ${conflicts.map((field) => fieldLabel(field).toLowerCase()).join(", ")}: choose a value first.`;
  for (const field of fields) {
    // The resolution server gives every field a source, identifiers copied into the item included.
    const provenance = candidate.provenance?.[field];
    if (!provenance) return `${fieldLabel(field)} has no source.`;
    if (!AUTHORITATIVE_SOURCES.includes(provenance.source)) return `${fieldLabel(field)} comes from ${PROVENANCE_LABELS[provenance.source] ?? provenance.source}, not an authoritative source.`;
    if (provenance.confidence < CONFIRM_CONFIDENCE) return `${fieldLabel(field)} has confidence ${Math.round(provenance.confidence * 100)}%, below 90%.`;
  }
  return null;
}

function withoutConflict(conflicts: ReferenceEntryInput["conflicts"], field: string) {
  const rest = { ...conflicts };
  delete rest[field];
  return Object.keys(rest).length ? rest : undefined;
}

/** Use a competing value for a field: its value and provenance; the disagreement is settled. */
export function chooseCandidateAlternative(candidate: ReferenceEntryInput, field: string, alternative: FieldAlternative): ReferenceEntryInput {
  const next: ReferenceEntryInput = {
    ...candidate,
    csl: { ...candidate.csl, [field]: alternative.value },
    provenance: { ...candidate.provenance, [field]: alternative.provenance },
  };
  const conflicts = withoutConflict(candidate.conflicts, field);
  if (conflicts) next.conflicts = conflicts;
  else delete next.conflicts;
  return next;
}

/** Keep the candidate's value for a field; the disagreement is settled. */
export function keepCandidateValue(candidate: ReferenceEntryInput, field: string): ReferenceEntryInput {
  const next: ReferenceEntryInput = { ...candidate };
  const conflicts = withoutConflict(candidate.conflicts, field);
  if (conflicts) next.conflicts = conflicts;
  else delete next.conflicts;
  return next;
}

function attachmentIdentity(attachment: ReferenceAttachment) {
  return attachment.kind === "url" ? `url:${attachment.url}` : `file:${attachment.path}`;
}

/** Attachments the candidate brings that the entry does not have yet. */
export function newAttachments(entry: Pick<ReferenceEntry, "attachments">, candidate: Pick<ReferenceEntryInput, "attachments">) {
  const known = new Set(entry.attachments.map(attachmentIdentity));
  return (candidate.attachments ?? []).filter((attachment) => !known.has(attachmentIdentity(attachment)));
}

/** "Attach to existing": the candidate's files and links, attached to the entry it duplicates. */
export function attachCandidateOps(entry: ReferenceEntry, candidate: ReferenceEntryInput): ReferenceLibraryOp[] {
  return newAttachments(entry, candidate).map((attachment) => ({ op: "attach", id: entry.id, attachment }));
}

/** How the candidate links to the other version of the work. */
function versionLink(candidate: ReferenceEntryInput): ReferenceVersionLink | null {
  const doi = candidate.identifiers?.doi ?? (typeof candidate.csl.DOI === "string" ? candidate.csl.DOI : undefined);
  const identifier = doi ?? (candidate.identifiers?.arxiv ? `arXiv:${candidate.identifiers.arxiv}` : typeof candidate.csl.URL === "string" ? candidate.csl.URL : undefined);
  if (!identifier) return null;
  return { relation: isPreprint(candidate) ? "preprint-of" : "published-as", identifier };
}

function withVersion(entry: ReferenceEntry, link: ReferenceVersionLink | null) {
  if (!link) return null;
  const versions = entry.versions ?? [];
  if (versions.some((version) => version.relation === link.relation && version.identifier.toLowerCase() === link.identifier.toLowerCase())) return null;
  return [...versions, link];
}

/**
 * "Merge into existing": the candidate's fields the entry lacks, as one
 * `update` (mergeEntryFields semantics: present values are never replaced),
 * plus `attach` ops for its files. For a published version of a preprint in
 * the library, the published metadata replaces the preprint's (fields the
 * user wrote become conflicts instead), and both record the version link.
 */
export function mergeCandidateOps(entry: ReferenceEntry, candidate: ReferenceEntryInput, options: { preprintPair?: boolean } = {}): ReferenceLibraryOp[] {
  const ops: ReferenceLibraryOp[] = [];
  const link = options.preprintPair ? versionLink(candidate) : null;
  if (options.preprintPair && !isPreprint(candidate)) {
    const rows = reresolveDiff(entry, candidate);
    const update = buildReresolveOp(entry, candidate, rows.filter((row) => !row.userOwned).map((row) => row.field), { keepStatus: true });
    const versions = withVersion(entry, link);
    if (versions) update.versions = versions;
    if (Object.keys(update).length > 2) ops.push(update);
  } else {
    const merged = mergeEntryFields(entry, candidate);
    const update: Extract<ReferenceLibraryOp, { op: "update" }> = { op: "update", id: entry.id };
    const csl: Partial<CslItem> = {};
    const provenance: Record<string, FieldProvenance> = {};
    for (const [field, value] of Object.entries(merged.csl)) {
      if (stable(value) === stable(entry.csl[field])) continue;
      csl[field] = value;
      const source = merged.provenance?.[field];
      if (source) provenance[field] = source;
    }
    if (Object.keys(csl).length) update.csl = csl;
    if (Object.keys(provenance).length) update.provenance = provenance;
    if (stable(merged.identifiers) !== stable(entry.identifiers)) update.identifiers = merged.identifiers;
    if (stable(merged.tags ?? []) !== stable(entry.tags ?? [])) update.tags = merged.tags;
    if (merged.notes !== entry.notes && merged.notes !== undefined) update.notes = merged.notes;
    const versions = withVersion(entry, link);
    if (versions) update.versions = versions;
    if (Object.keys(update).length > 2) ops.push(update);
  }
  ops.push(...attachCandidateOps(entry, candidate));
  return ops;
}

// ---------------------------------------------------------------------------
// Re-resolve
// ---------------------------------------------------------------------------

/**
 * What to resolve an entry from: its best identifier (DOI > arXiv > PMID >
 * ISBN > URL), else its PDF, else its title and authors as a reference.
 */
export function reresolveRequest(entry: ReferenceEntry): { input: string } | { path: string } | null {
  const { csl, identifiers } = entry;
  const doi = identifiers.doi ?? (typeof csl.DOI === "string" && csl.DOI.trim() ? csl.DOI.trim() : undefined);
  if (doi) return { input: doi };
  if (identifiers.arxiv) return { input: `arXiv:${identifiers.arxiv}` };
  const pmid = identifiers.pmid ?? (typeof csl.PMID === "string" && csl.PMID.trim() ? csl.PMID.trim() : undefined);
  if (pmid) return { input: `PMID: ${pmid}` };
  const isbn = identifiers.isbn?.[0] ?? (typeof csl.ISBN === "string" && csl.ISBN.trim() ? csl.ISBN.trim() : undefined);
  if (isbn) return { input: `ISBN ${isbn}` };
  const url = typeof csl.URL === "string" && /^https?:\/\//i.test(csl.URL.trim()) ? csl.URL.trim() : entry.attachments.find((attachment) => attachment.kind === "url")?.url;
  if (url) return { input: url };
  const pdf = entry.attachments.find((attachment) => attachment.kind === "pdf");
  if (pdf && pdf.kind === "pdf") return { path: pdf.path };
  if (typeof csl.title === "string" && csl.title.trim()) return { input: formatPlainReference(csl) };
  return null;
}

export type ReresolveRow = {
  field: string;
  current: unknown;
  resolved: unknown;
  currentProvenance?: FieldProvenance;
  resolvedProvenance?: FieldProvenance;
  /** The current value is the user's: it is never replaced without their say. */
  userOwned: boolean;
  /** The entry has no value for this field yet. */
  added: boolean;
};

const DIFF_ORDER = ["type", "title", "author", "editor", "issued", "container-title", "volume", "issue", "page", "publisher", "publisher-place", "DOI", "URL", "ISBN", "ISSN", "PMID", "PMCID"];

/** The fields where the resolved candidate differs from the entry (fields it lacks are left alone). */
export function reresolveDiff(entry: ReferenceEntry, candidate: ReferenceEntryInput): ReresolveRow[] {
  const rows: ReresolveRow[] = [];
  for (const [field, resolved] of Object.entries(candidate.csl)) {
    if (!hasValue(resolved)) continue;
    const current = entry.csl[field];
    if (stable(current) === stable(resolved)) continue;
    const added = !hasValue(current);
    rows.push({
      field, current, resolved,
      currentProvenance: entry.provenance[field],
      resolvedProvenance: candidate.provenance?.[field],
      userOwned: !added && entry.provenance[field]?.source === "user",
      added,
    });
  }
  const rank = (field: string) => {
    const index = DIFF_ORDER.indexOf(field);
    return index < 0 ? DIFF_ORDER.length : index;
  };
  return rows.sort((a, b) => rank(a.field) - rank(b.field) || a.field.localeCompare(b.field));
}

const IDENTIFIER_FIELDS: Record<string, keyof ReferenceIdentifiers> = { DOI: "doi", ISBN: "isbn", PMID: "pmid", PMCID: "pmcid" };

/**
 * The one `update` that applies a re-resolve. Accepted fields take the
 * resolved value and provenance. A differing field the user wrote that is
 * not accepted keeps the user's value and gets the resolved one as a
 * conflict. Missing identifiers and version links are filled in. Status
 * becomes needs-review unless `confirm`.
 */
export function buildReresolveOp(entry: ReferenceEntry, candidate: ReferenceEntryInput, accepted: Iterable<string>, options: { confirm?: boolean; keepStatus?: boolean; now?: string } = {}) {
  const take = new Set(accepted);
  const now = options.now ?? new Date().toISOString();
  const op: Extract<ReferenceLibraryOp, { op: "update" }> = { op: "update", id: entry.id };
  const csl: Partial<CslItem> = {};
  const provenance: Record<string, FieldProvenance> = {};
  const conflicts: Record<string, FieldAlternative[] | null> = {};
  for (const row of reresolveDiff(entry, candidate)) {
    if (take.has(row.field)) {
      csl[row.field] = row.resolved;
      if (row.resolvedProvenance) provenance[row.field] = row.resolvedProvenance;
      const alternatives = candidate.conflicts?.[row.field];
      if (alternatives?.length) conflicts[row.field] = alternatives;
      else if (entry.conflicts?.[row.field]?.length) conflicts[row.field] = null;
    } else if (row.userOwned) {
      const existing = (entry.conflicts?.[row.field] ?? []).filter((alternative) => stable(alternative.value) !== stable(row.resolved));
      conflicts[row.field] = [...existing, { value: row.resolved, provenance: row.resolvedProvenance ?? { source: "import", confidence: 0.5, retrievedAt: now } }];
    }
  }
  if (Object.keys(csl).length) op.csl = csl;
  if (Object.keys(provenance).length) op.provenance = provenance;
  if (Object.keys(conflicts).length) op.conflicts = conflicts;

  const identifiers: ReferenceIdentifiers = { ...entry.identifiers };
  for (const [name, value] of Object.entries(candidate.identifiers ?? {}) as Array<[keyof ReferenceIdentifiers, ReferenceIdentifiers[keyof ReferenceIdentifiers]]>) {
    const field = Object.keys(IDENTIFIER_FIELDS).find((key) => IDENTIFIER_FIELDS[key] === name);
    if (value !== undefined && (!hasValue(identifiers[name]) || (field && take.has(field)))) (identifiers as Record<string, unknown>)[name] = value;
  }
  if (stable(identifiers) !== stable(entry.identifiers)) op.identifiers = identifiers;
  const versions = [...(entry.versions ?? [])];
  for (const link of candidate.versions ?? []) {
    if (!versions.some((version) => version.relation === link.relation && version.identifier.toLowerCase() === link.identifier.toLowerCase())) versions.push(link);
  }
  if (versions.length !== (entry.versions?.length ?? 0)) op.versions = versions;
  if (!options.keepStatus) op.status = options.confirm ? "confirmed" : "needs-review";
  return op;
}

/** Resolve an entry again; the first candidate is the resolved version. */
export async function reresolveEntry(notebook: string, entry: ReferenceEntry, webSearch: boolean, signal?: AbortSignal) {
  const request = reresolveRequest(entry);
  if (!request) throw new Error(`${entry.key} has no identifier, PDF or title to look up.`);
  const result = await resolveReference({ notebook, ...request, webSearch }, signal);
  const candidate = result.candidates[0];
  if (!candidate) throw new Error(`Nothing was found for ${entry.key}.`);
  return { candidate, warnings: result.warnings, request };
}

// ---------------------------------------------------------------------------
// The candidate cards
// ---------------------------------------------------------------------------

const CARD_FIELDS = ["title", "author", "editor", "issued", "container-title", "volume", "issue", "page", "publisher", "edition", "DOI", "URL", "ISBN", "PMID", "PMCID", "note"];

function candidateFields(candidate: ReferenceEntryInput) {
  const conflicted = pendingConflicts(candidate);
  return [
    ...CARD_FIELDS.filter((field) => hasValue(candidate.csl[field]) || conflicted.includes(field)),
    ...Object.keys(candidate.csl).filter((field) => !CARD_FIELDS.includes(field) && field !== "type" && field !== "abstract" && hasValue(candidate.csl[field])),
    ...conflicted.filter((field) => !CARD_FIELDS.includes(field) && !hasValue(candidate.csl[field])),
  ];
}

function updateLabel(op: ReferenceLibraryOp, library: ReferenceLibrary) {
  const key = "id" in op ? library.entries[op.id]?.key ?? "an entry" : "the library";
  if (op.op === "attach") return <>Attach <span className="font-medium">{op.attachment.kind === "url" ? op.attachment.url : fileBaseName(op.attachment.path)}</span> to <span className="font-mono">{key}</span></>;
  return <>Update <span className="font-mono">{key}</span></>;
}

function updateTarget(updates: ReferenceLibraryOp[]) {
  const op = updates.find((item) => "id" in item);
  return op && "id" in op ? op.id : undefined;
}

type CandidateListProps = {
  notebook: string;
  library: ReferenceLibrary;
  result: ResolveResponse;
  busy: boolean;
  /** Apply ops as one transaction; `revealId` is the entry to show afterwards (else a single added entry). */
  onCommit: (ops: ReferenceLibraryOp[], label: string, revealId?: string) => Promise<void>;
  /** Open the edit form prefilled with the candidate; `extraOps` are applied with the new entry. */
  onEdit: (candidate: ReferenceEntryInput, extraOps: ReferenceLibraryOp[]) => void;
  onReveal: (entryId: string) => void;
};

/** The confirmation view for /resolve results: one card per candidate, with checkboxes and "Add selected" for several. */
export function CandidateList({ notebook, library, result, busy, onCommit, onEdit, onReveal }: CandidateListProps) {
  const [drafts, setDrafts] = useState(() => result.candidates.map((candidate) => structuredClone(candidate)));
  const duplicatesOf = useMemo(() => result.candidates.map((_, index) => result.duplicates
    .filter((duplicate) => duplicate.candidateIndex === index && library.entries[duplicate.entryId])
    .map((duplicate) => ({ ...duplicate, entry: library.entries[duplicate.entryId] }))), [result, library]);
  const [selected, setSelected] = useState(() => result.candidates.map((_, index) => !result.duplicates.some((duplicate) => duplicate.candidateIndex === index)));
  const multiple = drafts.length > 1;
  const updates = result.updates;
  const chosen = drafts.filter((_, index) => selected[index]);

  const setDraft = (index: number, next: ReferenceEntryInput) => setDrafts((current) => current.map((draft, position) => position === index ? next : draft));
  const add = (entries: ReferenceEntryInput[], label: string) => onCommit([...entries.map((entry): ReferenceLibraryOp => ({ op: "add", entry })), ...updates], label);

  return (
    <div className="space-y-2" aria-label="Candidates">
      {result.warnings.length ? (
        <ul className="space-y-0.5 rounded-lg bg-muted p-2 text-[11px] leading-relaxed text-muted-foreground" aria-label="Lookup warnings">
          {result.warnings.map((warning, index) => <li key={index} className="flex gap-1.5"><AlertCircle aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />{warning}</li>)}
        </ul>
      ) : null}
      {!drafts.length && !updates.length ? <p className="text-[12px] text-muted-foreground">Nothing was found for this input.</p> : null}
      {multiple ? (
        <div className="flex items-center gap-2 text-[11px]">
          <span className="flex-1 text-muted-foreground">{drafts.length} references found. Untick the ones you do not want.</span>
          <button type="button" className="font-medium text-accent hover:underline" onClick={() => setSelected(drafts.map(() => !selected.every(Boolean)))}>{selected.every(Boolean) ? "Select none" : "Select all"}</button>
        </div>
      ) : null}
      <div className={multiple ? "max-h-[28rem] space-y-2 overflow-auto" : "space-y-2"}>
        {drafts.map((draft, index) => (
          <CandidateCard
            key={index}
            index={index}
            notebook={notebook}
            styleSetting={library.style}
            candidate={draft}
            duplicates={duplicatesOf[index]}
            multiple={multiple}
            selected={selected[index]}
            busy={busy}
            onSelect={(value) => setSelected((current) => current.map((item, position) => position === index ? value : item))}
            onChange={(next) => setDraft(index, next)}
            onAdd={(confirm) => add([confirm ? { ...draft, status: "confirmed" } : draft], "Add reference")}
            onAttach={(entry) => onCommit([...attachCandidateOps(entry, draft), ...updates], `Attach to ${entry.key}`, entry.id)}
            onMerge={(entry, preprintPair) => onCommit([...mergeCandidateOps(entry, draft, { preprintPair }), ...updates], `Merge into ${entry.key}`, entry.id)}
            onEdit={() => onEdit(draft, updates)}
            onReveal={onReveal}
          />
        ))}
      </div>
      {updates.length ? (
        <div className="space-y-1 rounded-lg border border-dashed border-input p-2 text-[11px]" aria-label="Updates">
          <p className="text-muted-foreground">{drafts.length ? "Also, after you confirm:" : "This file belongs to an entry you already have:"}</p>
          <ul className="space-y-0.5">{updates.map((op, index) => <li key={index}>{updateLabel(op, library)}</li>)}</ul>
          {!drafts.length ? (
            <div className="flex justify-end">
              <button type="button" className="libera-panel-primary h-7 px-3 text-[12px]" disabled={busy} onClick={() => void onCommit(updates, "Attach file", updateTarget(updates))}>
                <Paperclip aria-hidden className="h-3.5 w-3.5" /> Attach
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {multiple ? (
        <div className="flex justify-end">
          <button type="button" className="libera-panel-primary h-7 px-3 text-[12px]" disabled={busy || !chosen.length} onClick={() => void add(chosen, `Add ${chosen.length} references`)}>
            <Plus aria-hidden className="h-3.5 w-3.5" /> Add selected ({chosen.length})
          </button>
        </div>
      ) : null}
    </div>
  );
}

type CardProps = {
  index: number;
  notebook: string;
  styleSetting: string;
  candidate: ReferenceEntryInput;
  duplicates: Array<ResolveDuplicate & { entry: ReferenceEntry }>;
  multiple: boolean;
  selected: boolean;
  busy: boolean;
  onSelect: (selected: boolean) => void;
  onChange: (candidate: ReferenceEntryInput) => void;
  onAdd: (confirm: boolean) => void;
  onAttach: (entry: ReferenceEntry) => void;
  onMerge: (entry: ReferenceEntry, preprintPair: boolean) => void;
  onEdit: () => void;
  onReveal: (entryId: string) => void;
};

function PreprintExplanation({ candidate, entry }: { candidate: ReferenceEntryInput; entry: ReferenceEntry }) {
  return isPreprint(candidate) ? (
    <p className="text-[11px] leading-relaxed text-muted-foreground" data-preprint="candidate">
      This is a preprint of <span className="font-mono">{entry.key}</span>, which is the published version. Libera keeps one work for both: merging links the preprint to <span className="font-mono">{entry.key}</span> and keeps its published metadata and key.
    </p>
  ) : (
    <p className="text-[11px] leading-relaxed text-muted-foreground" data-preprint="entry">
      This is the published version of <span className="font-mono">{entry.key}</span>, a preprint. Libera keeps one work for both: merging updates <span className="font-mono">{entry.key}</span> with the published metadata (fields you wrote are kept and the new values offered next to them), links the preprint as a version, and keeps the key so citations still work.
    </p>
  );
}

function CandidateCard({ index, notebook, styleSetting, candidate, duplicates, multiple, selected, busy, onSelect, onChange, onAdd, onAttach, onMerge, onEdit, onReveal }: CardProps) {
  const fields = candidateFields(candidate);
  const blocker = confirmBlocker(candidate);
  const status = candidate.status ?? "needs-review";
  const formattable = { id: `candidate-${index}`, key: candidate.key || `candidate${index}`, csl: candidate.csl };
  const actionClass = "libera-panel-button h-7 px-2 text-[11px]";
  return (
    <div className="space-y-1.5 rounded-lg border border-input p-2 text-[12px]" data-candidate={index} aria-label={`Candidate ${index + 1}`} role="group">
      <div className="flex items-start gap-2">
        {multiple ? <input type="checkbox" className="mt-0.5" checked={selected} aria-label={`Include candidate ${index + 1}`} onChange={(event) => onSelect(event.target.checked)} /> : null}
        <FormattedReference className="min-w-0 flex-1 text-[12px] leading-relaxed" notebook={notebook} setting={styleSetting} entry={formattable} />
        <span className="libera-reference-badge shrink-0" data-status={status}>{STATUS_LABELS[status]}</span>
      </div>

      {duplicates.map((duplicate) => (
        <div key={duplicate.entryId} className="space-y-1 rounded-md bg-muted p-1.5" data-duplicate={duplicate.entryId}>
          <p className="flex items-center gap-1 text-[11px] text-destructive">
            <AlertCircle aria-hidden className="h-3 w-3 shrink-0" /> Already in your library as <button type="button" className="font-mono underline" onClick={() => onReveal(duplicate.entryId)}>{duplicate.entry.key}</button>
          </p>
          {duplicate.preprintPair ? <PreprintExplanation candidate={candidate} entry={duplicate.entry} /> : null}
          {!multiple ? (
            <div className="flex flex-wrap justify-end gap-1">
              {newAttachments(duplicate.entry, candidate).length ? (
                <button type="button" className={actionClass} disabled={busy} onClick={() => onAttach(duplicate.entry)}><Paperclip aria-hidden className="h-3 w-3" /> Attach to existing</button>
              ) : null}
              <button type="button" className={actionClass} disabled={busy} onClick={() => onMerge(duplicate.entry, Boolean(duplicate.preprintPair))}><GitMerge aria-hidden className="h-3 w-3" /> Merge into existing</button>
            </div>
          ) : null}
        </div>
      ))}

      {!multiple || fields.some((field) => candidate.conflicts?.[field]?.length) ? (
        <dl className="space-y-0.5" aria-label="Candidate fields">
          {fields.filter((field) => !multiple || candidate.conflicts?.[field]?.length).map((field) => {
            const alternatives = candidate.conflicts?.[field] ?? [];
            return (
              <div key={field} className="libera-reference-field" data-field={field} data-conflict={alternatives.length ? true : undefined}>
                <dt className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate">{fieldLabel(field)}</span>
                  <ProvenanceChip provenance={candidate.provenance?.[field]} />
                </dt>
                <dd className="min-w-0 break-words text-[12px]">
                  {hasValue(candidate.csl[field]) ? formatFieldValue(field, candidate.csl[field]) : <span className="text-muted-foreground">—</span>}
                  {alternatives.length ? (
                    <div className="mt-1 space-y-1 rounded-lg border border-dashed border-input p-1.5" role="group" aria-label={`Other values for ${fieldLabel(field)}`}>
                      <p className="text-[11px] text-muted-foreground">Sources disagree. Keep this value or choose another before adding:</p>
                      {alternatives.map((alternative, position) => (
                        <div key={position} className="flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 break-words">{formatFieldValue(field, alternative.value)}</span>
                          <ProvenanceChip provenance={alternative.provenance} />
                          <button type="button" className="libera-panel-button h-6 shrink-0 px-2 text-[11px]" aria-label={`Use ${formatFieldValue(field, alternative.value)} from ${PROVENANCE_LABELS[alternative.provenance.source]}`} onClick={() => onChange(chooseCandidateAlternative(candidate, field, alternative))}>Use</button>
                        </div>
                      ))}
                      <button type="button" className="text-[11px] font-medium text-accent hover:underline" onClick={() => onChange(keepCandidateValue(candidate, field))}>Keep this value</button>
                    </div>
                  ) : null}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-1">
        <button type="button" className={actionClass} disabled={busy} onClick={onEdit}><Pencil aria-hidden className="h-3 w-3" /> Edit before adding</button>
        {!multiple ? (
          <>
            <button type="button" className={actionClass} disabled={busy || Boolean(blocker)} title={blocker ?? "Add as confirmed"} onClick={() => onAdd(true)}>
              <BadgeCheck aria-hidden className="h-3 w-3" /> Add &amp; confirm
            </button>
            <button type="button" className="libera-panel-primary h-7 px-3 text-[12px]" disabled={busy} onClick={() => onAdd(false)}>
              <Check aria-hidden className="h-3.5 w-3.5" /> {duplicates.length ? "Add anyway" : "Add"}
            </button>
          </>
        ) : null}
      </div>
      {!multiple && blocker ? <p className="text-right text-[10px] text-muted-foreground" aria-label="Why it cannot be confirmed">{blocker}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Re-resolve dialog
// ---------------------------------------------------------------------------

function diffValue(field: string, value: unknown) {
  const text = hasValue(value) ? formatFieldValue(field, value) : "—";
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

type ReresolveDialogProps = {
  notebook: string;
  entry: ReferenceEntry;
  webSearch: boolean;
  onLookup?: () => void;
  onClose: () => void;
  onApply: (op: ReferenceLibraryOp, label: string) => Promise<unknown>;
};

/** Re-resolve one entry: look it up again, show current vs resolved fields, apply the chosen ones as one update. */
export function ReresolveDialog({ notebook, entry, webSearch, onLookup, onClose, onApply }: ReresolveDialogProps) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ready"; candidate: ReferenceEntryInput; rows: ReresolveRow[]; warnings: string[] }
  >({ kind: "loading" });
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const entryRef = useRef(entry);
  const lookupRef = useRef(onLookup);

  useEffect(() => {
    const controller = new AbortController();
    lookupRef.current?.();
    reresolveEntry(notebook, entryRef.current, webSearch, controller.signal).then(({ candidate, warnings }) => {
      const rows = reresolveDiff(entryRef.current, candidate);
      setAccepted(new Set(rows.filter((row) => !row.userOwned).map((row) => row.field)));
      setState({ kind: "ready", candidate, rows, warnings });
    }, (lookupError: unknown) => {
      if (controller.signal.aborted) return;
      setState({ kind: "error", message: lookupError instanceof Error ? lookupError.message : "The reference could not be looked up." });
    });
    return () => controller.abort();
  }, [notebook, webSearch]);

  async function apply() {
    if (state.kind !== "ready") return;
    setBusy(true);
    setError("");
    try {
      await onApply(buildReresolveOp(entry, state.candidate, accepted, { confirm }), `Re-resolve ${entry.key}`);
      onClose();
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "The change could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const keptMine = state.kind === "ready" ? state.rows.filter((row) => row.userOwned && !accepted.has(row.field)).length : 0;
  return (
    <ModalDialog
      open
      title={`Re-resolve ${entry.key}`}
      description="Look the reference up again and choose which resolved values to use."
      panelClassName="max-w-2xl"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted" onClick={onClose}>{state.kind === "loading" ? "Cancel" : "Close"}</button>
          {state.kind === "ready" && state.rows.length ? (
            <button type="button" className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90" disabled={busy} onClick={() => void apply()}>Apply</button>
          ) : null}
        </>
      }
    >
      <div className="space-y-3 text-sm" aria-label="Re-resolve">
        {error ? <div role="alert" className="rounded-lg bg-destructive-muted p-2.5 text-xs text-destructive">{error}</div> : null}
        {state.kind === "loading" ? (
          <p className="flex items-center gap-2 text-muted-foreground" role="status"><Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Looking up {entry.key}…</p>
        ) : state.kind === "error" ? (
          <div role="alert" className="rounded-lg bg-destructive-muted p-2.5 text-xs text-destructive">{state.message}</div>
        ) : (
          <>
            {state.warnings.length ? <ul className="text-xs text-muted-foreground">{state.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
            {state.rows.length ? (
              <>
                <table className="w-full text-xs" aria-label="Changes">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="w-8" />
                      <th className="w-28 py-1 font-medium">Field</th>
                      <th className="py-1 font-medium">Current</th>
                      <th className="py-1 font-medium">Resolved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.rows.map((row) => (
                      <tr key={row.field} className="border-t border-border align-top" data-field={row.field} data-user={row.userOwned || undefined}>
                        <td className="py-1">
                          <input type="checkbox" aria-label={`Use the resolved ${fieldLabel(row.field).toLowerCase()}`} checked={accepted.has(row.field)} onChange={(event) => setAccepted((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(row.field);
                            else next.delete(row.field);
                            return next;
                          })} />
                        </td>
                        <td className="py-1 text-muted-foreground">{fieldLabel(row.field)}</td>
                        <td className="break-words py-1 pr-2">
                          {diffValue(row.field, row.current)} <ProvenanceChip provenance={row.currentProvenance} />
                        </td>
                        <td className="break-words py-1">
                          {diffValue(row.field, row.resolved)} <ProvenanceChip provenance={row.resolvedProvenance} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {keptMine ? <p className="text-xs text-muted-foreground">{keptMine} field{keptMine === 1 ? "" : "s"} you wrote will be kept, with the resolved value offered next to {keptMine === 1 ? "it" : "them"} on the card.</p> : null}
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={confirm} onChange={(event) => setConfirm(event.target.checked)} /> Mark as confirmed (otherwise it needs review)
                </label>
              </>
            ) : <p className="text-muted-foreground">The sources agree with this entry. Nothing to change.</p>}
          </>
        )}
      </div>
    </ModalDialog>
  );
}
