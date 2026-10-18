"use client";

import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { cleanNameList, NameListEditor } from "@/components/libera/references/name-list-editor";
import { CSL_TYPE_LABELS, fieldLabel } from "@/components/libera/references/reference-display";
import { normalizeDoi, normalizeIsbn, normalizeIssn, normalizePmid } from "@/lib/references/identifiers";
import { identifiersFromCsl } from "@/lib/references/normalize";
import {
  CSL_ITEM_TYPES,
  type CslDate,
  type CslItem,
  type CslItemType,
  type CslName,
  type FieldProvenance,
  type ReferenceEntry,
  type ReferenceEntryInput,
  type ReferenceIdentifiers,
  type ReferenceLibraryOp,
} from "@/lib/references/types";

// "Edit all fields": every field of an entry in one form, the escape hatch
// next to the confirmation card. Saving sends one `update` op with the
// changed fields (user provenance) and the cleared ones removed. The same
// form adds an entry by hand (free text pasted into the Add box).

/** Fields with their own controls, in form order. Everything else is under "Other fields". */
export const MAIN_FIELDS = [
  "title", "author", "editor", "issued", "container-title", "volume", "issue", "page",
  "publisher", "publisher-place", "edition", "DOI", "URL", "ISBN", "ISSN", "PMID",
  "abstract", "language", "note",
] as const;
type MainField = typeof MAIN_FIELDS[number];

const ALWAYS: MainField[] = ["title", "author", "issued", "DOI", "URL", "abstract", "language", "note"];
const JOURNAL: MainField[] = ["container-title", "volume", "issue", "page", "ISSN", "PMID"];
const BOOK: MainField[] = ["editor", "publisher", "publisher-place", "edition", "volume", "ISBN"];
const IN_BOOK: MainField[] = ["editor", "container-title", "publisher", "publisher-place", "edition", "page", "ISBN"];

/** The main fields a type shows (fields with a value are always shown too). */
export function fieldsForType(type: CslItemType): Set<MainField> {
  const extra: MainField[] =
    type === "article-journal" || type === "article-magazine" || type === "article-newspaper" || type === "review" || type === "review-book" || type === "periodical" ? JOURNAL
      : type === "book" || type === "collection" || type === "classic" || type === "musical_score" ? BOOK
        : type === "chapter" || type === "entry-dictionary" || type === "entry-encyclopedia" || type === "entry" ? IN_BOOK
          : type === "paper-conference" ? ["editor", "container-title", "publisher", "publisher-place", "page", "ISBN"]
            : type === "article" ? ["container-title", "publisher"]
              : type === "report" || type === "thesis" || type === "manuscript" || type === "standard" || type === "pamphlet" ? ["publisher", "publisher-place"]
                : type === "webpage" || type === "post" || type === "post-weblog" ? ["container-title"]
                  : type === "dataset" || type === "software" ? ["publisher", "edition"]
                    : ["container-title", "publisher", "publisher-place", "volume", "issue", "page"];
  return new Set([...ALWAYS, ...extra]);
}

const NAME_FIELDS = new Set<string>(["author", "editor"]);

type DateDraft = { mode: "parts" | "literal"; year: string; month: string; day: string; literal: string };

function dateDraft(date: CslDate | undefined): DateDraft {
  const parts = date?.["date-parts"]?.[0];
  if (parts?.length) {
    return { mode: "parts", year: String(parts[0] ?? ""), month: parts[1] ? String(parts[1]) : "", day: parts[2] ? String(parts[2]) : "", literal: "" };
  }
  const literal = date?.literal ?? date?.raw ?? "";
  return { mode: literal ? "literal" : "parts", year: "", month: "", day: "", literal };
}

function dateFromDraft(draft: DateDraft): CslDate | undefined {
  if (draft.mode === "literal") return draft.literal.trim() ? { literal: draft.literal.trim() } : undefined;
  if (!draft.year.trim()) return undefined;
  const parts: [number, number?, number?] = [Number(draft.year)];
  if (draft.month.trim()) parts.push(Number(draft.month));
  if (draft.month.trim() && draft.day.trim()) parts.push(Number(draft.day));
  return { "date-parts": [parts] };
}

type OtherField = { name: string; value: string; json: boolean };

