"use client";

import { useCitationDocument, useReferenceRender } from "./reference-render-context";
import { sanitizeCitationHtml } from "@/lib/references/format";
import type { ReferenceLibrary } from "@/lib/references/types";
import { FormattedCitationHtml } from "./citation-chip";
import { RetractionBadge, retractionTone } from "./retraction-badge";

// The document's bibliography: `<section class="libera-bibliography"
// data-libera-bibliography="">` with a References heading and the formatted
// list of the cited, resolved works (lanes.md, "Rendered citation DOM").
// remark-bibliography places it at a `:::bibliography` marker or at the end.
// It is generated, not source: copying drops it. Nothing renders without a
// reference render provider or before anything is formatted.

export function BibliographyBlock(props: { [attribute: string]: unknown }) {
  const render = useReferenceRender();
  const document = useCitationDocument();
  if (!render || !document) return null;
  const placement = props["data-bibliography-placement"];
  if (placement !== "marker" && !document.appendedBibliography) return null;
  const bibliography = document.formatting.result?.bibliography;
  if (!bibliography) return null;
  const source = (key: string) => typeof props[key] === "string" ? props[key] as string : undefined;
  return (
    <section
      className="libera-bibliography"
      data-libera-bibliography=""
      data-source-start={source("data-source-start")}
      data-source-end={source("data-source-end")}
      data-source-block={source("data-source-block")}
      data-preview-source-id={source("data-preview-source-id")}
    >
      <h2 className="libera-bibliography-heading">References</h2>
      <BibliographyEntries bibliography={bibliography} entries={document.formatting.result?.bibliographyEntries ?? {}} library={render.library} />
    </section>
  );
}

/** The wrapper classes of citeproc's bibliography HTML (csl-bib-body, hanging indent…). */
function bibliographyBodyClass(html: string) {
  const root = sanitizeCitationHtml(html).children[0];
  return root?.type === "element" && Array.isArray(root.properties.className) ? root.properties.className.join(" ") : "csl-bib-body";
}

/**
 * The formatted list. When a listed work is retracted, withdrawn or under an
 * expression of concern, each entry is rendered on its own so a small
 * "[Retracted]" badge (with the notice in its tooltip) can follow it. The
 * badge is preview only: copying drops the whole bibliography, the PDF
 * export hides it (globals.css), and formatted exports never include it.
 */
function BibliographyEntries({ bibliography, entries, library }: { bibliography: string; entries: Record<string, string>; library: ReferenceLibrary | null }) {
  const ids = Object.keys(entries);
  const flagged = ids.some((id) => retractionTone(library?.entries[id]?.retraction) === "warning");
  if (!flagged) return <FormattedCitationHtml html={bibliography} />;
  return (
    <div className={bibliographyBodyClass(bibliography)}>
      {ids.map((id) => {
        const status = library?.entries[id]?.retraction;
        return (
          <div key={id} className="libera-bibliography-item">
            <FormattedCitationHtml html={entries[id]} />
            {retractionTone(status) === "warning" ? <RetractionBadge status={status} compact /> : null}
          </div>
        );
      })}
    </div>
  );
}
