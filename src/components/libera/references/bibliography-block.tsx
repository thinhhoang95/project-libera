"use client";

import { useCitationDocument, useReferenceRender } from "./reference-render-context";
import { FormattedCitationHtml } from "./citation-chip";

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
      <FormattedCitationHtml html={bibliography} />
    </section>
  );
}
