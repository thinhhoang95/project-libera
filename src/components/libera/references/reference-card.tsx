"use client";

import { ArrowLeft, BookCheck, BookOpen, Braces, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsRight, Copy, ExternalLink, FileText, FileType2, Globe, Link2, Loader2, Paperclip, Pencil, Quote, RotateCw, Trash2, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  authorYearLabel,
  citationText,
  entryTitle,
  fieldLabel,
  fileBaseName,
  formatFieldValue,
  PROVENANCE_LABELS,
  READING_LABELS,
  STATUS_LABELS,
  typeLabel,
} from "@/components/libera/references/reference-display";
import { FormattedReference } from "@/components/libera/references/reference-candidates";
import { RetractionBadge } from "@/components/libera/references/retraction-badge";
import { userProvenance } from "@/components/libera/references/reference-edit-form";
import { CITE_UNAVAILABLE, StatusBadge } from "@/components/libera/references/reference-row";
import { isValidCitationKey } from "@/lib/references/keys";
import { citationSnippets, type CitationSnippet } from "@/lib/references/occurrences";
import { formatNameForDisplay, parsePersonList } from "@/lib/references/names";
import { parseDateText } from "@/lib/references/normalize";
import type {
  CslName,
  FieldAlternative,
  FieldProvenance,
  ReadingState,
  ReferenceAttachment,
  ReferenceEntry,
  ReferenceLibrary,
  ReferenceLibraryOp,
} from "@/lib/references/types";

// The detail card: a confirmation card, not a form. It shows the entry with
// a provenance chip per field, the competing values where sources disagree,
// and inline editing only where it is needed: low-confidence fields, or every
// field while the entry still needs review. "Edit all fields" is the escape
// hatch.

export const LOW_CONFIDENCE = 0.7;
export const NOTES_SAVE_DELAY_MS = 800;

/** Fields the card lists, in order; any other field with a value follows. */
const CARD_FIELDS = [
  "title", "author", "editor", "issued", "container-title", "collection-title", "event-title",
  "volume", "issue", "page", "publisher", "publisher-place", "edition", "number", "genre",
  "DOI", "URL", "ISBN", "ISSN", "PMID", "PMCID", "language", "note",
];
/** Shown in their own sections, not as field rows. */
const SEPARATE_FIELDS = new Set(["type", "abstract"]);
const NAME_FIELDS = new Set(["author", "editor", "translator", "container-author", "collection-editor"]);
const DATE_FIELDS = new Set(["issued", "accessed", "original-date", "event-date"]);

export function ProvenanceChip({ provenance }: { provenance?: FieldProvenance }) {
  if (!provenance) return null;
  const label = PROVENANCE_LABELS[provenance.source] ?? provenance.source;
  const details = [
    `${label}: confidence ${Math.round(provenance.confidence * 100)}%`,
    provenance.retrievedAt ? `retrieved ${provenance.retrievedAt.slice(0, 10)}` : "",
    provenance.url ?? "",
  ].filter(Boolean).join(" · ");
  const low = provenance.confidence < LOW_CONFIDENCE;
  if (provenance.url) {
    return (
      <a className="libera-reference-chip" data-source={provenance.source} data-low={low || undefined} href={provenance.url} target="_blank" rel="noreferrer" title={details}>
        {label}
        <ExternalLink aria-hidden className="h-2.5 w-2.5" />
      </a>
    );
  }
  return <span className="libera-reference-chip" data-source={provenance.source} data-low={low || undefined} title={details}>{label}</span>;
}

/** A value as text for inline editing; names family-first so they parse back. */
function editableText(field: string, value: unknown) {
  if (NAME_FIELDS.has(field) && Array.isArray(value)) return (value as CslName[]).map((name) => formatNameForDisplay(name, { order: "family-first" })).join("; ");
  return formatFieldValue(field, value);
}

/** Inline text back into a CSL value. Undefined clears the field. */
function parseInline(field: string, text: string): unknown {
  const value = text.trim();
  if (!value) return undefined;
  if (NAME_FIELDS.has(field)) return parsePersonList(value);
  if (DATE_FIELDS.has(field)) return parseDateText(value) ?? { literal: value };
  return value;
}

