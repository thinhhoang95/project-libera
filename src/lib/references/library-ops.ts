import { generateCitationKey, isValidCitationKey, takenCitationKeys } from "./keys";
import {
  BUNDLED_CSL_STYLES,
  CSL_ITEM_TYPES,
  DEFAULT_CSL_STYLE,
  PROVENANCE_SOURCES,
  REFERENCE_LIBRARY_VERSION,
  type CslItem,
  type FieldProvenance,
  type ReferenceAttachment,
  type ReferenceEntry,
  type ReferenceEntryInput,
  type ReferenceIdentifiers,
  type ReferenceLibrary,
  type ReferenceLibraryOp,
  type ReferenceLibrarySettings,
  type ReferenceStatus,
  type ReferenceVersionLink,
  type RetractionStatus,
} from "./types";

// Library transactions as a pure function: the server applies them under its
// lock and the client re-applies them after a revision conflict. Every op is
// validated; one invalid op rejects the whole batch. See plan.md §2 and the
// "Library API" contract in docs/references/lanes.md.

/** An op the library cannot apply. The message is shown to the user. */
export class LibraryOpError extends Error {
  status = 400;

  constructor(message: string) {
    super(message);
    this.name = "LibraryOpError";
  }
}

export function emptyReferenceLibrary(): ReferenceLibrary {
  return { version: REFERENCE_LIBRARY_VERSION, revision: 0, style: DEFAULT_CSL_STYLE, entries: {} };
}

const STATUSES: readonly ReferenceStatus[] = ["confirmed", "needs-review", "unresolved"];
const VERSION_RELATIONS: readonly ReferenceVersionLink["relation"][] = ["preprint-of", "published-as", "erratum", "retraction", "correction"];
const RETRACTION_STATES: readonly RetractionStatus["state"][] = ["none", "retracted", "corrected", "expression-of-concern", "withdrawn"];
const IDENTIFIER_FIELDS = ["doi", "arxiv", "pmid", "pmcid", "openalex"] as const;
const CSL_NAME_FIELDS = new Set([
  "author", "editor", "translator", "container-author", "collection-editor", "chair", "compiler", "composer",
  "contributor", "curator", "director", "editorial-director", "executive-producer", "guest", "host",
  "illustrator", "interviewer", "narrator", "organizer", "original-author", "performer", "producer",
  "recipient", "reviewed-author", "script-writer", "series-creator",
]);
const CSL_DATE_FIELDS = new Set(["issued", "accessed", "original-date", "event-date", "submitted", "available-date"]);
const CSL_STRING_FIELDS = new Set([
  "title", "title-short", "container-title", "container-title-short", "collection-title", "event-title",
  "event-place", "publisher", "publisher-place", "volume", "issue", "page", "number-of-pages", "edition",
  "number", "genre", "medium", "status", "language", "abstract", "note", "DOI", "URL", "ISBN", "ISSN", "PMID", "PMCID",
]);
const NAME_PARTS = ["family", "given", "dropping-particle", "non-dropping-particle", "suffix", "literal"];
const MAX_TEXT = 1_000_000;

type Library = ReferenceLibrary;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
  throw new LibraryOpError(message);
}

function assertString(value: unknown, label: string, { allowEmpty = true, max = MAX_TEXT } = {}): string {
  if (typeof value !== "string") fail(`${label} must be text.`);
  if (!allowEmpty && !value.trim()) fail(`${label} is required.`);
  if (value.length > max) fail(`${label} is too long.`);
  return value;
}

function assertStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) fail(`${label} must be a list.`);
  return value.map((item, index) => assertString(item, `${label} ${index + 1}`));
}

function assertTimestamp(value: unknown, label: string) {
  const text = assertString(value, label, { allowEmpty: false, max: 100 });
  if (!Number.isFinite(Date.parse(text))) fail(`${label} is not a valid date.`);
  return text;
}

function validateName(value: unknown, label: string) {
  if (!isRecord(value)) fail(`${label} must be a name.`);
  for (const part of NAME_PARTS) if (value[part] !== undefined) assertString(value[part], `${label} ${part}`);
}

