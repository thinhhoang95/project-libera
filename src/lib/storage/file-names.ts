// How file names are compared where a file is found again by its name (Try to
// fix, storage/repair.ts) and where the check hints at it (storage/integrity.ts):
// one definition, so the two never disagree.

/**
 * A name under Unicode normalization (NFC) and full case folding: a name a
 * sync client returns decomposed, a case-only rename, `ß` and `SS`, and the
 * two sigmas (`σ`, `ς`) are all one name. Upper then lower case folds the way
 * the Unicode full folding does (`ß` to `ss`), except `ı` (dotless i), which
 * folding keeps apart from `i` and so is kept apart here.
 */
export function foldedFileName(name: string) {
  return name.normalize("NFC").replace(/ı/g, "").toUpperCase().toLowerCase().normalize("NFC");
}