function identifierLinks(entry: ReferenceEntry): Array<{ label: string; value: string; href?: string }> {
  const { doi, arxiv, pmid, pmcid, isbn, openalex } = entry.identifiers;
  const links: Array<{ label: string; value: string; href?: string }> = [];
  if (doi) links.push({ label: "DOI", value: doi, href: `https://doi.org/${doi}` });
  if (arxiv) links.push({ label: "arXiv", value: arxiv, href: `https://arxiv.org/abs/${arxiv}` });
  if (pmid) links.push({ label: "PubMed", value: pmid, href: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` });
  if (pmcid) links.push({ label: "PMC", value: pmcid, href: `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/` });
  if (openalex) links.push({ label: "OpenAlex", value: openalex, href: `https://openalex.org/${openalex}` });
  for (const value of isbn ?? []) links.push({ label: "ISBN", value });
  return links;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="px-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

type CardProps = {
  notebook: string;
  entry: ReferenceEntry;
  library: ReferenceLibrary;
  citing: string[];
  canCite: boolean;
  apply: (ops: ReferenceLibraryOp[], label: string) => Promise<unknown>;
  onBack: () => void;
  onCite: () => void;
  onCopy: (text: string, what: string) => void;
  /** Copy the reference formatted in the notebook's style, as text and HTML. */
  onCopyFormatted: () => void;
  /** Look the entry up again and review the differences. */
  onReresolve: () => void;
  onOpenPath: (path: string) => void;
  onEditAll: () => void;
  onDelete: () => void;
  /** After a key rename: offer to rewrite the citations that still use the old key (now an alias). */
  onUpdateCitations?: (from: string, to: string) => void;
  /** Where the entry is in the panel's list, for the previous/next buttons. */
  position?: { index: number; total: number };
  onPrevious?: () => void;
  onNext?: () => void;
  /** Other entries in the list that still need review; with any, Confirm offers to go on to the next. */
  reviewLeft?: number;
  onConfirmNext?: () => void;
  /** PDFs and notes of the notebook that can be attached. */
  attachableFiles?: Array<{ path: string; kind: "pdf" | "markdown" }>;
  /** Every tag in the library, for completion. */
  knownTags?: string[];
  onTag?: (tag: string) => void;
  /** The Markdown text of a citing document: its open draft, else the saved file. */
  loadDocument?: (path: string) => Promise<string>;
  /** Open a citing document at a citation. */
  onOpenCitation?: (path: string, snippet: CitationSnippet) => void;
};

export const CONFIRM_NEXT_SHORTCUT = "⌘/Ctrl+Shift+Enter";

export function ReferenceCard({ notebook, entry, library, citing, canCite, apply, onBack, onCite, onCopy, onCopyFormatted, onReresolve, onOpenPath, onEditAll, onDelete, onUpdateCitations, position, onPrevious, onNext, reviewLeft = 0, onConfirmNext, attachableFiles, knownTags, onTag, loadDocument, onOpenCitation }: CardProps) {
  const [error, setError] = useState("");
  const reviewing = entry.status !== "confirmed";

  async function run(ops: ReferenceLibraryOp[], label: string) {
    setError("");
    try {
      await apply(ops, label);
      return true;
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "The change could not be saved.");
      return false;
    }
  }

  const fields = [
    ...CARD_FIELDS.filter((field) => entry.csl[field] !== undefined || entry.conflicts?.[field]?.length),
    ...Object.keys(entry.csl).filter((field) => !CARD_FIELDS.includes(field) && !SEPARATE_FIELDS.has(field)),
    ...Object.keys(entry.conflicts ?? {}).filter((field) => !CARD_FIELDS.includes(field) && entry.csl[field] === undefined && !SEPARATE_FIELDS.has(field) && entry.conflicts?.[field]?.length),
  ];
  const identifiers = identifierLinks(entry);

  return (
    <div className="libera-reference-card flex min-h-0 flex-1 flex-col overflow-hidden outline-none" aria-label={`Reference ${entry.key}`} role="region" tabIndex={-1}>
      <div className="flex items-center gap-1 px-2 pb-1 pt-1">
        <button type="button" className="libera-sidebar-icon-button inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs" aria-label="Back to references" title="Back to references (Esc)" onClick={onBack}>
          {/* With the previous/next buttons there is room for the arrow only. */}
          <ArrowLeft aria-hidden className="h-3.5 w-3.5" />{position && position.total > 1 ? null : " References"}
        </button>
        {position && position.total > 1 ? (
          <div className="flex items-center" role="group" aria-label="Move through the list">
            <button type="button" className="libera-sidebar-icon-button inline-flex h-8 w-6 items-center justify-center rounded-lg disabled:opacity-40" aria-label="Previous reference" title="Previous reference (↑)" disabled={!onPrevious || position.index <= 0} onClick={onPrevious}>
              <ChevronLeft aria-hidden className="h-4 w-4" />
            </button>
            <span className="min-w-10 text-center text-[11px] tabular-nums text-muted-foreground" aria-label={`Reference ${position.index + 1} of ${position.total}`}>{position.index + 1}/{position.total}</span>
            <button type="button" className="libera-sidebar-icon-button inline-flex h-8 w-6 items-center justify-center rounded-lg disabled:opacity-40" aria-label="Next reference" title="Next reference (↓)" disabled={!onNext || position.index >= position.total - 1} onClick={onNext}>
              <ChevronRight aria-hidden className="h-4 w-4" />
            </button>
          </div>
        ) : null}
        <div className="flex-1" />
        <button type="button" className="libera-sidebar-icon-button inline-flex h-8 w-7 shrink-0 items-center justify-center rounded-lg disabled:opacity-40" aria-label="Cite at cursor" title={canCite ? "Cite at cursor" : CITE_UNAVAILABLE} disabled={!canCite} onClick={onCite}>
          <Quote aria-hidden className="h-4 w-4" />
        </button>
        <button type="button" className="libera-sidebar-icon-button inline-flex h-8 w-7 shrink-0 items-center justify-center rounded-lg" aria-label="Re-resolve" title="Look this reference up again" onClick={onReresolve}>
          <RotateCw aria-hidden className="h-4 w-4" />
        </button>
        <button type="button" className="libera-sidebar-icon-button inline-flex h-8 w-7 shrink-0 items-center justify-center rounded-lg" aria-label="Edit all fields" title="Edit all fields" onClick={onEditAll}>
          <Pencil aria-hidden className="h-4 w-4" />
        </button>
        <button type="button" className="libera-sidebar-icon-button inline-flex h-8 w-7 shrink-0 items-center justify-center rounded-lg" data-tone="destructive" aria-label="Delete reference" title="Delete reference" onClick={onDelete}>
          <Trash2 aria-hidden className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-3 pb-4">
        <div className="libera-panel-card space-y-2 p-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold">{authorYearLabel(entry.csl)}</p>
              <p className="text-[13px] leading-snug">{entryTitle(entry)}</p>
            </div>
            <StatusBadge status={entry.status} />
          </div>
          <RetractionBadge status={entry.retraction} />
          <FormattedReference className="text-[12px] leading-relaxed text-muted-foreground" notebook={notebook} setting={library.style} entry={entry} />
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">{typeLabel(entry.csl.type)}</p>
            <ReadingToggle reading={entry.reading} onChange={(reading) => void run([{ op: "update", id: entry.id, reading }], reading ? `Mark ${entry.key} ${READING_LABELS[reading]}` : `Clear the reading flag of ${entry.key}`)} />
          </div>
          {reviewing ? (
            <div className="flex items-center gap-2 pt-1">
              {onConfirmNext && reviewLeft > 0 ? (
                <>
                  <button type="button" className="libera-panel-primary h-8 flex-1 px-3" title={`Confirm, then open the next reference to review (${CONFIRM_NEXT_SHORTCUT})`} onClick={onConfirmNext}>
                    <ChevronsRight aria-hidden className="h-4 w-4" /> Confirm &amp; next
                  </button>
                  <button type="button" className="libera-panel-button h-8 px-3" onClick={() => void run([{ op: "update", id: entry.id, status: "confirmed" }], `Confirm ${entry.key}`)}>
                    <Check aria-hidden className="h-4 w-4" /> Confirm
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="libera-panel-primary h-8 flex-1 px-3" onClick={() => void run([{ op: "update", id: entry.id, status: "confirmed" }], `Confirm ${entry.key}`)}>
                    <Check aria-hidden className="h-4 w-4" /> Confirm
                  </button>
                  <button type="button" className="libera-panel-button h-8 px-3" onClick={onEditAll}>Edit all fields</button>
                </>
              )}
            </div>
          ) : null}
          {reviewing ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {STATUS_LABELS[entry.status]}: check the fields below, correct any that are wrong, then confirm.
              {onConfirmNext && reviewLeft > 0 ? ` ${reviewLeft} more to review in this list.` : ""}
            </p>
          ) : null}
        </div>

        {error ? <div role="alert" className="rounded-lg bg-destructive-muted p-2.5 text-xs text-destructive">{error}</div> : null}

        <KeyEditor
          entry={entry}
          library={library}
          onRename={(key) => run([{ op: "rename-key", id: entry.id, key }], `Rename ${entry.key}`)}
          onCopy={() => onCopy(entry.key, "Key")}
          onCopyCitation={(format) => onCopy(citationText([entry.key], format), "Citation")}
          onUpdateCitations={onUpdateCitations}
        />

        <Section title="Fields">
          <dl className="space-y-1">
            {fields.map((field) => (
              <FieldRow
                key={field}
                entry={entry}
                field={field}
                editable={reviewing || (entry.provenance[field]?.confidence ?? 1) < LOW_CONFIDENCE}
                onCommit={(value) => {
                  const now = new Date().toISOString();
                  const op: ReferenceLibraryOp = value === undefined
                    ? { op: "update", id: entry.id, removeFields: [field] }
                    : { op: "update", id: entry.id, csl: { [field]: value }, provenance: { [field]: userProvenance(now) } };
                  return run([op], `Edit ${fieldLabel(field).toLowerCase()} of ${entry.key}`);
                }}
                onChoose={(alternative) => run([{
                  op: "update",
                  id: entry.id,
                  csl: { [field]: alternative.value },
                  provenance: { [field]: alternative.provenance },
                  conflicts: { [field]: null },
                }], `Choose ${fieldLabel(field).toLowerCase()} for ${entry.key}`)}
                onKeep={() => run([{ op: "update", id: entry.id, conflicts: { [field]: null } }], `Keep ${fieldLabel(field).toLowerCase()} of ${entry.key}`)}
              />
            ))}
          </dl>
        </Section>

        {typeof entry.csl.abstract === "string" && entry.csl.abstract.trim() ? (
          <Section title="Abstract">
            <p className="whitespace-pre-line text-[12px] leading-relaxed">{entry.csl.abstract}</p>
            <div className="flex justify-end"><ProvenanceChip provenance={entry.provenance.abstract} /></div>
          </Section>
        ) : null}

        {identifiers.length ? (
          <Section title="Identifiers">
            <ul className="space-y-0.5 text-[12px]">
              {identifiers.map((identifier) => (
                <li key={`${identifier.label}:${identifier.value}`} className="flex items-baseline gap-2">
                  <span className="w-16 shrink-0 text-muted-foreground">{identifier.label}</span>
                  {identifier.href
                    ? <a className="min-w-0 truncate font-mono text-accent hover:underline" href={identifier.href} target="_blank" rel="noreferrer">{identifier.value}</a>
                    : <span className="min-w-0 truncate font-mono">{identifier.value}</span>}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <AttachmentsSection
          entry={entry}
          files={attachableFiles}
          onOpenPath={onOpenPath}
          onAttach={(attachment) => run([{ op: "attach", id: entry.id, attachment }], `Attach to ${entry.key}`)}
          onDetach={(attachment) => run([{ op: "detach", id: entry.id, attachment }], `Remove an attachment of ${entry.key}`)}
        />

        <CitingSection entry={entry} citing={citing} onOpenPath={onOpenPath} loadDocument={loadDocument} onOpenCitation={onOpenCitation} />

        <TagEditor tags={entry.tags ?? []} knownTags={knownTags} onTag={onTag} onChange={(tags) => run([{ op: "update", id: entry.id, tags }], `Edit tags of ${entry.key}`)} />
        <NotesEditor entry={entry} onSave={(notes) => run([{ op: "update", id: entry.id, notes }], `Edit notes of ${entry.key}`)} />

        <div className="flex justify-end">
          <button type="button" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={onCopyFormatted}>
            <Copy aria-hidden className="h-3 w-3" /> Copy formatted reference
          </button>
        </div>
      </div>
    </div>
  );
}

function KeyEditor({ entry, library, onRename, onCopy, onCopyCitation, onUpdateCitations }: {
  entry: ReferenceEntry;
  library: ReferenceLibrary;
  onRename: (key: string) => Promise<boolean>;
  onCopy: () => void;
  onCopyCitation: (format: "pandoc" | "latex") => void;
  onUpdateCitations?: (from: string, to: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.key);
  // The last rename in this card, while its old key is still an alias of this entry.
  const [renamed, setRenamed] = useState<{ from: string; to: string } | null>(null);
  const offer = renamed && renamed.to === entry.key && entry.aliases.includes(renamed.from) ? renamed : null;
  const trimmed = draft.trim();
  const takenBy = trimmed && trimmed.toLowerCase() !== entry.key.toLowerCase()
    ? Object.values(library.entries).find((other) => other.id !== entry.id && [other.key, ...other.aliases].some((key) => key.toLowerCase() === trimmed.toLowerCase()))
    : undefined;
  const problem = !trimmed ? "Enter a key." : !isValidCitationKey(trimmed) ? "Keys start with a letter, digit or underscore and contain no spaces." : takenBy ? `“${trimmed}” is already used by ${takenBy.key}.` : "";

  async function save() {
    if (problem) return;
    if (trimmed === entry.key) {
      setEditing(false);
      return;
    }
    const from = entry.key;
    if (await onRename(trimmed)) {
      setEditing(false);
      setRenamed({ from, to: trimmed });
    }
  }

  return (
    <Section title="Citation key">
      {editing ? (
        <form className="space-y-1.5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <div className="flex gap-1.5">
            <input className="libera-panel-field h-8 min-w-0 flex-1 px-2 font-mono text-[12px]" aria-label="New citation key" value={draft} autoFocus onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setEditing(false); } }} />
            <button type="submit" className="libera-panel-button h-8 px-2.5" disabled={Boolean(problem)}>Rename</button>
            <button type="button" className="libera-panel-button h-8 px-2" aria-label="Cancel renaming" onClick={() => setEditing(false)}><X aria-hidden className="h-3.5 w-3.5" /></button>
          </div>
          {problem ? <p role="alert" className="text-[11px] text-destructive">{problem}</p> : (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              <span className="font-mono">{entry.key}</span> stays as an alias, so documents that cite it keep working.
            </p>
          )}
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          <code className="min-w-0 basis-full truncate font-mono text-[12px]" title={entry.key}>{entry.key}</code>
          <button type="button" className="libera-sidebar-icon-button inline-flex h-7 w-7 items-center justify-center rounded-lg" aria-label="Copy key" title="Copy key" onClick={onCopy}><Copy aria-hidden className="h-3.5 w-3.5" /></button>
          <button type="button" className="libera-sidebar-icon-button inline-flex h-7 w-7 items-center justify-center rounded-lg" aria-label={`Copy as [@${entry.key}]`} title={`Copy as [@${entry.key}]`} onClick={() => onCopyCitation("pandoc")}><Quote aria-hidden className="h-3.5 w-3.5" /></button>
          <button type="button" className="libera-sidebar-icon-button inline-flex h-7 w-7 items-center justify-center rounded-lg" aria-label={`Copy as \\cite{${entry.key}}`} title={`Copy as \\cite{${entry.key}}`} onClick={() => onCopyCitation("latex")}><Braces aria-hidden className="h-3.5 w-3.5" /></button>
          <button type="button" className="libera-panel-button ml-auto h-7 px-2.5" onClick={() => { setDraft(entry.key); setEditing(true); }}>Rename key</button>
        </div>
      )}
      {offer && onUpdateCitations ? (
        <div className="flex items-center gap-2 rounded-lg bg-muted/60 p-2 text-[11px]" role="status" aria-label="Key renamed">
          <span className="min-w-0 flex-1">Documents citing <code className="font-mono">{offer.from}</code> still work. Rewrite them to <code className="font-mono">{offer.to}</code>?</span>
          <button type="button" className="libera-panel-button h-7 shrink-0 px-2.5" onClick={() => onUpdateCitations(offer.from, offer.to)}>Update citations…</button>
        </div>
      ) : null}
      {entry.aliases.length ? (
        <p className="text-[11px] text-muted-foreground" aria-label="Aliases">
          Also resolves: {entry.aliases.map((alias, index) => <span key={alias}>{index ? ", " : ""}<code className="font-mono">{alias}</code></span>)}
        </p>
      ) : null}
    </Section>
  );
}

function FieldRow({ entry, field, editable, onCommit, onChoose, onKeep }: {
  entry: ReferenceEntry;
  field: string;
  editable: boolean;
  onCommit: (value: unknown) => Promise<boolean>;
  onChoose: (alternative: FieldAlternative) => void;
  onKeep: () => void;
}) {
  const value = entry.csl[field];
  const text = editableText(field, value);
  const [draft, setDraft] = useState(text);
  const conflicts = entry.conflicts?.[field] ?? [];
  const provenance = entry.provenance[field];
  const label = fieldLabel(field);

  // Follow the stored value when it changes elsewhere.
  const [shownText, setShownText] = useState(text);
  if (shownText !== text) {
    setShownText(text);
    setDraft(text);
  }

  async function commit() {
    if (draft.trim() === text.trim()) return;
    if (!await onCommit(parseInline(field, draft))) setDraft(text);
  }

  return (
    <div className="libera-reference-field" data-field={field} data-conflict={conflicts.length ? true : undefined}>
      <dt className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ProvenanceChip provenance={provenance} />
      </dt>
      <dd className="min-w-0 text-[12px]">
        {editable ? (
          <input
            className="libera-panel-field h-7 w-full px-2 text-[12px]"
            aria-label={label}
            value={draft}
            placeholder={NAME_FIELDS.has(field) ? "Family, Given; Family, Given" : DATE_FIELDS.has(field) ? "2020-05-12" : undefined}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commit();
              } else if (event.key === "Escape") {
                event.stopPropagation();
                setDraft(text);
              }
            }}
          />
        ) : field === "URL" && typeof value === "string" ? (
          <a className="break-all text-accent hover:underline" href={value} target="_blank" rel="noreferrer">{value}</a>
        ) : (
          <span className="break-words">{text || <span className="text-muted-foreground">—</span>}</span>
        )}
        {conflicts.length ? (
          <div className="mt-1 space-y-1 rounded-lg border border-dashed border-input p-1.5" role="group" aria-label={`Other values for ${label}`}>
            <p className="text-[11px] text-muted-foreground">Sources disagree. Keep the current value or choose another:</p>
            {conflicts.map((alternative, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 break-words">{formatFieldValue(field, alternative.value)}</span>
                <ProvenanceChip provenance={alternative.provenance} />
                <button type="button" className="libera-panel-button h-6 shrink-0 px-2 text-[11px]" aria-label={`Use ${formatFieldValue(field, alternative.value)} from ${PROVENANCE_LABELS[alternative.provenance.source]}`} onClick={() => onChoose(alternative)}>Use</button>
              </div>
            ))}
            <button type="button" className="text-[11px] font-medium text-accent hover:underline" onClick={onKeep}>Keep current value</button>
          </div>
        ) : null}
      </dd>
    </div>
  );
}

function TagEditor({ tags, knownTags = [], onTag, onChange }: { tags: string[]; knownTags?: string[]; onTag?: (tag: string) => void; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const listId = `reference-tags-${useId()}`;
  const suggestions = knownTags.filter((tag) => !tags.some((current) => current.toLowerCase() === tag.toLowerCase()));
  function add() {
    const next = draft.split(",").map((tag) => tag.trim()).filter(Boolean);
    setDraft("");
    const merged = [...tags];
    for (const tag of next) if (!merged.some((existing) => existing.toLowerCase() === tag.toLowerCase())) merged.push(tag);
    if (merged.length !== tags.length) onChange(merged);
  }
  return (
    <Section title="Tags">
      <div className="flex flex-wrap items-center gap-1" aria-label="Tags" role="group">
        {tags.map((tag) => (
          <span key={tag} className="libera-reference-tag">
            {onTag ? <button type="button" className="hover:underline" title={`Show references tagged ${tag}`} onClick={() => onTag(tag)}>{tag}</button> : tag}
            <button type="button" aria-label={`Remove tag ${tag}`} onClick={() => onChange(tags.filter((current) => current !== tag))}><X aria-hidden className="h-3 w-3" /></button>
          </span>
        ))}
        <input
          className="libera-panel-field h-7 min-w-24 flex-1 px-2 text-[12px]"
          aria-label="Add tag"
          placeholder="Add tag"
          list={suggestions.length ? listId : undefined}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => { if (draft.trim()) add(); }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              add();
            } else if (event.key === "Backspace" && !draft && tags.length) {
              onChange(tags.slice(0, -1));
            }
          }}
        />
        {suggestions.length ? (
          <datalist id={listId}>
            {suggestions.map((tag) => <option key={tag} value={tag} />)}
          </datalist>
        ) : null}
      </div>
    </Section>
  );
}