function validateDate(value: unknown, label: string) {
  if (!isRecord(value)) fail(`${label} must be a date.`);
  const parts = value["date-parts"];
  if (parts !== undefined) {
    if (!Array.isArray(parts) || parts.length > 2) fail(`${label} has invalid date parts.`);
    for (const tuple of parts) {
      if (!Array.isArray(tuple) || tuple.length < 1 || tuple.length > 3 ||
        tuple.some((part) => typeof part !== "number" || !Number.isFinite(part))) fail(`${label} has invalid date parts.`);
    }
  }
  for (const field of ["literal", "raw"]) if (value[field] !== undefined) assertString(value[field], `${label} ${field}`);
  if (value.season !== undefined && typeof value.season !== "number" && typeof value.season !== "string") fail(`${label} season is invalid.`);
  if (value.circa !== undefined && typeof value.circa !== "boolean") fail(`${label} circa is invalid.`);
}

function validateCslValue(field: string, value: unknown) {
  const label = `Field “${field}”`;
  if (field === "type") {
    if (!(CSL_ITEM_TYPES as readonly unknown[]).includes(value)) fail(`Unknown reference type “${String(value)}”.`);
  } else if (CSL_STRING_FIELDS.has(field)) {
    assertString(value, label);
  } else if (CSL_NAME_FIELDS.has(field)) {
    if (!Array.isArray(value)) fail(`${label} must be a list of names.`);
    value.forEach((name, index) => validateName(name, `${label} name ${index + 1}`));
  } else if (CSL_DATE_FIELDS.has(field)) {
    validateDate(value, label);
  } else if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    fail(`${label} is invalid.`);
  }
}

function validateCsl(value: unknown): CslItem {
  if (!isRecord(value)) fail("Reference metadata is missing.");
  for (const [field, fieldValue] of Object.entries(value)) {
    if (fieldValue === undefined) fail(`Field “${field}” has no value.`);
    validateCslValue(field, fieldValue);
  }
  if (value.type === undefined) fail("Reference type is required.");
  return value as CslItem;
}

function validateIdentifiers(value: unknown): ReferenceIdentifiers {
  if (!isRecord(value)) fail("Identifiers must be an object.");
  for (const field of IDENTIFIER_FIELDS) if (value[field] !== undefined) assertString(value[field], `Identifier “${field}”`, { max: 1000 });
  if (value.isbn !== undefined) assertStringArray(value.isbn, "ISBN");
  return value as ReferenceIdentifiers;
}

function validateFieldProvenance(value: unknown, field: string): FieldProvenance {
  const label = `Provenance for “${field}”`;
  if (!isRecord(value)) fail(`${label} is invalid.`);
  if (!(PROVENANCE_SOURCES as readonly unknown[]).includes(value.source)) fail(`${label} has an unknown source.`);
  if (typeof value.confidence !== "number" || !(value.confidence >= 0 && value.confidence <= 1)) fail(`${label} needs a confidence between 0 and 1.`);
  if (value.url !== undefined) assertString(value.url, `${label} URL`, { max: 10_000 });
  if (value.source === "llm-web" && !value.url) fail(`${label} must name the web page it came from.`);
  assertTimestamp(value.retrievedAt, `${label} retrieval time`);
  return value as FieldProvenance;
}

function validateProvenance(value: unknown, { allowNull = false } = {}) {
  if (!isRecord(value)) fail("Provenance must be an object.");
  for (const [field, provenance] of Object.entries(value)) {
    if (allowNull && (provenance === null || provenance === undefined)) continue;
    validateFieldProvenance(provenance, field);
  }
  return value as Record<string, FieldProvenance | null | undefined>;
}

function validateStatus(value: unknown): ReferenceStatus {
  if (!STATUSES.includes(value as ReferenceStatus)) fail(`Unknown reference status “${String(value)}”.`);
  return value as ReferenceStatus;
}

/** A library-relative path such as "Notebook/papers/smith.pdf": no "..", not absolute. */
export function isSafeLibraryPath(value: string) {
  if (!value || value.length > 4000 || value.includes("\\") || value.includes("\0")) return false;
  if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return false;
  return value.split("/").every((part) => part && part !== "." && part !== "..");
}

