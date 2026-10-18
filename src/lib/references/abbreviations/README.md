# Journal abbreviation data

Used by `../journal-abbreviations.ts` (ISO 4 abbreviations for BibTeX export, the `.bib` mirror and CSL styles that print short journal titles).

## What is here

- `journals.ts`: about 380 full journal titles and their ISO 4 abbreviations, one `Title<TAB>Abbreviation` line each. It is loaded lazily (a separate chunk in the client, a dynamic import on the server).
- The title-word stems used for rule-based abbreviation are a list of about 360 stems in `../journal-abbreviations.ts` itself, so that rule-based abbreviation works without loading anything.

## Sources and licence

Both lists were written for Libera by hand from the ISO 4 rules (drop articles, prepositions and conjunctions; abbreviate each remaining word by its title-word stem; keep a title of one word whole) and from abbreviations in common use for these journals. No third-party list was copied into them. They are covered by the Libera project's own licence.

Third-party lists were considered and not bundled:

- **LTWA (List of Title Word Abbreviations)**, ISSN International Centre: the authoritative word list behind ISO 4, with about 56,500 entries. Its terms of reuse and redistribution could not be verified (the ISSN portal offers it for consultation and export but states no licence we could find). It is therefore not bundled. If the ISSN International Centre confirms that redistribution is allowed, its CSV can replace the stem list.
- **JabRef abbreviation lists** (`github.com/JabRef/abbrv.jabref.org`): the repository is CC0-1.0. Its lists are several megabytes and some are compiled from other publishers' lists with their own histories (see that repository's `journals/README.md`). A subset could be imported into `journals.ts` later; keep the result under about 1 MB and record which lists were used here.

## Updating

Add or correct lines in `journals.ts` (titles are matched case-insensitively, without accents or punctuation, with `&` read as "and" and a leading "The" ignored). Add a stem to `WORD_STEMS` in `../journal-abbreviations.ts` when a common title word is missing; a stem ending in `-` matches every word that starts with it.