function ReadingToggle({ reading, onChange }: { reading?: ReadingState; onChange: (reading: ReadingState | null) => void }) {
  const option = (value: ReadingState, icon: ReactNode) => (
    <button
      type="button"
      className="libera-reference-reading-option inline-flex h-6 items-center gap-1 px-2 text-[11px]"
      aria-pressed={reading === value}
      title={reading === value ? `Clear “${READING_LABELS[value]}”` : `Mark as ${READING_LABELS[value]}`}
      onClick={() => onChange(reading === value ? null : value)}
    >
      {icon} {READING_LABELS[value]}
    </button>
  );
  return (
    <div className="libera-reference-reading-toggle flex shrink-0 overflow-hidden rounded-md border border-input" role="group" aria-label="Reading">
      {option("to-read", <BookOpen aria-hidden className="h-3 w-3" />)}
      {option("read", <BookCheck aria-hidden className="h-3 w-3" />)}
    </div>
  );
}

const WEB_ADDRESS = /^https?:\/\/\S+$/i;

function AttachmentsSection({ entry, files = [], onOpenPath, onAttach, onDetach }: {
  entry: ReferenceEntry;
  files?: Array<{ path: string; kind: "pdf" | "markdown" }>;
  onOpenPath: (path: string) => void;
  onAttach: (attachment: ReferenceAttachment) => Promise<boolean>;
  onDetach: (attachment: ReferenceAttachment) => Promise<boolean>;
}) {
  const [adding, setAdding] = useState<"file" | "link" | null>(null);
  const [query, setQuery] = useState("");
  const [link, setLink] = useState("");
  const attached = new Set(entry.attachments.map((attachment) => attachment.kind === "url" ? attachment.url : attachment.path));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const choices = files
    .filter((file) => !attached.has(file.path) && words.every((word) => file.path.toLowerCase().includes(word)))
    .slice(0, 50);
  const linkProblem = link.trim() && !WEB_ADDRESS.test(link.trim()) ? "Enter a web address starting with http:// or https://." : "";

  async function attachFile(file: { path: string; kind: "pdf" | "markdown" }) {
    if (await onAttach({ kind: file.kind, path: file.path })) setAdding(null);
  }

  async function addLink() {
    const url = link.trim();
    if (!url || linkProblem) return;
    if (await onAttach({ kind: "url", url })) {
      setLink("");
      setAdding(null);
    }
  }

  const removeButton = (attachment: ReferenceAttachment, name: string) => (
    <button type="button" className="libera-sidebar-icon-button inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-0 group-hover:opacity-100 focus-visible:opacity-100" aria-label={`Remove attachment ${name}`} title="Remove the attachment (the file is kept)" onClick={() => void onDetach(attachment)}>
      <X aria-hidden className="h-3 w-3" />
    </button>
  );

  return (
    <Section title="Attachments">
      {entry.attachments.length ? (
        <ul className="space-y-0.5">
          {entry.attachments.map((attachment) => attachment.kind === "url" ? (
            <li key={`url:${attachment.url}`} className="group flex items-center">
              <a className="libera-notebook-row flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-[12px]" href={attachment.url} target="_blank" rel="noreferrer">
                <Globe aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{attachment.url}</span>
              </a>
              {removeButton(attachment, attachment.url)}
            </li>
          ) : (
            <li key={`${attachment.kind}:${attachment.path}`} className="group flex items-center">
              <button type="button" className="libera-notebook-row flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-[12px]" title={attachment.path} onClick={() => onOpenPath(attachment.path)}>
                {attachment.kind === "pdf" ? <FileType2 aria-hidden className="h-3.5 w-3.5 shrink-0 text-[#d08178]" /> : <FileText aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 truncate">{fileBaseName(attachment.path)}</span>
              </button>
              {removeButton(attachment, fileBaseName(attachment.path))}
            </li>
          ))}
        </ul>
      ) : null}
      {adding === "file" ? (
        <div className="space-y-1 rounded-lg border border-input p-1.5" role="group" aria-label="Attach a file">
          <div className="flex gap-1.5">
            <input
              className="libera-panel-field h-7 min-w-0 flex-1 px-2 text-[12px]"
              aria-label="Find a file to attach"
              placeholder="Find a PDF or note in this notebook"
              value={query}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setAdding(null);
                } else if (event.key === "Enter" && choices[0]) {
                  event.preventDefault();
                  void attachFile(choices[0]);
                }
              }}
            />
            <button type="button" className="libera-panel-button h-7 px-2" aria-label="Cancel attaching a file" onClick={() => setAdding(null)}><X aria-hidden className="h-3.5 w-3.5" /></button>
          </div>
          <ul className="max-h-40 overflow-auto" aria-label="Files to attach">
            {choices.map((file) => (
              <li key={file.path}>
                <button type="button" className="libera-notebook-row flex w-full items-center gap-2 px-2 py-1 text-left text-[12px]" title={file.path} onClick={() => void attachFile(file)}>
                  {file.kind === "pdf" ? <FileType2 aria-hidden className="h-3.5 w-3.5 shrink-0 text-[#d08178]" /> : <FileText aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0 truncate">{fileBaseName(file.path)}</span>
                </button>
              </li>
            ))}
            {!choices.length ? <li className="px-2 py-1 text-[11px] text-muted-foreground">{files.length ? "No file matches." : "This notebook has no PDFs or notes to attach."}</li> : null}
          </ul>
        </div>
      ) : adding === "link" ? (
        <form className="space-y-1" onSubmit={(event) => { event.preventDefault(); void addLink(); }}>
          <div className="flex gap-1.5">
            <input className="libera-panel-field h-7 min-w-0 flex-1 px-2 text-[12px]" aria-label="Web address to attach" placeholder="https://" value={link} autoFocus onChange={(event) => setLink(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setAdding(null); } }} />
            <button type="submit" className="libera-panel-button h-7 px-2.5" disabled={!link.trim() || Boolean(linkProblem)}>Add</button>
            <button type="button" className="libera-panel-button h-7 px-2" aria-label="Cancel adding a link" onClick={() => setAdding(null)}><X aria-hidden className="h-3.5 w-3.5" /></button>
          </div>
          {linkProblem ? <p role="alert" className="text-[11px] text-destructive">{linkProblem}</p> : null}
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className="libera-panel-button h-7 px-2.5 text-[12px]" onClick={() => { setQuery(""); setAdding("file"); }}>
            <Paperclip aria-hidden className="h-3.5 w-3.5" /> Attach file…
          </button>
          <button type="button" className="libera-panel-button h-7 px-2.5 text-[12px]" onClick={() => { setLink(""); setAdding("link"); }}>
            <Link2 aria-hidden className="h-3.5 w-3.5" /> Add link
          </button>
          {!entry.attachments.length ? <span className="text-[11px] text-muted-foreground">or drop a PDF on the panel</span> : null}
        </div>
      )}
    </Section>
  );
}

