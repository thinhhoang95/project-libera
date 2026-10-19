import { normalizeDoi, normalizeIssn, normalizePmcid, normalizePmid } from "../identifiers";
import { parseDateText, parseMonth } from "../normalize";
import type { CslDate, CslItem, CslName, ReferenceIdentifiers } from "../types";
import { SOURCE_CONFIDENCE, type ResolveContext, type SourceRecord } from "./record";
import { xmlElements, xmlText, xmlToText } from "./xml";

// PubMed through NCBI E-utilities: `esummary` (JSON) for the citation and
// article IDs, `efetch` (XML) for full author names and the abstract, and
// `esearch` to turn a PMCID into a PMID.

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

type EsummaryRecord = {
  uid?: string;
  title?: string;
  source?: string;
  fulljournalname?: string;
  pubdate?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  lang?: string[];
  issn?: string;
  essn?: string;
  authors?: { name?: string; authtype?: string }[];
  articleids?: { idtype?: string; value?: string }[];
  error?: string;
};

/** "Benson DA" (PubMed's family + initials) → CSL. */
function summaryName(name: string): CslName {
  const match = name.trim().match(/^(.+?)\s+([A-Z]{1,4})$/);
  if (!match) return { literal: name.trim() };
  return { family: match[1], given: match[2].split("").map((initial) => `${initial}.`).join(" ") };
}

/** PubMed's ISO 639-2 codes for common languages → the two-letter codes CSL uses. */
const LANGUAGES: Record<string, string> = { eng: "en", fre: "fr", ger: "de", spa: "es", ita: "it", por: "pt", rus: "ru", jpn: "ja", chi: "zh", dut: "nl", pol: "pl", kor: "ko" };

function stripFinalPeriod(title: string) {
  // PubMed ends titles with a period; a title ending in "?" or "!" keeps it.
  return title.replace(/\.$/, "").replace(/^\[(.*)\]$/, "$1").trim();
}

function pubDate(xml: string): CslDate | undefined {
  const pub = xmlElements(xml, "PubDate")[0]?.inner;
  if (!pub) return undefined;
  const year = Number(xmlText(pub, "Year"));
  if (Number.isFinite(year) && year > 0) {
    const month = parseMonth(xmlText(pub, "Month") ?? "");
    const day = Number(xmlText(pub, "Day"));
    const parts: [number, number?, number?] = [year];
    if (month) {
      parts.push(month);
      if (Number.isFinite(day) && day > 0) parts.push(day);
    }
    return { "date-parts": [parts] };
  }
  const medline = xmlText(pub, "MedlineDate");
  return medline ? parseDateText(medline) : undefined;
}

type EfetchDetails = { authors?: CslName[]; abstract?: string; container?: string; issued?: CslDate; doi?: string; pmcid?: string };

function parseEfetch(xml: string): EfetchDetails {
  const article = xmlElements(xml, "PubmedArticle")[0]?.inner ?? "";
  if (!article) return {};
  const authors: CslName[] = [];
  for (const element of xmlElements(xmlElements(article, "AuthorList")[0]?.inner ?? "", "Author")) {
    const collective = xmlText(element.inner, "CollectiveName");
    if (collective) {
      authors.push({ literal: collective });
      continue;
    }
    const family = xmlText(element.inner, "LastName");
    const given = xmlText(element.inner, "ForeName") ?? xmlText(element.inner, "Initials");
    const suffix = xmlText(element.inner, "Suffix");
    if (family) authors.push({ family, ...(given ? { given } : {}), ...(suffix ? { suffix } : {}) });
  }
  const abstractParts = xmlElements(xmlElements(article, "Abstract")[0]?.inner ?? "", "AbstractText").map((element) => {
    const text = xmlToText(element.inner);
    const label = element.attributes.Label;
    return label && text ? `${label.charAt(0)}${label.slice(1).toLowerCase()}: ${text}` : text;
  }).filter(Boolean);
  const ids = xmlElements(article, "ArticleId");
  const doi = normalizeDoi(xmlToText(ids.find((element) => element.attributes.IdType === "doi")?.inner ?? ""))
    ?? normalizeDoi(xmlToText(xmlElements(article, "ELocationID").find((element) => element.attributes.EIdType === "doi")?.inner ?? ""));
  const pmcid = normalizePmcid(xmlToText(ids.find((element) => element.attributes.IdType === "pmc")?.inner ?? ""));
  const journal = xmlElements(article, "Journal")[0]?.inner ?? "";
  return {
    ...(authors.length ? { authors } : {}),
    ...(abstractParts.length ? { abstract: abstractParts.join("\n\n") } : {}),
    ...(xmlText(journal, "Title") ? { container: xmlText(journal, "Title") } : {}),
    ...(pubDate(journal) ? { issued: pubDate(journal) } : {}),
    ...(doi ? { doi } : {}),
    ...(pmcid ? { pmcid } : {}),
  };
}