function validateAttachment(value: unknown): ReferenceAttachment {
  if (!isRecord(value)) fail("Attachment is invalid.");
  if (value.kind === "url") {
    const url = assertString(value.url, "Attachment URL", { allowEmpty: false, max: 10_000 });
    let parsed: URL;
    try { parsed = new URL(url); } catch { fail(`Attachment URL “${url}” is not a valid address.`); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") fail("Attachment URLs must start with http:// or https://.");
    return { kind: "url", url };
  }
  if (value.kind !== "pdf" && value.kind !== "markdown") fail(`Unknown attachment kind “${String(value.kind)}”.`);
  const attachmentPath = assertString(value.path, "Attachment path", { allowEmpty: false, max: 4000 });
  if (!isSafeLibraryPath(attachmentPath)) fail(`Attachment path “${attachmentPath}” must be a path inside the library.`);
  if (value.sha256 !== undefined && (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256))) fail("Attachment hash is invalid.");
  if (value.size !== undefined && (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0)) fail("Attachment size is invalid.");
  return {
    kind: value.kind,
    path: attachmentPath,
    ...(value.sha256 !== undefined ? { sha256: value.sha256 as string } : {}),
    ...(value.size !== undefined ? { size: value.size as number } : {}),
  };
}

function validateVersions(value: unknown): ReferenceVersionLink[] {
  if (!Array.isArray(value)) fail("Versions must be a list.");
  return value.map((link) => {
    if (!isRecord(link) || !VERSION_RELATIONS.includes(link.relation as ReferenceVersionLink["relation"])) fail("Version link is invalid.");
    assertString(link.identifier, "Version identifier", { allowEmpty: false, max: 10_000 });
    return link as ReferenceVersionLink;
  });
}

function validateRetraction(value: unknown): RetractionStatus {
  if (!isRecord(value) || !RETRACTION_STATES.includes(value.state as RetractionStatus["state"])) fail("Retraction status is invalid.");
  assertTimestamp(value.checkedAt, "Retraction check time");
  if (value.notice !== undefined) {
    if (!isRecord(value.notice)) fail("Retraction notice is invalid.");
    for (const field of ["doi", "url", "date", "label"]) if (value.notice[field] !== undefined) assertString(value.notice[field], `Retraction notice ${field}`);
  }
  return value as RetractionStatus;
}

function validateStyle(value: unknown) {
  const style = assertString(value, "Citation style", { allowEmpty: false, max: 4000 });
  if (BUNDLED_CSL_STYLES.some((bundled) => bundled.id === style)) return style;
  if (/\.csl$/i.test(style) && isSafeLibraryPath(style)) return style;
  fail(`Citation style “${style}” is neither a bundled style nor a .csl file in the library.`);
}

function validateSettings(value: unknown): ReferenceLibrarySettings {
  if (!isRecord(value)) fail("Library settings are invalid.");
  for (const [field, setting] of Object.entries(value)) {
    if (field !== "autoCreateForPdfs") fail(`Unknown library setting “${field}”.`);
    if (setting !== undefined && typeof setting !== "boolean") fail("“autoCreateForPdfs” must be true or false.");
  }
  return value as ReferenceLibrarySettings;
}

/** Same attachment: same file for pdf/markdown, same address for URLs. */
export function attachmentIdentity(attachment: ReferenceAttachment) {
  return attachment.kind === "url" ? `url:${attachment.url}` : `file:${attachment.path}`;
}

