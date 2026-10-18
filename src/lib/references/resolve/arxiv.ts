import { normalizeArxivId, normalizeDoi } from "../identifiers";
import { parseDateText } from "../normalize";
import { parseName } from "../names";
import type { CslItem, CslName } from "../types";
import { SOURCE_CONFIDENCE, type ResolveContext, type SourceRecord } from "./record";
import { xmlElements, xmlText } from "./xml";

// arXiv export API (Atom): https://export.arxiv.org/api/query?id_list=…
// A preprint maps to CSL type "article" with arXiv as publisher and the
// arXiv DOI. When arXiv reports the journal DOI of the published version,
// the record links to it as `published-as` and exposes it as `publishedDoi`
// so the pipeline can resolve the published version too.

const API = "https://export.arxiv.org/api/query";

export type ArxivRecord = SourceRecord & {
  /** The journal DOI arXiv reports for the published version. */
  publishedDoi?: string;
  journalRef?: string;
};

export function parseArxivFeed(xml: string, retrievedAt: string): ArxivRecord[] {
  const records: ArxivRecord[] = [];
  for (const entry of xmlElements(xml, "entry")) {
    const idUrl = xmlText(entry.inner, "id") ?? "";
    const arxiv = normalizeArxivId(idUrl);
    // The API answers an unknown ID with an entry titled "Error".
    if (!arxiv || /\/api\/errors/.test(idUrl)) continue;
    const csl: CslItem = { type: "article" };
    const title = xmlText(entry.inner, "title");
    if (title) csl.title = title;
    const author = xmlElements(entry.inner, "author")
      .map((element) => xmlText(element.inner, "name"))
      .filter((name): name is string => !!name)
      .map((name) => parseName(name))
      .filter((name: CslName) => Object.keys(name).length > 0);
    if (author.length) csl.author = author;
    const published = xmlText(entry.inner, "published");
    const issued = published ? parseDateText(published.slice(0, 10)) : undefined;
    if (issued) csl.issued = issued;
    const summary = xmlText(entry.inner, "summary");
    if (summary) csl.abstract = summary;
    csl.publisher = "arXiv";
    csl.number = `arXiv:${arxiv}`;
    const arxivDoi = `10.48550/arxiv.${arxiv}`;
    csl.DOI = arxivDoi;
    csl.URL = `https://arxiv.org/abs/${arxiv}`;
    const primaryCategory = xmlElements(entry.inner, "arxiv:primary_category")[0]?.attributes.term;
    if (primaryCategory) csl.genre = `arXiv preprint (${primaryCategory})`;
    const journalRef = xmlText(entry.inner, "arxiv:journal_ref");
    const publishedDoi = normalizeDoi(xmlText(entry.inner, "arxiv:doi"));
    records.push({
      source: "arxiv",
      confidence: SOURCE_CONFIDENCE.arxiv!,
      url: `https://arxiv.org/abs/${arxiv}`,
      retrievedAt,
      csl,
      identifiers: { arxiv, doi: arxivDoi },
      ...(publishedDoi && publishedDoi !== arxivDoi ? { publishedDoi, versions: [{ relation: "published-as" as const, identifier: publishedDoi }] } : {}),
      ...(journalRef ? { journalRef } : {}),
    });
  }
  return records;
}

/** The arXiv record for an ID, or null when arXiv does not know it. */
export async function fetchArxivRecord(id: string, ctx: ResolveContext): Promise<ArxivRecord | null> {
  const arxiv = normalizeArxivId(id);
  if (!arxiv) return null;
  const url = new URL(API);
  url.searchParams.set("id_list", arxiv);
  url.searchParams.set("max_results", "1");
  const response = await ctx.network(() => ctx.http.getText(url.toString(), { signal: ctx.signal, accept: "application/atom+xml" }));
  if (!response) return null;
  return parseArxivFeed(response.text, ctx.now().toISOString()).find((record) => record.identifiers.arxiv === arxiv) ?? null;
}
