// Citation formatting off the main thread. citeproc needs hundreds of
// milliseconds for a long document in an author-date style (and to build a
// large style's engine), so previews post the citations, the cited entries
// and the style here. The worker is created only once a document has
// citations; citeproc and the locale are part of its own bundle.
import CSL from "citeproc";
import { CSL_LOCALE_XML } from "./csl/locales.generated";
import { formatCitationDocument, registerCitationFormatter } from "./format";
import { loadJournalAbbreviations } from "./journal-abbreviations";
import type { CitationFormatRequest, CitationFormatResponse } from "./format-client";

registerCitationFormatter(CSL, CSL_LOCALE_XML);
// Short journal titles (IEEE, Nature, Vancouver) use the lazily loaded ISO 4 table; without it they fall back to rules.
const abbreviationsReady = loadJournalAbbreviations().catch(() => undefined);

self.onmessage = async (event: MessageEvent<CitationFormatRequest>) => {
  const { id, input } = event.data;
  await abbreviationsReady;
  let response: CitationFormatResponse;
  try {
    response = { id, result: formatCitationDocument(input) };
  } catch (cause) {
    response = { id, error: cause instanceof Error ? cause.message : "Could not format citations." };
  }
  self.postMessage(response);
};