function uniqueAttachments(attachments: ReferenceAttachment[]) {
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    const identity = attachmentIdentity(attachment);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function uniqueVersions(versions: ReferenceVersionLink[]) {
  const seen = new Set<string>();
  return versions.filter((link) => {
    const identity = `${link.relation}\0${link.identifier}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/** Deterministic JSON (sorted object keys), so key order never counts as a change. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function same(left: unknown, right: unknown) {
  return stableJson(left) === stableJson(right);
}

function entryById(library: Library, id: unknown): ReferenceEntry {
  if (typeof id !== "string" || !id) fail("Reference id is required.");
  const entry = Object.hasOwn(library.entries, id) ? library.entries[id] : undefined;
  if (!entry) fail("That reference is no longer in the library.");
  return entry;
}

/** Lowercased keys and aliases of every entry except `exceptId`. */
function takenKeys(library: Library, exceptId?: string) {
  return new Set(takenCitationKeys(Object.values(library.entries).filter((entry) => entry.id !== exceptId))
    .map((key) => key.toLowerCase()));
}

function assertKey(key: unknown, label = "Citation key"): string {
  if (typeof key !== "string" || !isValidCitationKey(key)) {
    fail(`${label} “${String(key)}” is not valid. Keys start with a letter, digit or underscore and contain no spaces.`);
  }
  return key;
}

function newEntryId() {
  return `ref_${globalThis.crypto.randomUUID()}`;
}

function addEntry(library: Library, input: ReferenceEntryInput, now: string) {
  if (!isRecord(input)) fail("Reference to add is missing.");
  const csl = structuredClone(validateCsl(input.csl));
  const taken = takenKeys(library);
  const key = typeof input.key === "string" && isValidCitationKey(input.key) && !taken.has(input.key.toLowerCase())
    ? input.key
    : generateCitationKey(csl, taken);
  const id = newEntryId();
  const entry: ReferenceEntry = {
    id,
    key,
    aliases: [],
    csl,
    identifiers: input.identifiers === undefined ? {} : structuredClone(validateIdentifiers(input.identifiers)),
    provenance: input.provenance === undefined ? {} : structuredClone(validateProvenance(input.provenance)) as ReferenceEntry["provenance"],
    status: input.status === undefined ? "needs-review" : validateStatus(input.status),
    attachments: input.attachments === undefined ? [] : uniqueAttachments(assertList(input.attachments, "Attachments").map(validateAttachment)),
    ...(input.versions !== undefined ? { versions: uniqueVersions(structuredClone(validateVersions(input.versions))) } : {}),
    ...(input.notes !== undefined ? { notes: assertString(input.notes, "Notes") } : {}),
    ...(input.tags !== undefined ? { tags: uniqueStrings(assertStringArray(input.tags, "Tags")) } : {}),
    createdAt: now,
    updatedAt: now,
    fieldUpdatedAt: Object.fromEntries(Object.keys(csl).map((field) => [field, now])),
  };
  library.entries[id] = entry;
}

function assertList(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be a list.`);
  return value;
}

function removeField(entry: ReferenceEntry, field: string, now: string) {
  if (field === "type") fail("The reference type cannot be removed.");
  if (!Object.hasOwn(entry.csl, field)) return;
  delete entry.csl[field];
  delete entry.provenance[field];
  entry.fieldUpdatedAt[field] = now;
}

function updateEntry(library: Library, op: Extract<ReferenceLibraryOp, { op: "update" }>, now: string) {
  const current = entryById(library, op.id);
  const entry = structuredClone(current);

  if (op.csl !== undefined) {
    if (!isRecord(op.csl)) fail("Reference metadata changes are invalid.");
    for (const [field, value] of Object.entries(op.csl)) {
      if (value === undefined || value === null) { removeField(entry, field, now); continue; }
      validateCslValue(field, value);
      if (Object.hasOwn(entry.csl, field) && same(entry.csl[field], value)) continue;
      entry.csl[field] = structuredClone(value);
      entry.fieldUpdatedAt[field] = now;
    }
  }
  if (op.removeFields !== undefined) for (const field of assertStringArray(op.removeFields, "Fields to remove")) removeField(entry, field, now);
  if (op.provenance !== undefined) {
    for (const [field, provenance] of Object.entries(validateProvenance(op.provenance, { allowNull: true }))) {
      if (provenance === null || provenance === undefined) delete entry.provenance[field];
      else if (Object.hasOwn(entry.csl, field)) entry.provenance[field] = structuredClone(provenance);
      // Provenance for a field the entry does not have would describe nothing.
    }
  }
  if (op.identifiers !== undefined) entry.identifiers = structuredClone(validateIdentifiers(op.identifiers));
  if (op.status !== undefined) entry.status = validateStatus(op.status);
  if (op.notes !== undefined) entry.notes = assertString(op.notes, "Notes");
  if (op.tags !== undefined) entry.tags = uniqueStrings(assertStringArray(op.tags, "Tags"));
  if (op.versions !== undefined) entry.versions = uniqueVersions(structuredClone(validateVersions(op.versions)));
  if (op.retraction !== undefined) entry.retraction = structuredClone(validateRetraction(op.retraction));

  if (!same(entry, current)) {
    entry.updatedAt = now;
    library.entries[entry.id] = entry;
  }
}

function renameKey(library: Library, id: string, nextKey: unknown, now: string) {
  const entry = entryById(library, id);
  const key = assertKey(nextKey);
  if (key === entry.key) return;
  if (takenKeys(library, entry.id).has(key.toLowerCase())) fail(`The key “${key}” is already used by another reference.`);
  const lower = key.toLowerCase();
  const aliases = entry.aliases.filter((alias) => alias.toLowerCase() !== lower);
  // A change of case only is a correction, not a retired key.
  if (entry.key.toLowerCase() !== lower) aliases.push(entry.key);
  library.entries[entry.id] = { ...entry, key, aliases, updatedAt: now };
}

function mergeEntries(library: Library, keepId: string, mergeIds: unknown, now: string) {
  const keep = structuredClone(entryById(library, keepId));
  const ids = assertList(mergeIds, "References to merge");
  if (!ids.length) fail("Choose at least one reference to merge.");
  if (new Set(ids).size !== ids.length) fail("A reference is listed twice in the merge.");
  if (ids.includes(keepId)) fail("A reference cannot be merged into itself.");
  const merged = ids.map((id) => entryById(library, id));

  const aliasSet = new Set([keep.key.toLowerCase(), ...keep.aliases.map((alias) => alias.toLowerCase())]);
  for (const entry of merged) {
    for (const alias of [entry.key, ...entry.aliases]) {
      if (aliasSet.has(alias.toLowerCase())) continue;
      aliasSet.add(alias.toLowerCase());
      keep.aliases.push(alias);
    }
    for (const [field, value] of Object.entries(entry.csl)) {
      if (Object.hasOwn(keep.csl, field)) continue;
      keep.csl[field] = structuredClone(value);
      if (entry.provenance[field]) keep.provenance[field] = structuredClone(entry.provenance[field]);
      keep.fieldUpdatedAt[field] = entry.fieldUpdatedAt[field] ?? now;
    }
    for (const field of IDENTIFIER_FIELDS) {
      if (keep.identifiers[field] === undefined && entry.identifiers[field] !== undefined) keep.identifiers[field] = entry.identifiers[field];
    }
    if (!keep.identifiers.isbn?.length && entry.identifiers.isbn?.length) keep.identifiers.isbn = [...entry.identifiers.isbn];
    keep.attachments = uniqueAttachments([...keep.attachments, ...structuredClone(entry.attachments)]);
    if (entry.tags?.length) keep.tags = uniqueStrings([...keep.tags ?? [], ...entry.tags]);
    if (entry.versions?.length) keep.versions = uniqueVersions([...keep.versions ?? [], ...structuredClone(entry.versions)]);
    if (!keep.retraction && entry.retraction) keep.retraction = structuredClone(entry.retraction);
  }
  const notes = [keep, ...merged].map((entry) => entry.notes?.trim()).filter(Boolean);
  if (notes.length) keep.notes = notes.join("\n\n");
  keep.status = [keep, ...merged].some((entry) => entry.status === "confirmed") ? "confirmed" : "needs-review";
  keep.updatedAt = now;
  for (const entry of merged) delete library.entries[entry.id];
  library.entries[keep.id] = keep;
}

function attach(library: Library, id: string, input: unknown, now: string) {
  const entry = entryById(library, id);
  const attachment = validateAttachment(input);
  const identity = attachmentIdentity(attachment);
  const index = entry.attachments.findIndex((existing) => attachmentIdentity(existing) === identity);
  if (index >= 0 && same(entry.attachments[index], attachment)) return;
  const attachments = [...entry.attachments];
  if (index >= 0) attachments[index] = attachment;
  else attachments.push(attachment);
  library.entries[entry.id] = { ...entry, attachments, updatedAt: now };
}

function detach(library: Library, id: string, input: unknown, now: string) {
  const entry = entryById(library, id);
  const identity = attachmentIdentity(validateAttachment(input));
  const attachments = entry.attachments.filter((existing) => attachmentIdentity(existing) !== identity);
  if (attachments.length === entry.attachments.length) return;
  library.entries[entry.id] = { ...entry, attachments, updatedAt: now };
}

function validateEntry(value: unknown): ReferenceEntry {
  if (!isRecord(value)) fail("Reference is invalid.");
  const id = assertString(value.id, "Reference id", { allowEmpty: false, max: 200 });
  const key = assertKey(value.key);
  const aliases = assertList(value.aliases, "Aliases").map((alias) => assertKey(alias, "Alias"));
  const lower = [key, ...aliases].map((item) => item.toLowerCase());
  if (new Set(lower).size !== lower.length) fail(`Reference “${key}” lists the same key twice.`);
  validateCsl(value.csl);
  validateIdentifiers(value.identifiers);
  validateProvenance(value.provenance);
  validateStatus(value.status);
  const attachments = assertList(value.attachments, "Attachments").map(validateAttachment);
  if (uniqueAttachments(attachments).length !== attachments.length) fail(`Reference “${key}” lists an attachment twice.`);
  if (value.versions !== undefined) validateVersions(value.versions);
  if (value.retraction !== undefined) validateRetraction(value.retraction);
  if (value.notes !== undefined) assertString(value.notes, "Notes");
  if (value.tags !== undefined) assertStringArray(value.tags, "Tags");
  assertTimestamp(value.createdAt, "Creation time");
  assertTimestamp(value.updatedAt, "Update time");
  if (!isRecord(value.fieldUpdatedAt)) fail("Field clocks are invalid.");
  for (const [field, clock] of Object.entries(value.fieldUpdatedAt)) assertTimestamp(clock, `Clock for “${field}”`);
  return { ...structuredClone(value), id, attachments } as ReferenceEntry;
}

function putEntry(library: Library, input: unknown) {
  const entry = validateEntry(input);
  const taken = takenKeys(library, entry.id);
  for (const key of [entry.key, ...entry.aliases]) {
    if (taken.has(key.toLowerCase())) fail(`The key “${key}” is already used by another reference.`);
  }
  library.entries[entry.id] = entry;
}

function applyOp(library: Library, op: ReferenceLibraryOp, now: string) {
  if (!isRecord(op)) fail("Library change is invalid.");
  switch (op.op) {
    case "add": return addEntry(library, op.entry, now);
    case "update": return updateEntry(library, op, now);
    case "rename-key": return renameKey(library, op.id, op.key, now);
    case "delete": { const entry = entryById(library, op.id); delete library.entries[entry.id]; return; }
    case "merge": return mergeEntries(library, op.keepId, op.mergeIds, now);
    case "attach": return attach(library, op.id, op.attachment, now);
    case "detach": return detach(library, op.id, op.attachment, now);
    case "put": return putEntry(library, op.entry);
    case "set-style": library.style = validateStyle(op.style); return;
    case "set-settings": library.settings = { ...library.settings, ...structuredClone(validateSettings(op.settings)) }; return;
    default: fail(`Unknown library change “${String((op as { op?: unknown }).op)}”.`);
  }
}

/**
 * Apply ops in order to a copy of the library. All of them apply, or a
 * LibraryOpError is thrown and the input is untouched. The revision is left
 * alone: storage bumps it once per committed transaction.
 */
export function applyLibraryOps(library: ReferenceLibrary, ops: ReferenceLibraryOp[], now: string): { library: ReferenceLibrary; changed: boolean } {
  if (!Array.isArray(ops)) fail("Library changes must be a list.");
  const next = structuredClone(library);
  for (const op of ops) applyOp(next, op, now);
  const changed = !same(next, library);
  return { library: changed ? next : library, changed };
}
