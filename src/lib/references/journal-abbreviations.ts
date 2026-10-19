// ISO 4 journal title abbreviations (docs/references/plan.md §4.4, Phase 5).
//
// abbreviateJournal(title, short?) prefers, in order:
//   1. a full-title lookup in the bundled table of journal abbreviations,
//   2. the entry's own short title (`container-title-short`),
//   3. rule-based ISO 4 abbreviation: articles, prepositions and
//      conjunctions are dropped, each remaining word is abbreviated by its
//      title-word stem (below), unknown words are kept whole, and a title
//      left with one word is kept whole ("The Lancet" → "Lancet").
//
// The word stems are small and live here, so rule-based abbreviation works
// everywhere, including the citation worker. The full-title table (~30 kB)
// is loaded lazily with loadJournalAbbreviations(); until it is loaded the
// lookup step is skipped. See abbreviations/README.md for the sources and
// licence of both lists.

/**
 * Title-word stems and their ISO 4 abbreviations. A stem ending in "-"
 * matches every word that starts with it (the longest stem wins); any other
 * stem matches the word itself and its plural in "s". Words that ISO 4 keeps
 * whole (Acta, Cancer, Methods, Neural…) are simply not listed.
 */
const WORD_STEMS: ReadonlyArray<readonly [string, string]> = [
  ["abstracts", "Abstr."], ["academ-", "Acad."], ["accounting", "Account."], ["accounts", "Acc."], ["acoustic-", "Acoust."],
  ["administra-", "Adm."], ["advance-", "Adv."], ["aeronaut-", "Aeronaut."], ["aerospace", "Aerosp."], ["affective", "Affect."],
  ["africa-", "Afr."], ["agricultur-", "Agric."], ["algebraic", "Algebr."], ["america-", "Am."], ["anaesthesi-", "Anaesth."],
  ["analy-", "Anal."], ["anatom-", "Anat."], ["anesthesi-", "Anesth."], ["angewandte", "Angew."], ["animal", "Anim."],
  ["annal-", "Ann."], ["annual", "Annu."], ["anthropolog-", "Anthropol."], ["antimicrob-", "Antimicrob."], ["appli-", "Appl."],
  ["approximat-", "Approx."], ["archaeolog-", "Archaeol."], ["architect-", "Archit."], ["archive-", "Arch."], ["arterioscler-", "Arterioscler."],
  ["artificial", "Artif."], ["association", "Assoc."], ["astronom-", "Astron."], ["astrophys-", "Astrophys."], ["atmospher-", "Atmos."],
  ["australia-", "Aust."], ["automat-", "Autom."], ["bacteriolog-", "Bacteriol."], ["behavio-", "Behav."], ["berichte", "Ber."],
  ["biochemi-", "Biochem."], ["bioinformatic-", "Bioinform."], ["biolog-", "Biol."], ["biomateri-", "Biomater."], ["biomechan-", "Biomech."],
  ["biomedic-", "Biomed."], ["biophysic-", "Biophys."], ["bioresource-", "Bioresour."], ["biotechnolog-", "Biotechnol."], ["botan-", "Bot."],
  ["brazil-", "Braz."], ["britain", "Br."], ["british", "Br."], ["bulletin", "Bull."], ["business", "Bus."],
  ["canad-", "Can."], ["cardiolog-", "Cardiol."], ["cardiovascular", "Cardiovasc."], ["catalys-", "Catal."], ["cellular", "Cell."],
  ["center", "Cent."], ["central", "Cent."], ["centre", "Cent."], ["ceramic-", "Ceram."], ["cerebral", "Cereb."],
  ["chemi-", "Chem."], ["chemotherap-", "Chemother."], ["chinese", "Chin."], ["civil", "Civ."],
  ["cleaner", "Clean."], ["climat-", "Clim."], ["clinic-", "Clin."], ["cognit-", "Cogn."], ["college", "Coll."],
  ["combinator-", "Comb."], ["commun-", "Commun."], ["comparat-", "Comp."], ["comptes", "C."], ["comput-", "Comput."], ["condens-", "Condens."],
  ["conferenc-", "Conf."], ["conservat-", "Conserv."], ["construct-", "Constr."], ["contemporar-", "Contemp."], ["controlled", "Control."],
  ["cosmochim-", "Cosmochim."], ["critical", "Crit."], ["cryptolog-", "Cryptol."], ["crystal", "Cryst."], ["crystallogr-", "Crystallogr."],
  ["cultur-", "Cult."], ["current", "Curr."], ["cybernetic-", "Cybern."], ["decision", "Decis."], ["dental", "Dent."],
  ["dentistry", "Dent."], ["dermatolog-", "Dermatol."], ["design", "Des."], ["develop-", "Dev."], ["diabetolog-", "Diabetol."],
  ["differential", "Differ."], ["discover-", "Discov."], ["disease", "Dis."], ["distribut-", "Distrib."], ["dynam-", "Dyn."],
  ["ecolog-", "Ecol."], ["econom-", "Econ."], ["edition", "Ed."], ["educat-", "Educ."], ["electric-", "Electr."],
  ["electrochem-", "Electrochem."], ["electrochim-", "Electrochim."], ["electronic-", "Electron."], ["emergency", "Emerg."], ["emerging", "Emerg."],
  ["endocrin-", "Endocr."], ["endocrinol-", "Endocrinol."], ["energetic-", "Energ."], ["engineer-", "Eng."], ["english", "Engl."],
  ["entomolog-", "Entomol."], ["environment-", "Environ."], ["epidemiolog-", "Epidemiol."], ["ergonom-", "Ergon."], ["europ-", "Eur."],
  ["evolution-", "Evol."], ["exercise", "Exerc."], ["experiment-", "Exp."], ["family", "Fam."], ["financ-", "Financ."],
  ["forest-", "For."], ["foundation-", "Found."], ["frequency", "Freq."], ["frontier-", "Front."], ["functional", "Funct."],
  ["fundamental-", "Fundam."], ["gastroenterolog-", "Gastroenterol."], ["general", "Gen."], ["genetic-", "Genet."], ["genomic-", "Genom."],
  ["geochemi-", "Geochem."], ["geochim-", "Geochim."], ["geograph-", "Geogr."], ["geolog-", "Geol."], ["geometr-", "Geom."],
  ["geophys-", "Geophys."], ["geoscien-", "Geosci."], ["german-", "Ger."], ["gerontolog-", "Gerontol."], ["global", "Glob."],
  ["graphic-", "Graph."], ["gynaecolog-", "Gynaecol."], ["gynecolog-", "Gynecol."], ["haematolog-", "Haematol."], ["hematolog-", "Hematol."],
  ["hepatolog-", "Hepatol."], ["histor-", "Hist."], ["horizon-", "Horiz."], ["hospital", "Hosp."], ["human", "Hum."],
  ["hydraul-", "Hydraul."], ["hydrolog-", "Hydrol."], ["immunolog-", "Immunol."], ["industr-", "Ind."], ["infect-", "Infect."],
  ["informatics", "Inform."], ["information", "Inf."], ["inorganic", "Inorg."], ["inquiry", "Inq."], ["institut-", "Inst."],
  ["instrument-", "Instrum."], ["integrat-", "Integr."], ["intelligen-", "Intell."], ["interaction-", "Interact."], ["interdisciplinar-", "Interdiscip."],
  ["internal", "Intern."], ["international", "Int."], ["investigat-", "Investig."], ["italian", "Ital."], ["jahrbuch", "Jahrb."],
  ["japan-", "Jpn."], ["journal", "J."], ["knowledge", "Knowl."], ["laborator-", "Lab."], ["language", "Lang."],
  ["learning", "Learn."], ["lecture-", "Lect."], ["legal", "Leg."], ["letter-", "Lett."], ["linguist-", "Linguist."],
  ["literatur-", "Lit."], ["logic", "Log."], ["machine-", "Mach."], ["magazine", "Mag."], ["magnet-", "Magn."],
  ["manage-", "Manag."], ["manufactur-", "Manuf."], ["mapping", "Mapp."], ["marine", "Mar."], ["marketing", "Mark."],
  ["materia-", "Mater."], ["mathemat-", "Math."], ["measurement-", "Meas."], ["mechani-", "Mech."], ["medic-", "Med."],
  ["memory", "Mem."], ["metabol-", "Metab."], ["metallurg-", "Metall."], ["meteorolog-", "Meteorol."], ["methodolog-", "Methodol."],
  ["microbiolog-", "Microbiol."], ["microscop-", "Microsc."], ["microwave-", "Microw."], ["military", "Mil."], ["mineral-", "Mineral."],
  ["mobile", "Mob."], ["modeling", "Model."], ["modelling", "Model."], ["modern", "Mod."], ["molecul-", "Mol."],
  ["monthly", "Mon."], ["multimedia", "Multimed."], ["nanotechnolog-", "Nanotechnol."], ["national", "Natl."], ["natur-", "Nat."],
  ["navigat-", "Navig."], ["nephrolog-", "Nephrol."], ["network-", "Netw."], ["neurolog-", "Neurol."], ["neurophysiolog-", "Neurophysiol."],
  ["neuroscien-", "Neurosci."], ["neurosurg-", "Neurosurg."], ["newsletter", "Newsl."], ["notices", "Not."], ["nuclear", "Nucl."],
  ["numer-", "Numer."], ["nursing", "Nurs."], ["nutrition-", "Nutr."], ["obstetric-", "Obstet."], ["occupation-", "Occup."],
  ["oceanograph-", "Oceanogr."], ["oncolog-", "Oncol."], ["operat-", "Oper."], ["ophthalmolog-", "Ophthalmol."], ["opinion", "Opin."],
  ["optic-", "Opt."], ["optimi-", "Optim."], ["organic", "Org."], ["organis-", "Organ."], ["organiz-", "Organ."],
  ["organometallic-", "Organomet."], ["orthop-", "Orthop."], ["paediatr-", "Paediatr."], ["palaeontolog-", "Palaeontol."], ["paleontolog-", "Paleontol."],
  ["particle-", "Part."], ["pathogen-", "Pathog."], ["patholog-", "Pathol."], ["pediatr-", "Pediatr."], ["personality", "Pers."],
  ["perspective-", "Perspect."], ["pharmac-", "Pharm."], ["pharmacolog-", "Pharmacol."], ["philosoph-", "Philos."], ["phytolog-", "Phytol."],
  ["physic-", "Phys."], ["physik", "Phys."], ["physiolog-", "Physiol."], ["planetary", "Planet."], ["polit-", "Polit."],
  ["pollut-", "Pollut."], ["polymer-", "Polym."], ["practic-", "Pract."], ["probabil-", "Probab."], ["problem-", "Probl."],
  ["proceedings", "Proc."], ["process-", "Process."], ["production", "Prod."], ["program-", "Program."], ["progress", "Prog."],
  ["propagation", "Propag."], ["protocol-", "Protoc."], ["psychiatric", "Psychiatr."], ["psycholog-", "Psychol."], ["quarterly", "Q."],
  ["radiolog-", "Radiol."], ["recherch-", "Rech."], ["recognition", "Recognit."], ["record-", "Rec."], ["regional", "Reg."],
  ["rehabilitat-", "Rehabil."], ["religio-", "Relig."], ["rendus", "R."], ["renewable", "Renew."], ["report-", "Rep."],
  ["reproduct-", "Reprod."], ["research", "Res."], ["resource-", "Resour."], ["respirat-", "Respir."], ["respiratory", "Respir."],
  ["retrieval", "Retr."], ["review-", "Rev."], ["revista", "Rev."], ["revue", "Rev."], ["rivista", "Riv."],
  ["robot-", "Robot."], ["royal", "R."], ["scandinav-", "Scand."], ["scien-", "Sci."], ["security", "Secur."],
  ["selected", "Sel."], ["semiconduct-", "Semicond."], ["sensing", "Sens."], ["sensor-", "Sens."], ["series", "Ser."],
  ["signaling", "Signal."], ["signalling", "Signal."], ["simulat-", "Simul."], ["social", "Soc."], ["societ-", "Soc."],
  ["sociolog-", "Sociol."], ["software", "Softw."], ["spectroscop-", "Spectrosc."], ["statist-", "Stat."], ["structur-", "Struct."],
  ["studies", "Stud."], ["study", "Stud."], ["supplement-", "Suppl."], ["surface-", "Surf."], ["surgery", "Surg."],
  ["surgical", "Surg."], ["survey-", "Surv."], ["sustainab-", "Sustain."], ["symbolic", "Symb."], ["symposium", "Symp."],
  ["system-", "Syst."], ["teaching", "Teach."], ["technical", "Tech."], ["technique-", "Tech."], ["technolog-", "Technol."],
  ["telecommunicat-", "Telecommun."], ["theoret-", "Theor."], ["therap-", "Ther."], ["thermal", "Therm."], ["topics", "Top."],
  ["topolog-", "Topol."], ["toxicolog-", "Toxicol."], ["transaction-", "Trans."], ["translational", "Transl."], ["transport-", "Transp."],
  ["tropical", "Trop."], ["ultrason-", "Ultrason."], ["understanding", "Underst."], ["universit-", "Univ."], ["urolog-", "Urol."],
  ["vehic-", "Veh."], ["veterinar-", "Vet."], ["virolog-", "Virol."], ["vision", "Vis."], ["visualiz-", "Vis."],
  ["weekly", "Wkly."], ["wireless", "Wirel."], ["zeitschrift", "Z."], ["zoolog-", "Zool."],
];

