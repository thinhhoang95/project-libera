import assert from "node:assert/strict";
import test from "node:test";
import { serializeBibtex } from "../../src/lib/references/bibtex";
import { formatCitations, loadCitationFormatter, loadCslStyle, styleUsesShortContainerTitle } from "../../src/lib/references/format";
import {
  abbreviateJournal,
  abbreviateJournalByRules,
  journalAbbreviationsLoaded,
  journalLookupKey,
  loadJournalAbbreviations,
  lookupJournalAbbreviation,
} from "../../src/lib/references/journal-abbreviations";
import type { CslItem, ReferenceEntry } from "../../src/lib/references/types";

// ISO 4 journal abbreviations: the full-title table, the entry's short title,
// the rule-based fallback, and their use in BibTeX export and citeproc.

const KNOWN: Array<[string, string]> = [
  ["Journal of the American Chemical Society", "J. Am. Chem. Soc."],
  ["Proceedings of the National Academy of Sciences of the United States of America", "Proc. Natl. Acad. Sci. U.S.A."],
  ["The New England Journal of Medicine", "N. Engl. J. Med."],
  ["Physical Review Letters", "Phys. Rev. Lett."],
  ["Nature", "Nature"],
  ["The Lancet", "Lancet"],
  ["Nature Reviews Neuroscience", "Nat. Rev. Neurosci."],
  ["IEEE Transactions on Pattern Analysis and Machine Intelligence", "IEEE Trans. Pattern Anal. Mach. Intell."],
  ["Journal of Physics: Condensed Matter", "J. Phys.: Condens. Matter"],
  ["Trends in Ecology & Evolution", "Trends Ecol. Evol."],
  ["Trends in Ecology and Evolution", "Trends Ecol. Evol."],
  ["PLoS ONE", "PLoS ONE"],
  ["Monthly Notices of the Royal Astronomical Society", "Mon. Not. R. Astron. Soc."],
  ["Chemistry - A European Journal", "Chem. Eur. J."],
  ["journal of neuroscience", "J. Neurosci."],
];

test("the full-title table abbreviates known journals, matched without case, accents, punctuation or a leading article", async () => {
  await loadJournalAbbreviations();
  assert.equal(journalAbbreviationsLoaded(), true);
  for (const [title, expected] of KNOWN) assert.equal(abbreviateJournal(title), expected, title);
  assert.equal(journalLookupKey("The  Journal of Physics: Condensed Matter"), "journal of physics condensed matter");
  assert.equal(lookupJournalAbbreviation("Unknown Journal of Things"), undefined);
});

test("rule-based ISO 4: stop words dropped, title-word stems, unknown words and single-word titles kept", () => {
  const cases: Array<[string, string]> = [
    ["Journal of the American Chemical Society", "J. Am. Chem. Soc."],
    ["Bulletin of the American Mathematical Society", "Bull. Am. Math. Soc."],
    ["Journal of Neurology, Neurosurgery & Psychiatry", "J. Neurol. Neurosurg. Psychiatry"],
    ["Advances in Neural Information Processing Systems", "Adv. Neural Inf. Process. Syst."],
    ["Journal of Applied Polymer Science", "J. Appl. Polym. Sci."],
    ["International Journal of Human-Computer Studies", "Int. J. Hum.-Comput. Stud."],
    ["Knowledge-Based Systems", "Knowl.-Based Syst."],
    ["Zeitschrift für Physik", "Z. Phys."],
    ["Comptes Rendus de l'Académie des Sciences", "C. R. Acad. Sci."],
    ["Journal of Physics: Condensed Matter", "J. Phys.: Condens. Matter"],
    ["The Lancet", "Lancet"],
    ["Biochemistry", "Biochemistry"],
    ["Journal", "Journal"],
    ["Pattern Recognition Letters", "Pattern Recognit. Lett."],
    ["IEEE Access", "IEEE Access"],
    ["eLife", "eLife"],
    ["Phys. Rev. Lett.", "Phys. Rev. Lett."],
    ["Journal of Neuroscience (Online)", "J. Neurosci."],
    ["Water Research", "Water Res."],
  ];
  for (const [title, expected] of cases) assert.equal(abbreviateJournalByRules(title), expected, title);
});