/** esummary + efetch records → one CSL record. `efetchXml` may be empty when efetch failed. */
export function mapPubmedRecord(summary: EsummaryRecord, efetchXml: string, retrievedAt: string): SourceRecord | null {
  const pmid = normalizePmid(summary.uid);
  if (!pmid || summary.error) return null;
  const details = efetchXml ? parseEfetch(efetchXml) : {};
  const csl: CslItem = { type: "article-journal" };
  if (summary.title) csl.title = stripFinalPeriod(summary.title);
  const authors = details.authors ?? (summary.authors ?? []).filter((author) => author.authtype !== "CollectiveName" || author.name).map((author) => summaryName(author.name ?? "")).filter((name) => name.family || name.literal);
  if (authors.length) csl.author = authors;
  const container = details.container ?? summary.fulljournalname;
  if (container) csl["container-title"] = container;
  if (summary.source && summary.source !== container) csl["container-title-short"] = summary.source;
  const issued = details.issued ?? (summary.pubdate ? parseDateText(summary.pubdate) : undefined);
  if (issued) csl.issued = issued;
  if (summary.volume) csl.volume = summary.volume;
  if (summary.issue) csl.issue = summary.issue;
  if (summary.pages) csl.page = summary.pages;
  if (details.abstract) csl.abstract = details.abstract;
  const language = summary.lang?.[0];
  if (language && language !== "und") csl.language = LANGUAGES[language] ?? language;
  const issn = [summary.issn, summary.essn].map((value) => normalizeIssn(value)).filter(Boolean);
  if (issn.length) csl.ISSN = issn.join(" ");
  const articleIds = summary.articleids ?? [];
  const doi = details.doi ?? normalizeDoi(articleIds.find((item) => item.idtype === "doi")?.value);
  const pmcid = details.pmcid ?? normalizePmcid(articleIds.find((item) => item.idtype === "pmc")?.value);
  const identifiers: ReferenceIdentifiers = { pmid };
  if (doi) {
    identifiers.doi = doi;
    csl.DOI = doi;
  }
  if (pmcid) {
    identifiers.pmcid = pmcid;
    csl.PMCID = pmcid;
  }
  csl.PMID = pmid;
  csl.URL = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
  return {
    source: "pubmed",
    confidence: SOURCE_CONFIDENCE.pubmed!,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    retrievedAt,
    csl,
    identifiers,
  };
}

/** The PMID of a PMCID, through esearch; null when PubMed has none. */
export async function pmidForPmcid(pmcid: string, ctx: ResolveContext) {
  const url = new URL(`${EUTILS}/esearch.fcgi`);
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("term", `${pmcid}[pmcid]`);
  url.searchParams.set("retmode", "json");
  const payload = await ctx.network(() => ctx.http.getJson<{ esearchresult?: { idlist?: string[] } }>(url.toString(), { signal: ctx.signal }));
  const ids = payload?.esearchresult?.idlist ?? [];
  return ids.length === 1 ? normalizePmid(ids[0]) ?? null : null;
}

/** The PubMed record for a PMID, or null when PubMed does not know it. */
export async function fetchPubmedRecord(pmid: string, ctx: ResolveContext): Promise<SourceRecord | null> {
  const summaryUrl = new URL(`${EUTILS}/esummary.fcgi`);
  summaryUrl.searchParams.set("db", "pubmed");
  summaryUrl.searchParams.set("id", pmid);
  summaryUrl.searchParams.set("retmode", "json");
  const payload = await ctx.network(() => ctx.http.getJson<{ result?: Record<string, EsummaryRecord> }>(summaryUrl.toString(), { signal: ctx.signal }));
  const summary = payload?.result?.[pmid];
  if (!summary || summary.error) return null;
  const fetchUrl = new URL(`${EUTILS}/efetch.fcgi`);
  fetchUrl.searchParams.set("db", "pubmed");
  fetchUrl.searchParams.set("id", pmid);
  fetchUrl.searchParams.set("retmode", "xml");
  let xml = "";
  try {
    xml = (await ctx.network(() => ctx.http.getText(fetchUrl.toString(), { signal: ctx.signal, accept: "application/xml" })))?.text ?? "";
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    // The summary alone is a usable record; names stay abbreviated.
  }
  return mapPubmedRecord(summary, xml, ctx.now().toISOString());
}