/** Articles, prepositions and conjunctions that ISO 4 drops (English, French, German, Spanish, Italian). */
const STOP_WORDS = new Set([
  "a", "an", "the", "of", "on", "in", "for", "and", "to", "at", "by", "with", "from", "into", "&", "+",
  "und", "der", "die", "das", "des", "dem", "den", "für", "fur", "zur", "zum",
  "de", "du", "la", "le", "les", "et", "en", "aux", "au",
  "y", "el", "los", "las", "del", "di", "della", "dello", "dei", "e",
]);

const exactStems = new Map<string, string>();
const prefixStems: Array<[string, string]> = [];
for (const [stem, abbreviation] of WORD_STEMS) {
  if (stem.endsWith("-")) prefixStems.push([stem.slice(0, -1), abbreviation]);
  else exactStems.set(stem, abbreviation);
}
// Longest first, so "pharmacolog-" wins over "pharmac-".
prefixStems.sort((left, right) => right[0].length - left[0].length);

function fold(text: string) {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** The key a title is looked up by: lowercase, no accents or punctuation, "&" as "and", no leading article. */
export function journalLookupKey(title: string) {
  return fold(title)
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(?:the|a|an) /, "");
}

function stemFor(word: string) {
  const folded = fold(word);
  const exact = exactStems.get(folded) ?? (folded.endsWith("s") ? exactStems.get(folded.slice(0, -1)) : undefined);
  if (exact) return exact;
  for (const [prefix, abbreviation] of prefixStems) if (folded.startsWith(prefix)) return abbreviation;
  return undefined;
}