test("the order of preference: table, then the entry's short title, then rules", async () => {
  await loadJournalAbbreviations();
  assert.equal(abbreviateJournal("Physical Review Letters", "PRL"), "Phys. Rev. Lett.", "The table wins");
  assert.equal(abbreviateJournal("Unknown Journal of Testing", "Unk. J. Test"), "Unk. J. Test", "Then the short title");
  assert.equal(abbreviateJournal("Unknown Journal of Research"), "Unknown J. Res.", "Then the rules");
  assert.equal(abbreviateJournal("", "X"), "X");
  assert.equal(abbreviateJournal("   "), "");
});

function entry(key: string, csl: Partial<CslItem>): ReferenceEntry {
  return {
    id: `id_${key}`, key, aliases: [], csl: { type: "article-journal", title: "A title", ...csl } as CslItem, identifiers: {}, provenance: {},
    status: "confirmed", attachments: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", fieldUpdatedAt: {},
  };
}

test("serializeBibtex abbreviates journals without a short title when asked, and only then", async () => {
  await loadJournalAbbreviations();
  const entries = [
    entry("a", { "container-title": "Journal of the American Chemical Society" }),
    entry("b", { "container-title": "Some Journal of Materials Research", "container-title-short": "Some J. Mater. Res." }),
    entry("c", { "container-title": "Applied Unknown Letters" }),
  ];
  const abbreviated = serializeBibtex(entries, { dialect: "biblatex", abbreviateJournals: true });
  assert.match(abbreviated, /@article\{a,[\s\S]*journaltitle = \{J\. Am\. Chem\. Soc\.\}/);
  assert.match(abbreviated, /@article\{b,[\s\S]*journaltitle = \{Some J\. Mater\. Res\.\}/, "The entry's own short title");
  assert.match(abbreviated, /@article\{c,[\s\S]*journaltitle = \{Appl\. Unknown Lett\.\}/, "Rule-based");
  assert.doesNotMatch(abbreviated, /shortjournal = \{J\. Am/, "shortjournal stays the entry's own field");
  const full = serializeBibtex(entries, { dialect: "bibtex" });
  assert.match(full, /journal += \{Journal of the American Chemical Society\}/);
  assert.match(full, /journal += \{Applied Unknown Letters\}/);
});

test("citeproc gets container-title-short for styles that print short journal titles", async () => {
  await loadCitationFormatter();
  const [ieee, apa] = await Promise.all([loadCslStyle("ieee"), loadCslStyle("apa")]);
  assert.equal(styleUsesShortContainerTitle(ieee), true);
  assert.equal(styleUsesShortContainerTitle(apa), false);
  assert.equal(styleUsesShortContainerTitle('<style><text variable="container-title" form="short"/></style>'), true);
  const work = entry("smith2020", {
    author: [{ family: "Smith", given: "Jane" }], issued: { "date-parts": [[2020]] }, volume: "12", page: "1-10",
    "container-title": "IEEE Transactions on Pattern Analysis and Machine Intelligence",
  });
  const citations = [{ items: [{ key: "smith2020" }], raw: "[@smith2020]" }];
  const short = formatCitations({ citations, entries: { smith2020: work }, style: ieee, format: "text" });
  assert.match(short.bibliography, /IEEE Trans\. Pattern Anal\. Mach\. Intell\./);
  const long = formatCitations({ citations, entries: { smith2020: work }, style: apa, format: "text" });
  assert.match(long.bibliography, /IEEE Transactions on Pattern Analysis and Machine Intelligence/);
  assert.equal(work.csl["container-title-short"], undefined, "The entry itself is not changed");
});