/** JSON with sorted keys, for change detection. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isEmpty(value: unknown) {
  return value === undefined || value === null || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && !value.length);
}

export function userProvenance(now = new Date().toISOString()): FieldProvenance {
  return { source: "user", confidence: 1, retrievedAt: now };
}

const IDENTIFIER_FIELDS: Record<string, keyof ReferenceIdentifiers> = { DOI: "doi", ISBN: "isbn", PMID: "pmid", PMCID: "pmcid" };

/**
 * The `update` op that turns `entry.csl` into `next`: changed fields with
 * user provenance, cleared fields removed, and identifiers kept in step with
 * the DOI, ISBN, PMID and PMCID fields. Null when nothing changed.
 */
export function buildEditOp(entry: ReferenceEntry, next: CslItem, now = new Date().toISOString()): Extract<ReferenceLibraryOp, { op: "update" }> | null {
  const csl: Partial<CslItem> = {};
  const removeFields: string[] = [];
  const provenance: Record<string, FieldProvenance> = {};
  const fields = new Set([...Object.keys(entry.csl), ...Object.keys(next)]);
  for (const field of fields) {
    const before = entry.csl[field];
    const after = next[field];
    if (isEmpty(after)) {
      if (!isEmpty(before) && field !== "type") removeFields.push(field);
      continue;
    }
    if (stableJson(before) === stableJson(after)) continue;
    csl[field] = after;
    if (field !== "type") provenance[field] = userProvenance(now);
  }
  if (!Object.keys(csl).length && !removeFields.length) return null;
  const op: Extract<ReferenceLibraryOp, { op: "update" }> = { op: "update", id: entry.id };
  if (Object.keys(csl).length) op.csl = csl;
  if (removeFields.length) op.removeFields = removeFields;
  if (Object.keys(provenance).length) op.provenance = provenance;
  const changedIdentifiers = [...Object.keys(csl), ...removeFields].filter((field) => IDENTIFIER_FIELDS[field]);
  if (changedIdentifiers.length) {
    const fromCsl = identifiersFromCsl(next);
    const identifiers: ReferenceIdentifiers = { ...entry.identifiers };
    for (const field of changedIdentifiers) {
      const name = IDENTIFIER_FIELDS[field];
      if (fromCsl[name] !== undefined) (identifiers as Record<string, unknown>)[name] = fromCsl[name];
      else delete identifiers[name];
    }
    if (fromCsl.arxiv && !identifiers.arxiv) identifiers.arxiv = fromCsl.arxiv;
    op.identifiers = identifiers;
  }
  return op;
}

/** Messages for invalid values, by field. */
export function validateReferenceFields(csl: CslItem, options: { requireTitle?: boolean; date?: DateDraft; otherFields?: OtherField[] } = {}) {
  const errors: Record<string, string> = {};
  if (options.requireTitle && isEmpty(csl.title)) errors.title = "A title is needed.";
  for (const field of ["author", "editor"] as const) {
    const names = csl[field];
    if (Array.isArray(names) && names.some((name) => !name.family && !name.literal)) {
      errors[field] = "Each name needs a family name, or switch it to an institution.";
    }
  }
  const date = options.date;
  if (date?.mode === "parts" && (date.year || date.month || date.day)) {
    const year = Number(date.year);
    const month = Number(date.month || "1");
    const day = Number(date.day || "1");
    if (!/^-?\d{1,4}$/.test(date.year.trim()) || year < -9999 || year > 9999) errors.issued = "The year must be a number, such as 2020.";
    else if (date.month && (!Number.isInteger(month) || month < 1 || month > 12)) errors.issued = "The month must be between 1 and 12.";
    else if (date.day && !date.month) errors.issued = "Add the month before the day.";
    else if (date.day && (!Number.isInteger(day) || day < 1 || day > 31)) errors.issued = "The day must be between 1 and 31.";
  }
  if (typeof csl.DOI === "string" && csl.DOI.trim() && !normalizeDoi(csl.DOI)) errors.DOI = "This is not a DOI. DOIs look like 10.1234/abcd.";
  if (typeof csl.URL === "string" && csl.URL.trim() && !/^https?:\/\/\S+$/i.test(csl.URL.trim())) errors.URL = "Web addresses start with http:// or https://.";
  if (typeof csl.ISBN === "string" && csl.ISBN.trim() && csl.ISBN.split(/[,;]\s*|\s+(?=97[89]|\d{9}[\dX])/i).some((value) => value.trim() && !normalizeIsbn(value))) {
    errors.ISBN = "The ISBN's check digit does not match.";
  }
  if (typeof csl.ISSN === "string" && csl.ISSN.trim() && csl.ISSN.split(/[,;\s]+/).some((value) => value && !normalizeIssn(value))) errors.ISSN = "ISSNs look like 1234-5679.";
  if (csl.PMID !== undefined && String(csl.PMID).trim() && !normalizePmid(String(csl.PMID))) errors.PMID = "A PubMed ID is a number.";
  const seen = new Set<string>();
  for (const other of options.otherFields ?? []) {
    const name = other.name.trim();
    if (!name && !other.value.trim()) continue;
    if (!name) errors[`other:${seen.size}`] = "Name the field.";
    else if ((MAIN_FIELDS as readonly string[]).includes(name) || name === "type") errors[`other:${name}`] = `“${name}” has its own field above.`;
    else if (seen.has(name)) errors[`other:${name}`] = `“${name}” is listed twice.`;
    else if (other.json && other.value.trim()) {
      try {
        JSON.parse(other.value);
      } catch {
        errors[`other:${name}`] = "This value must be valid JSON.";
      }
    }
    seen.add(name);
  }
  return errors;
}