/** A word ISO 4 leaves as it is: an acronym, a word with digits or inner capitals, or one already abbreviated. */
function keptAsIs(word: string) {
  return word.length < 2 || /\d/.test(word) || /\.$/.test(word) || /^[A-Z]{2,}$/.test(word) || /[a-z][A-Z]/.test(word);
}

function abbreviateWord(word: string): string {
  if (word.includes("-") && !/^-|-$/.test(word)) return word.split("-").map(abbreviateWord).join("-");
  if (keptAsIs(word)) return word;
  const abbreviation = stemFor(word);
  if (!abbreviation || abbreviation.replace(/\.$/, "").length >= word.length) return word;
  const upper = word[0] === word[0].toUpperCase();
  return upper ? abbreviation : abbreviation[0].toLowerCase() + abbreviation.slice(1);
}

function isStopWord(word: string) {
  const folded = fold(word);
  return STOP_WORDS.has(folded);
}

/** One part of a title (titles are split at ": "). */
function abbreviateSegment(segment: string, keepSingleWord: boolean) {
  const words = segment.split(/\s+/).map((word) => word.replace(/^[(“"']+|[,;)”"']+$/g, "")).filter(Boolean);
  // French elisions: "l'Académie" is "Académie".
  const kept = words.map((word) => word.replace(/^[ld]['’](?=\p{L})/iu, "")).filter((word) => word && !isStopWord(word));
  if (!kept.length) return "";
  // A title of one significant word is never abbreviated ("Nature", "The Lancet").
  if (keepSingleWord && kept.length === 1) return kept[0];
  return kept.map(abbreviateWord).join(" ");
}

/** Rule-based ISO 4 abbreviation of a title, without the full-title table. */
export function abbreviateJournalByRules(title: string) {
  const clean = title.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const segments = clean.split(/\s*:\s+/);
  const single = segments.length === 1;
  return segments.map((segment) => abbreviateSegment(segment, single)).filter(Boolean).join(": ");
}

// ---------------------------------------------------------------------------
// Full-title table
// ---------------------------------------------------------------------------

let table: Map<string, string> | null = null;
let loading: Promise<void> | null = null;

/** Parse the bundled "Full title<TAB>Abbreviation" lines. */
export function parseJournalAbbreviationTable(text: string) {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const key = journalLookupKey(line.slice(0, tab));
    const abbreviation = line.slice(tab + 1).trim();
    if (key && abbreviation && !map.has(key)) map.set(key, abbreviation);
  }
  return map;
}

/** Import the full-title table. Resolves once lookups use it; cheap after the first call. */
export function loadJournalAbbreviations(): Promise<void> {
  if (table) return Promise.resolve();
  loading ??= import("./abbreviations/journals").then((module) => {
    table = parseJournalAbbreviationTable(module.JOURNAL_ABBREVIATIONS);
  }).catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}

export function journalAbbreviationsLoaded() {
  return table !== null;
}

/** The table's abbreviation for a full title, or undefined (also before the table is loaded). */
export function lookupJournalAbbreviation(title: string) {
  return table?.get(journalLookupKey(title));
}

/**
 * The ISO 4 abbreviation of a journal title: the full-title table, else the
 * entry's short title, else rule-based abbreviation. Empty input gives "".
 */
export function abbreviateJournal(title: string, shortTitle?: string): string {
  const trimmed = title.trim();
  if (!trimmed) return shortTitle?.trim() ?? "";
  const known = lookupJournalAbbreviation(trimmed);
  if (known) return known;
  if (shortTitle?.trim()) return shortTitle.trim();
  return abbreviateJournalByRules(trimmed) || trimmed;
}