type SnippetState = { state: "loading" } | { state: "error"; message: string } | { state: "done"; snippets: CitationSnippet[] };

function CitingSection({ entry, citing, onOpenPath, loadDocument, onOpenCitation }: {
  entry: ReferenceEntry;
  citing: string[];
  onOpenPath: (path: string) => void;
  loadDocument?: (path: string) => Promise<string>;
  onOpenCitation?: (path: string, snippet: CitationSnippet) => void;
}) {
  const [shown, setShown] = useState<Record<string, SnippetState>>({});
  const keys = useMemo(() => [entry.key, ...entry.aliases], [entry.key, entry.aliases]);
  const canExpand = Boolean(loadDocument && onOpenCitation);

  async function toggle(path: string) {
    if (shown[path]) {
      setShown((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
      return;
    }
    if (!loadDocument) return;
    setShown((current) => ({ ...current, [path]: { state: "loading" } }));
    try {
      const text = await loadDocument(path);
      setShown((current) => current[path] ? { ...current, [path]: { state: "done", snippets: citationSnippets(text, keys) } } : current);
    } catch (loadError) {
      setShown((current) => current[path] ? { ...current, [path]: { state: "error", message: loadError instanceof Error ? loadError.message : "The document could not be read." } } : current);
    }
  }

  return (
    <Section title={`Cited in ${citing.length} document${citing.length === 1 ? "" : "s"}`}>
      {citing.length ? (
        <ul className="space-y-0.5" aria-label="Citing documents">
          {citing.map((path) => {
            const state = shown[path];
            return (
              <li key={path}>
                <div className="flex items-center">
                  {canExpand ? (
                    <button type="button" className="libera-sidebar-icon-button inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md" aria-expanded={Boolean(state)} aria-label={state ? `Hide citations in ${fileBaseName(path)}` : `Show citations in ${fileBaseName(path)}`} onClick={() => void toggle(path)}>
                      {state ? <ChevronDown aria-hidden className="h-3.5 w-3.5" /> : <ChevronRight aria-hidden className="h-3.5 w-3.5" />}
                    </button>
                  ) : null}
                  <button type="button" className="libera-notebook-row flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-[12px]" title={path} onClick={() => onOpenPath(path)}>
                    <FileText aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{fileBaseName(path)}</span>
                  </button>
                </div>
                {state?.state === "loading" ? (
                  <p className="flex items-center gap-1.5 py-1 pl-8 text-[11px] text-muted-foreground"><Loader2 aria-hidden className="h-3 w-3 animate-spin" /> Finding citations…</p>
                ) : state?.state === "error" ? (
                  <p role="alert" className="py-1 pl-8 text-[11px] text-destructive">{state.message}</p>
                ) : state?.state === "done" ? (
                  state.snippets.length ? (
                    <ul className="space-y-0.5 pb-1 pl-6" aria-label={`Citations in ${fileBaseName(path)}`}>
                      {state.snippets.map((snippet) => (
                        <li key={snippet.start}>
                          <button type="button" className="libera-reference-snippet w-full rounded-md px-2 py-1 text-left text-[11px] leading-relaxed" title={`Go to line ${snippet.line}`} onClick={() => onOpenCitation?.(path, snippet)}>
                            <span className="text-muted-foreground">{snippet.before}</span>
                            <mark className="libera-links-match font-mono">{snippet.match}</mark>
                            <span className="text-muted-foreground">{snippet.after}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="py-1 pl-8 text-[11px] text-muted-foreground">No citation of it was found in this document.</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : <p className="px-0.5 text-[12px] text-muted-foreground">No document cites this reference yet.</p>}
    </Section>
  );
}

function NotesEditor({ entry, onSave }: { entry: ReferenceEntry; onSave: (notes: string) => Promise<boolean> }) {
  const stored = entry.notes ?? "";
  const [draft, setDraft] = useState(stored);
  const [state, setState] = useState<"idle" | "pending" | "saving" | "saved">("idle");
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<string | null>(null);
  const saveRef = useRef(onSave);
  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);

  // Follow notes changed elsewhere while nothing is waiting to be saved here.
  const [shownStored, setShownStored] = useState(stored);
  if (shownStored !== stored) {
    setShownStored(stored);
    if (state !== "pending" && state !== "saving") setDraft(stored);
  }

  async function flush() {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    const notes = pendingRef.current;
    pendingRef.current = null;
    if (notes === null) return;
    setState("saving");
    const saved = await saveRef.current(notes);
    setState(saved ? "saved" : "idle");
  }

  // Save what is pending when the card closes.
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    const notes = pendingRef.current;
    if (notes !== null) void saveRef.current(notes);
  }, []);

  return (
    <Section title="Notes">
      <textarea
        className="libera-panel-field min-h-24 w-full resize-y px-2.5 py-2 text-[12px] leading-relaxed"
        aria-label="Notes"
        placeholder="Your notes, in Markdown"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          pendingRef.current = event.target.value;
          setState("pending");
          if (timerRef.current !== null) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => void flush(), NOTES_SAVE_DELAY_MS);
        }}
        onBlur={() => { if (pendingRef.current !== null) void flush(); }}
      />
      <p className="h-3 text-right text-[10px] text-muted-foreground" aria-live="polite">
        {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state === "pending" ? "Editing…" : ""}
      </p>
    </Section>
  );
}