function otherFieldsOf(csl: CslItem): OtherField[] {
  return Object.entries(csl)
    .filter(([name]) => name !== "type" && !(MAIN_FIELDS as readonly string[]).includes(name))
    .map(([name, value]) => typeof value === "string" || typeof value === "number"
      ? { name, value: String(value), json: false }
      : { name, value: JSON.stringify(value, null, 0), json: true });
}

type FormProps = {
  open: boolean;
  /** Edit this entry; without one the form adds a new entry. */
  entry?: ReferenceEntry | null;
  /** Starting values when adding. */
  initial?: ReferenceEntryInput;
  onClose: () => void;
  /** Commits the ops; a rejected promise shows its message in the form. */
  onSubmit: (ops: ReferenceLibraryOp[]) => Promise<unknown>;
};

export function ReferenceEditForm(props: FormProps) {
  if (!props.open) return null;
  // Remounted per entry so the drafts start from its current values.
  return <ReferenceEditFormDialog key={props.entry?.id ?? "new"} {...props} />;
}

function ReferenceEditFormDialog({ open, entry, initial, onClose, onSubmit }: FormProps) {
  const start = useMemo<CslItem>(() => structuredClone(entry?.csl ?? initial?.csl ?? { type: "article-journal" }), [entry, initial]);
  const [type, setType] = useState<CslItemType>(start.type);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(
    MAIN_FIELDS.filter((field) => !NAME_FIELDS.has(field) && field !== "issued")
      .map((field) => [field, start[field] === undefined ? "" : String(start[field])]),
  ));
  const [names, setNames] = useState<Record<"author" | "editor", CslName[]>>({
    author: structuredClone(start.author ?? []),
    editor: structuredClone(start.editor ?? []),
  });
  const initialDate = useMemo(() => dateDraft(start.issued), [start]);
  const [date, setDate] = useState<DateDraft>(initialDate);
  const [otherFields, setOtherFields] = useState<OtherField[]>(() => otherFieldsOf(start));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const visible = fieldsForType(type);
  const shown = (field: MainField) => visible.has(field) || !isEmpty(start[field]);

  function buildCsl(): CslItem {
    const csl: CslItem = { type };
    for (const field of MAIN_FIELDS) {
      if (field === "author" || field === "editor") {
        const list = cleanNameList(names[field]);
        if (list.length) csl[field] = list;
      } else if (field === "issued") {
        // An untouched date keeps its exact form (ranges, seasons, circa).
        const issued = stableJson(date) === stableJson(initialDate) ? start.issued : dateFromDraft(date);
        if (issued) csl.issued = issued;
      } else {
        const value = values[field]?.trim();
        // An untouched value keeps its stored form (a number, a DOI's case).
        if (value && start[field] !== undefined && String(start[field]).trim() === value) csl[field] = start[field];
        else if (value) csl[field] = field === "DOI" ? normalizeDoi(value) ?? value : value;
      }
    }
    for (const other of otherFields) {
      const name = other.name.trim();
      if (!name || !other.value.trim()) continue;
      csl[name] = other.json ? JSON.parse(other.value) as unknown : other.value.trim();
    }
    return csl;
  }

  async function submit() {
    const draftCsl: CslItem = { type, author: names.author, editor: names.editor };
    for (const field of MAIN_FIELDS) if (!NAME_FIELDS.has(field) && field !== "issued") (draftCsl as Record<string, unknown>)[field] = values[field];
    const nextErrors = validateReferenceFields(draftCsl, { requireTitle: !entry, date, otherFields });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    const csl = buildCsl();
    let ops: ReferenceLibraryOp[];
    if (entry) {
      const op = buildEditOp(entry, csl);
      if (!op) {
        onClose();
        return;
      }
      ops = [op];
    } else {
      const now = new Date().toISOString();
      const complete = !isEmpty(csl.title) && !isEmpty(csl.author ?? csl.editor) && !isEmpty(csl.issued);
      // A looked-up candidate keeps its sources for the fields left as they were; edited fields are the user's.
      const unchanged = (field: string) => initial !== undefined && stableJson(initial.csl[field]) === stableJson(csl[field]);
      const conflicts = Object.fromEntries(Object.entries(initial?.conflicts ?? {}).filter(([field, alternatives]) => alternatives?.length && unchanged(field)));
      ops = [{
        op: "add",
        entry: {
          ...initial,
          csl,
          identifiers: { ...initial?.identifiers, ...identifiersFromCsl(csl) },
          provenance: Object.fromEntries(Object.keys(csl).filter((field) => field !== "type").map((field) => [field, (unchanged(field) && initial?.provenance?.[field]) || userProvenance(now)])),
          ...(Object.keys(conflicts).length ? { conflicts } : { conflicts: undefined }),
          status: complete ? "confirmed" : "needs-review",
        },
      }];
    }
    setSubmitting(true);
    setSubmitError("");
    try {
      await onSubmit(ops);
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "The reference could not be saved.");
    } finally {
      setSubmitting(false);
    }
  }

  function textField(field: MainField, options: { multiline?: boolean; mono?: boolean; className?: string } = {}) {
    if (!shown(field)) return null;
    const id = `reference-field-${field}`;
    const error = errors[field];
    return (
      <label key={field} className={`block space-y-1 ${options.className ?? ""}`} htmlFor={id}>
        <span className="block text-xs font-medium text-muted-foreground">{fieldLabel(field)}</span>
        {options.multiline ? (
          <textarea id={id} className="min-h-20 w-full px-2.5 py-1.5 text-sm" value={values[field] ?? ""} aria-invalid={Boolean(error)} onChange={(event) => setValues((current) => ({ ...current, [field]: event.target.value }))} />
        ) : (
          <input id={id} className={`h-8 w-full px-2.5 text-sm ${options.mono ? "font-mono" : ""}`} value={values[field] ?? ""} aria-invalid={Boolean(error)} onChange={(event) => setValues((current) => ({ ...current, [field]: event.target.value }))} />
        )}
        {error ? <span role="alert" className="block text-xs text-destructive">{error}</span> : null}
      </label>
    );
  }

  return (
    <ModalDialog
      open={open}
      title={entry ? `Edit ${entry.key}` : "New reference"}
      description={entry ? "Changed fields are marked as yours. Clear a field to remove it." : "Fill in what you know. The pasted text is kept in the note."}
      panelClassName="max-w-2xl"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted" onClick={onClose}>Cancel</button>
          <button type="button" className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90" disabled={submitting} onClick={() => void submit()}>
            {entry ? "Save" : "Add reference"}
          </button>
        </>
      }
    >
      <form className="space-y-4" aria-label={entry ? "Edit reference" : "New reference"} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {submitError ? <div role="alert" className="rounded-lg bg-destructive-muted p-3 text-xs text-destructive">{submitError}</div> : null}
        <label className="block space-y-1" htmlFor="reference-field-type">
          <span className="block text-xs font-medium text-muted-foreground">Type</span>
          <select id="reference-field-type" className="h-8 w-full px-2 text-sm" value={type} onChange={(event) => setType(event.target.value as CslItemType)}>
            {[...CSL_ITEM_TYPES].sort((a, b) => CSL_TYPE_LABELS[a].localeCompare(CSL_TYPE_LABELS[b])).map((item) => (
              <option key={item} value={item}>{CSL_TYPE_LABELS[item]}</option>
            ))}
          </select>
        </label>
        {textField("title", { multiline: false })}
        <NameListEditor label="Authors" names={names.author} onChange={(author) => setNames((current) => ({ ...current, author }))} />
        {errors.author ? <p role="alert" className="text-xs text-destructive">{errors.author}</p> : null}
        {shown("editor") ? (
          <>
            <NameListEditor label="Editors" names={names.editor} onChange={(editor) => setNames((current) => ({ ...current, editor }))} />
            {errors.editor ? <p role="alert" className="text-xs text-destructive">{errors.editor}</p> : null}
          </>
        ) : null}
        <fieldset className="space-y-1">
          <legend className="mb-1 flex w-full items-center justify-between text-xs font-medium text-muted-foreground">
            <span>Date</span>
            <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={() => setDate((current) => ({ ...current, mode: current.mode === "parts" ? "literal" : "parts" }))}>
              {date.mode === "parts" ? "Enter as text" : "Enter year, month, day"}
            </button>
          </legend>
          {date.mode === "parts" ? (
            <div className="flex gap-2">
              <input className="h-8 w-24 px-2.5 text-sm" aria-label="Year" placeholder="Year" inputMode="numeric" value={date.year} onChange={(event) => setDate((current) => ({ ...current, year: event.target.value }))} />
              <input className="h-8 w-20 px-2.5 text-sm" aria-label="Month" placeholder="Month" inputMode="numeric" value={date.month} onChange={(event) => setDate((current) => ({ ...current, month: event.target.value }))} />
              <input className="h-8 w-20 px-2.5 text-sm" aria-label="Day" placeholder="Day" inputMode="numeric" value={date.day} onChange={(event) => setDate((current) => ({ ...current, day: event.target.value }))} />
            </div>
          ) : (
            <input className="h-8 w-full px-2.5 text-sm" aria-label="Date as text" placeholder="Spring 2020, forthcoming…" value={date.literal} onChange={(event) => setDate((current) => ({ ...current, literal: event.target.value }))} />
          )}
          {errors.issued ? <p role="alert" className="text-xs text-destructive">{errors.issued}</p> : null}
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          {textField("container-title", { className: "col-span-2" })}
          {textField("volume")}
          {textField("issue")}
          {textField("page")}
          {textField("edition")}
          {textField("publisher")}
          {textField("publisher-place")}
          {textField("DOI", { mono: true })}
          {textField("URL", { mono: true })}
          {textField("ISBN", { mono: true })}
          {textField("ISSN", { mono: true })}
          {textField("PMID", { mono: true })}
          {textField("language")}
        </div>
        {textField("abstract", { multiline: true })}
        {textField("note", { multiline: true })}
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-xs font-medium text-muted-foreground">Other fields</legend>
          {otherFields.map((other, index) => {
            const error = errors[`other:${other.name.trim()}`] ?? (!other.name.trim() ? errors[`other:${index}`] : undefined);
            return (
              <div key={index} className="space-y-1">
                <div className="flex items-center gap-2">
                  <input className="h-8 w-40 px-2.5 font-mono text-xs" aria-label={`Other field ${index + 1} name`} placeholder="CSL variable" value={other.name} onChange={(event) => setOtherFields((current) => current.map((item, position) => position === index ? { ...item, name: event.target.value } : item))} />
                  <input className={`h-8 min-w-0 flex-1 px-2.5 text-sm ${other.json ? "font-mono text-xs" : ""}`} aria-label={`Other field ${index + 1} value`} placeholder="Value" value={other.value} onChange={(event) => setOtherFields((current) => current.map((item, position) => position === index ? { ...item, value: event.target.value } : item))} />
                  <button type="button" className="libera-sidebar-icon-button inline-flex h-7 w-7 items-center justify-center rounded-lg" aria-label={`Remove other field ${index + 1}`} onClick={() => setOtherFields((current) => current.filter((_, position) => position !== index))}>
                    <X aria-hidden className="h-3.5 w-3.5" />
                  </button>
                </div>
                {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
              </div>
            );
          })}
          <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline" onClick={() => setOtherFields((current) => [...current, { name: "", value: "", json: false }])}>
            <Plus aria-hidden className="h-3.5 w-3.5" /> Add field
          </button>
        </fieldset>
      </form>
    </ModalDialog>
  );
}
