# French style for Libera's interface

Used for `messages/fr.json`. Check every change with `node scripts/i18n/check-messages.mjs fr`.

## Voice
- Address the user as « vous ». Concise interface French (as in macOS or Office in French), sentence case.
- Keep as is: product and brand names (Libera, OpenRouter, Crossref, PubMed, arXiv, MiKTeX, TeX Live, Kokoro…),
  file formats (PDF, BibTeX, RIS, CSL-JSON, Markdown, LaTeX), LaTeX commands (`\cite`, `\section`), keyboard
  shortcuts (Ctrl/⌘+S), model names, units.

## Typography
- Typographic apostrophe `’` (U+2019) everywhere: l’éditeur, d’abord. ICU reads an ASCII `'` before `{ } < > #`
  as an escape, so ASCII apostrophes break messages.
- No-break space (U+00A0) before `:` and inside « guillemets ». Narrow no-break space (U+202F) before `;`, `!`, `?`.
- One-character ellipsis `…`.
- Numbers, dates, currency and percentages come from `Intl` (`1 234,5`, `12 %`, `1,50 $US`); never write them into
  messages.

## ICU
- Never translate `{argument}` names, `plural` / `select` keywords or branch keys (`one`, `other`, `=0`, `yes`,
  `none`). Translate only the text inside branches; keep `#`.
- French `one` covers 0 and 1 (« 0 jour actif »).
- Keep rich-text tags (`<link>…</link>`, `<strong>`, `<delta>`, `<line>`) with the same names.

## Glossary
| English | French |
|---|---|
| notebook | carnet |
| note | note |
| workspace | espace de travail |
| tab | onglet |
| folder | dossier |
| reference(s) | référence(s) |
| citation | citation |
| bibliography | bibliographie |
| highlight (noun / verb) | surlignage / surligner |
| comment | commentaire |
| review (request a review) | relecture (demander une relecture) |
| collaborator | collaborateur |
| share | partager |
| album / gallery | album / galerie |
| voice memo | mémo vocal |
| transcript | transcription |
| read aloud | lecture à voix haute |
| compile | compiler |
| preview | aperçu |
| settings / preferences | Préférences |
| undo / redo | annuler / rétablir |
| dismiss | ignorer |
| cancel | annuler |
| save | enregistrer |
| delete | supprimer |
| rename | renommer |
| close | fermer |
| try again | réessayer |
| loading… | chargement… |
| search (verb / noun) | rechercher / recherche |
| ink / pen | encre / stylo |
| outline | plan |
| snippet | extrait |
| spending | dépenses |
| model (AI) | modèle |
| token (AI) | jeton |
| request (API) | requête |
| cache read / write | lecture / écriture du cache |
| agent | agent |
