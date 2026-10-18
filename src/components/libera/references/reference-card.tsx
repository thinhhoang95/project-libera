"use client";

import { ArrowLeft, Check, Copy, ExternalLink, FileText, FileType2, Globe, Pencil, Quote, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  authorYearLabel,
  entryTitle,
  fieldLabel,
  fileBaseName,
  formatFieldValue,
  formatPlainReference,
  PROVENANCE_LABELS,
  STATUS_LABELS,
  typeLabel,
} from "@/components/libera/references/reference-display";
import { userProvenance } from "@/components/libera/references/reference-edit-form";
import { CITE_UNAVAILABLE, StatusBadge } from "@/components/libera/references/reference-row";
import { isValidCitationKey } from "@/lib/references/keys";
import { formatNameForDisplay, parsePersonList } from "@/lib/references/names";
import { parseDateText } from "@/lib/references/normalize";
import type {
  CslName,
  FieldAlternative,
  FieldProvenance,
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
  entry: ReferenceEntry;
  library: ReferenceLibrary;
  citing: string[];
  canCite: boolean;
  apply: (ops: ReferenceLibraryOp[], label: string) => Promise<unknown>;
  onBack: () => void;
  onCite: () => void;
  onCopy: (text: string, what: string) => void;
  onOpenPath: (path: string) => void;
  onEditAll: () => void;
  onDelete: () => void;
};

export function ReferenceCard({ entry, library, citing, canCite, apply, onBack, onCite, onCopy, onOpenPath, onEditAll, onDelete }: CardProps) {
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
    <div className="libera-reference-card flex min-h-0 flex-1 flex-col overflow-hidden" aria-label={`Reference ${entry.key}`} role="region">
      <div className="flex items-center gap-1 px-2 pb-1 pt-1">
        <button type="button" className="libera-sidebar-icon-button inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs" aria-label="Back to references" onClick={onBack}>
          <ArrowLeft aria-hidden className="h-3.5 w-3.5" /> References
        </button>
        <div className="flex-1" />
        <button type="button" className="libera-sidebar-icon-button inline-flex h-8 w-8 items-center justify-center rounded-lg disabled:opacity-40" aria-label="Cite at cursor" title={canCite ? "Cite at cursor" : CITE_UNAVAILABLE} disabled={!canCite} onClick={onCite}>
          <Quote aria-hidden className="h-4 w-4" />
        </button>
        <button type="button" className="libera-sidebar-icon-button inline-flex h-8 w-8 items-center justify-center rounded-lg" aria-label="Edit all fields" title="Edit all fields" onClick={onEditAll}>
          <Pencil aria-hidden className="h-4 w-4" />
        </button>
        <button type="button" className="libera-sidebar-icon-button inline-flex h-8 w-8 items-center justify-center rounded-lg" data-tone="destructive" aria-label="Delete reference" title="Delete reference" onClick={onDelete}>
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
          <p className="text-[12px] leading-relaxed text-muted-foreground" aria-label="Formatted reference">{formatPlainReference(entry.csl)}</p>
          <p className="text-[11px] text-muted-foreground">{typeLabel(entry.csl.type)}</p>
          {reviewing ? (
            <div className="flex items-center gap-2 pt-1">
              <button type="button" className="libera-panel-primary h-8 flex-1 px-3" onClick={() => void run([{ op: "update", id: entry.id, status: "confirmed" }], `Confirm ${entry.key}`)}>
                <Check aria-hidden className="h-4 w-4" /> Confirm
              </button>
              <button type="button" className="libera-panel-button h-8 px-3" onClick={onEditAll}>Edit all fields</button>
            </div>
          ) : null}
          {reviewing ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {STATUS_LABELS[entry.status]}: check the fields below, correct any that are wrong, then confirm.
            </p>
          ) : null}
        </div>

        {error ? <div role="alert" className="rounded-lg bg-destructive-muted p-2.5 text-xs text-destructive">{error}</div> : null}

        <KeyEditor entry={entry} library={library} onRename={(key) => run([{ op: "rename-key", id: entry.id, key }], `Rename ${entry.key}`)} onCopy={() => onCopy(entry.key, "Key")} />

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

        <Section title="Attachments">
          {entry.attachments.length ? (
            <ul className="space-y-0.5">
              {entry.attachments.map((attachment) => attachment.kind === "url" ? (
                <li key={`url:${attachment.url}`}>
                  <a className="libera-notebook-row flex items-center gap-2 px-2 py-1 text-[12px]" href={attachment.url} target="_blank" rel="noreferrer">
                    <Globe aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{attachment.url}</span>
                  </a>
                </li>
              ) : (
                <li key={`${attachment.kind}:${attachment.path}`}>
                  <button type="button" className="libera-notebook-row flex w-full items-center gap-2 px-2 py-1 text-left text-[12px]" title={attachment.path} onClick={() => onOpenPath(attachment.path)}>
                    {attachment.kind === "pdf" ? <FileType2 aria-hidden className="h-3.5 w-3.5 shrink-0 text-[#d08178]" /> : <FileText aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 truncate">{fileBaseName(attachment.path)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="px-0.5 text-[12px] text-muted-foreground">Drop a PDF from the notebook on the panel to attach it.</p>}
        </Section>

        <Section title={`Cited in ${citing.length} document${citing.length === 1 ? "" : "s"}`}>
          {citing.length ? (
            <ul className="space-y-0.5" aria-label="Citing documents">
              {citing.map((path) => (
                <li key={path}>
                  <button type="button" className="libera-notebook-row flex w-full items-center gap-2 px-2 py-1 text-left text-[12px]" title={path} onClick={() => onOpenPath(path)}>
                    <FileText aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{fileBaseName(path)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="px-0.5 text-[12px] text-muted-foreground">No document cites this reference yet.</p>}
        </Section>

        <TagEditor tags={entry.tags ?? []} onChange={(tags) => run([{ op: "update", id: entry.id, tags }], `Edit tags of ${entry.key}`)} />
        <NotesEditor entry={entry} onSave={(notes) => run([{ op: "update", id: entry.id, notes }], `Edit notes of ${entry.key}`)} />

        <div className="flex justify-end">
          <button type="button" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => onCopy(formatPlainReference(entry.csl), "Reference")}>
            <Copy aria-hidden className="h-3 w-3" /> Copy formatted reference
          </button>
        </div>
      </div>
    </div>
  );
}

function KeyEditor({ entry, library, onRename, onCopy }: { entry: ReferenceEntry; library: ReferenceLibrary; onRename: (key: string) => Promise<boolean>; onCopy: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.key);
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
    if (await onRename(trimmed)) setEditing(false);
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
        <div className="flex items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{entry.key}</code>
          <button type="button" className="libera-sidebar-icon-button inline-flex h-7 w-7 items-center justify-center rounded-lg" aria-label="Copy key" title="Copy key" onClick={onCopy}><Copy aria-hidden className="h-3.5 w-3.5" /></button>
          <button type="button" className="libera-panel-button h-7 px-2.5" onClick={() => { setDraft(entry.key); setEditing(true); }}>Rename key</button>
        </div>
      )}
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

function TagEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState("");
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
            {tag}
            <button type="button" aria-label={`Remove tag ${tag}`} onClick={() => onChange(tags.filter((current) => current !== tag))}><X aria-hidden className="h-3 w-3" /></button>
          </span>
        ))}
        <input
          className="libera-panel-field h-7 min-w-24 flex-1 px-2 text-[12px]"
          aria-label="Add tag"
          placeholder="Add tag"
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
      </div>
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
