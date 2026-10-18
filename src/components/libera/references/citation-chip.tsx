"use client";

import { createElement, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ElementContent } from "hast";
import { entryForKey, sanitizeCitationHtml } from "@/lib/references/format";
import { parseCitationToken } from "@/lib/references/citation-syntax";
import type { Citation } from "@/lib/references/types";
import { citationIndex, formattedCitation, useCitationDocument, useReferenceRender } from "./reference-render-context";
import { CitationHoverCard } from "./citation-hover-card";
import { citationRetractionClass } from "./retraction-badge";

// A citation in rendered Markdown: `<span class="libera-citation"
// data-libera-citation="RAW">` (lanes.md, "Rendered citation DOM"). With a
// reference render provider it shows the document's formatted citation and
// opens a hover card; without one it shows the raw token as a chip.

function hastToReact(nodes: ElementContent[], keyPrefix = ""): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}${index}`;
    if (node.type === "text") return node.value;
    if (node.type !== "element") return null;
    const { className, style, href, rel, target } = node.properties;
    const props: Record<string, unknown> = { key };
    if (Array.isArray(className)) props.className = className.join(" ");
    // The sanitizer keeps exactly one style: small caps.
    if (style === "font-variant:small-caps") props.style = { fontVariant: "small-caps" };
    if (typeof href === "string") {
      props.href = href;
      props.rel = Array.isArray(rel) ? rel.join(" ") : "noopener noreferrer";
      props.target = typeof target === "string" ? target : "_blank";
    }
    return createElement(node.tagName, props, ...hastToReact(node.children, `${key}.`));
  });
}

/** Formatted citation or bibliography HTML (from format.ts), rendered through the citation allowlist. */
export function FormattedCitationHtml({ html }: { html: string }) {
  const nodes = useMemo(() => hastToReact(sanitizeCitationHtml(html).children as ElementContent[]), [html]);
  return <>{nodes}</>;
}

function stringProp(props: Record<string, unknown>, key: string) {
  const value = props[key];
  return typeof value === "string" ? value : undefined;
}

function childText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(childText).join("");
  return "";
}

/** The citation a rendered chip stands for: the parsed data-citation, else its raw token. */
function chipCitation(raw: string, json: string | undefined): Citation {
  if (json) {
    try {
      const citation = JSON.parse(json) as Citation;
      if (Array.isArray(citation?.items)) return { ...citation, raw };
    } catch {
      // Fall back to the token.
    }
  }
  return parseCitationToken(raw) ?? { items: [], raw };
}

/** How the card is open; "pinned-focus" was pinned from the keyboard and moves focus into the card. */
type CardState = "hover" | "focus" | "pinned" | "pinned-focus" | null;
const OPEN_DELAY_MS = 250;
const CLOSE_DELAY_MS = 200;

export function CitationChip(props: { className?: string; children?: ReactNode; [attribute: string]: unknown }) {
  const raw = stringProp(props, "data-libera-citation") ?? childText(props.children);
  const json = stringProp(props, "data-citation");
  const sourceStart = stringProp(props, "data-source-start");
  const sourceEnd = stringProp(props, "data-source-end");
  const previewSourceId = stringProp(props, "data-preview-source-id");
  const render = useReferenceRender();
  const document = useCitationDocument();
  const citation = useMemo(() => chipCitation(raw, json), [raw, json]);
  const cardId = useId();
  const chipRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState<CardState>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pinned = card === "pinned" || card === "pinned-focus";

  const clearTimer = () => clearTimeout(timer.current);
  useEffect(() => () => clearTimeout(timer.current), []);

  const close = useCallback((returnFocus = false) => {
    clearTimeout(timer.current);
    setCard(null);
    if (returnFocus) chipRef.current?.focus();
  }, [setCard]);

  const sourceAttributes = {
    "data-source-start": sourceStart,
    "data-source-end": sourceEnd,
    "data-preview-source-id": previewSourceId,
  };
  if (!render) {
    return <span className="libera-citation" data-libera-citation={raw} {...sourceAttributes}>{raw}</span>;
  }

  const unresolved = render.library !== null && citation.items.some((item) => !entryForKey(render.entriesByKey, item.key));
  // Retracted, withdrawn or concerning works get a warning style; corrected ones a softer one.
  const retraction = citationRetractionClass(citation.items.map((item) => entryForKey(render.entriesByKey, item.key)));
  const chipClass = ["libera-citation", unresolved ? "libera-citation-unresolved" : "", retraction ?? ""].filter(Boolean).join(" ");
  const index = document ? citationIndex(document, raw, previewSourceId, sourceStart === undefined ? undefined : Number(sourceStart)) : -1;
  const html = document ? formattedCitation(document, index, raw) : null;

  const scheduleOpen = (state: "hover" | "focus") => {
    clearTimer();
    if (pinned) return;
    if (state === "focus") {
      setCard("focus");
      return;
    }
    timer.current = setTimeout(() => setCard((current) => current ?? "hover"), OPEN_DELAY_MS);
  };
  const scheduleClose = () => {
    clearTimer();
    if (pinned) return;
    timer.current = setTimeout(() => setCard((current) => current === "pinned" || current === "pinned-focus" ? current : null), CLOSE_DELAY_MS);
  };
  const togglePin = (fromKeyboard: boolean) => {
    clearTimer();
    if (pinned) {
      close();
      return;
    }
    setCard(fromKeyboard ? "pinned-focus" : "pinned");
  };

  return (
    <>
      <span
        ref={chipRef}
        className={chipClass}
        data-libera-citation={raw}
        {...sourceAttributes}
        data-formatted={html ? "true" : undefined}
        role="button"
        tabIndex={0}
        aria-describedby={card ? cardId : undefined}
        aria-expanded={pinned}
        aria-haspopup="dialog"
        onMouseEnter={() => scheduleOpen("hover")}
        onMouseLeave={scheduleClose}
        onFocus={() => scheduleOpen("focus")}
        onBlur={(event) => {
          if (pinned || cardRef.current?.contains(event.relatedTarget as Node | null)) return;
          scheduleClose();
        }}
        onClick={(event) => {
          event.preventDefault();
          togglePin(false);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            togglePin(true);
          } else if (event.key === "Escape" && card) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        {html ? <FormattedCitationHtml html={html} /> : raw}
      </span>
      {card ? (
        <CitationHoverCard
          ref={cardRef}
          id={cardId}
          anchor={chipRef}
          citation={citation}
          document={document}
          pinned={pinned}
          autoFocus={card === "pinned-focus"}
          onClose={close}
          onPointerEnter={clearTimer}
          onPointerLeave={scheduleClose}
        />
      ) : null}
    </>
  );
}
