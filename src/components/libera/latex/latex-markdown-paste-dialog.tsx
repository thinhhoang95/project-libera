"use client";

import { Check, Copy, TriangleAlert } from "lucide-react";
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import {
  autoTopHeading, convertPreparedMarkdown, hasChapters, headingMapFor, isTwoColumn, normalizePlacement, parseHeadingTemplate,
  SECTION_COMMANDS, type HeadingTarget, type LatexPasteContext, type MarkdownPasteChoices, type MarkdownPasteOptions,
  type PreparedMarkdownPaste, type TableEnvironment,
} from "@/lib/latex/markdown-paste";

/* The Paste Markdown as LaTeX dialog (docs/latex-markdown-paste-plan.md §6):
 * how headings and tables are written, more options folded away, and the
 * LaTeX as it will be pasted, converted again on every change. */

export type MarkdownPasteDialogRequest = {
  prepared: PreparedMarkdownPaste;
  context: LatexPasteContext;
  options: MarkdownPasteOptions;
  origin: "paste" | "command" | "selection";
  /** Formatted text (Word, Google Docs, a web page) rather than Markdown. */
  rich?: boolean;
  /** The preamble is in this file, before the paste: missing packages can be added to it. */
  canAddPackages: boolean;
};

const PREVIEW_LINES = 400;
const HEADING_LABELS: Record<HeadingTarget, string> = {
  part: "\\part", chapter: "\\chapter", section: "\\section", subsection: "\\subsection", subsubsection: "\\subsubsection",
  paragraph: "\\paragraph", subparagraph: "\\subparagraph", bold: "Bold paragraph", plain: "Plain paragraph", custom: "Custom…",
};

const selectClass = "min-w-0 rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";
const inputClass = "min-w-0 rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</legend>
      {hint ? <p className="-mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      {children}
    </fieldset>
  );
}

function Toggle({ checked, onChange, children, disabled }: { checked: boolean; onChange: (value: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return (
    <label className={`flex items-center gap-2 text-sm ${disabled ? "opacity-50" : ""}`}>
      <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (value: T) => void }) {
  const id = useId();
  return (
    <label className="flex items-center justify-between gap-3 text-sm" htmlFor={id}>
      <span className="text-muted-foreground">{label}</span>
      <select id={id} className={selectClass} value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
      </select>
    </label>
  );
}

export default function LatexMarkdownPasteDialog({ request, onPaste, onPlain, onCancel }: {
  request: MarkdownPasteDialogRequest;
  /** The choices made; the editor converts again with them for the document as it is when the dialog closes. */
  onPaste: (choices: MarkdownPasteChoices, options: MarkdownPasteOptions) => void;
  onPlain: () => void;
  onCancel: () => void;
}) {
  const { prepared, context, origin } = request;
  const { analysis } = prepared;
  const ranks = analysis.headingDepths.length;
  const formId = useId();
  const autoTop = autoTopHeading(context);
  const twoColumn = isTwoColumn(context);
  const [options, setOptions] = useState<MarkdownPasteOptions>(() => ({ ...request.options, headingLabels: request.options.headingLabels || analysis.internalLinks }));
  const [labelsTouched, setLabelsTouched] = useState(false);
  const [headingMap, setHeadingMap] = useState<HeadingTarget[]>(() => headingMapFor(request.options.headingTop, ranks, context));
  const [touchedRows, setTouchedRows] = useState<ReadonlySet<number>>(new Set());
  const [customs, setCustoms] = useState<string[]>(() => Array.from({ length: ranks }, () => request.options.headingCustom));
  const [tables, setTables] = useState(() => analysis.tables.map((table) => ({ caption: request.options.tableCaptionFromText ? table.caption : "", label: "" })));
  const [touchedCaptions, setTouchedCaptions] = useState<ReadonlySet<number>>(new Set());
  const [addPackages, setAddPackages] = useState(false);
  const [remember, setRemember] = useState(false);
  const [copied, setCopied] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);
  const tableButtonRef = useRef<HTMLButtonElement | null>(null);
  const set = <K extends keyof MarkdownPasteOptions>(key: K, value: MarkdownPasteOptions[K]) => setOptions((current) => ({ ...current, [key]: value }));

  // The package checkbox does not change the LaTeX, so it is not part of the conversion; the preview
  // follows the other choices a moment later on large pastes, so typing a caption stays responsive.
  const conversionChoices: MarkdownPasteChoices = useMemo(() => ({ ...options, headingMap, headingCustoms: customs, tables }), [options, headingMap, customs, tables]);
  const deferredChoices = useDeferredValue(conversionChoices);
  const result = useMemo(() => convertPreparedMarkdown(prepared, deferredChoices, context), [prepared, deferredChoices, context]);
  const templateErrors = headingMap.map((target, rank) => {
    if (target !== "custom") return null;
    const parsed = parseHeadingTemplate(customs[rank] ?? "");
    return "error" in parsed ? parsed.error : null;
  });
  const invalid = templateErrors.some(Boolean);
  const previewLines = result.latex.split("\n");
  const preview = previewLines.length > PREVIEW_LINES ? `${previewLines.slice(0, PREVIEW_LINES).join("\n")}\n% … ${previewLines.length - PREVIEW_LINES} more lines` : result.latex;
  const missingLines = result.missing.map((pkg) => pkg.line).join("\n");
  const longtableChosen = options.tableEnvironment === "longtable";
  // In two-column documents a chosen longtable is written as tabular, with the float choices of a tabular.
  const longtable = longtableChosen && !twoColumn;
  const floatAllowed = !longtable && options.tableFloat !== "none";
  const showPlacement = (analysis.tables.length && floatAllowed) || (analysis.images > 0 && options.images === "figure");

  // Focus starts in the dialog (its first choice, or Paste when there is nothing to choose) and stays in it.
  useEffect(() => {
    const dialog = formRef.current?.closest<HTMLElement>("[role=dialog]");
    const first = firstFieldRef.current ?? tableButtonRef.current ?? dialog?.querySelector<HTMLElement>("button[type=submit]");
    first?.focus();
    if (!dialog) return;
    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>("button, select, input, textarea, summary, [tabindex]:not([tabindex='-1'])"))
      .filter((element) => !element.hasAttribute("disabled") && element.offsetParent !== null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && (index <= 0)) { event.preventDefault(); items[items.length - 1].focus(); }
      else if (!event.shiftKey && (index === -1 || index === items.length - 1)) { event.preventDefault(); items[0].focus(); }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) focusables()[0]?.focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => { document.removeEventListener("keydown", onKeyDown, true); document.removeEventListener("focusin", onFocusIn); };
  }, []);

  /** The first row may stay automatic (one level below the cursor's section, wherever the next paste lands) or be fixed. */
  function setTop(value: "auto" | HeadingTarget) {
    const defaults = headingMapFor(value, ranks, context);
    const next = [...headingMap];
    next[0] = defaults[0];
    for (let row = 1; row < ranks; row++) if (!touchedRows.has(row)) next[row] = defaults[row];
    set("headingTop", value);
    setHeadingMap(next);
  }

  function setRow(rank: number, target: HeadingTarget) {
    if (rank === 0) { setTop(target); return; }
    setTouchedRows((current) => new Set(current).add(rank));
    setHeadingMap((current) => current.map((value, row) => row === rank ? target : value));
  }

  function setCaptionDetection(on: boolean) {
    set("tableCaptionFromText", on);
    setTables((current) => current.map((table, index) => touchedCaptions.has(index) ? table : { ...table, caption: on ? analysis.tables[index]?.caption ?? "" : "" }));
  }

  function confirm() {
    if (invalid) return;
    const saved: MarkdownPasteOptions = {
      ...options,
      headingLabels: labelsTouched ? options.headingLabels : request.options.headingLabels,
      headingCustom: headingMap[0] === "custom" ? customs[0] ?? "" : options.headingCustom,
      tablePlacement: normalizePlacement(options.tablePlacement),
      ask: remember ? "never" : options.ask,
    };
    onPaste({ ...conversionChoices, addPackages }, saved);
  }

  function togglePlacement(letter: string, on: boolean) {
    if (letter === "H") { set("tablePlacement", on ? "H" : "htbp"); return; }
    const current = options.tablePlacement === "H" ? "" : options.tablePlacement;
    set("tablePlacement", normalizePlacement(on ? current + letter : current.replace(letter, "")) || "htbp");
  }

  async function copyPackages() {
    try {
      await navigator.clipboard.writeText(missingLines);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* the lines stay selectable */ }
  }

  const ladder = SECTION_COMMANDS.map((command) => ({ command, disabled: command === "chapter" && !hasChapters(context) }));
  const selection = origin === "selection";
  const title = selection ? "Convert Markdown to LaTeX" : request.rich ? "Paste as LaTeX" : "Paste Markdown as LaTeX";
  const cursorHint = context.sectionCommand && context.sectionTitle
    ? `The cursor is in \\${context.sectionCommand}{${context.sectionTitle.length > 48 ? `${context.sectionTitle.slice(0, 47)}…` : context.sectionTitle}}.`
    : "There is no heading before the cursor.";

  return (
    <ModalDialog
      open
      title={title}
      description={`Choose how the ${request.rich ? "pasted text's" : "Markdown's"} headings and tables are written. The LaTeX on the right is what will be inserted.`}
      panelClassName="max-w-5xl"
      onClose={onCancel}
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          {!selection ? (
            <Toggle checked={remember} onChange={setRemember}>Next time, paste without asking</Toggle>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {!selection ? (
              <button type="button" className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted" onClick={onPlain} title="Paste the Markdown as it is (⇧⌘V)">Paste as plain text</button>
            ) : null}
            <button type="button" className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted" onClick={onCancel}>Cancel</button>
            <button type="submit" form={formId} disabled={invalid} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60">
              {selection ? "Convert" : "Paste as LaTeX"}
            </button>
          </div>
        </div>
      }
    >
      <form
        ref={formRef}
        id={formId}
        className="grid min-h-0 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]"
        onSubmit={(event) => { event.preventDefault(); confirm(); }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); confirm(); }
          if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "v" && !selection) { event.preventDefault(); onPlain(); }
        }}
      >
        <div className="flex max-h-[62vh] min-w-0 flex-col gap-3 overflow-y-auto pr-1">
          {ranks ? (
            <Group title="Headings" hint={cursorHint}>
              {analysis.headingDepths.map((depth, rank) => (
                <div key={depth} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="w-14 shrink-0 font-mono text-sm text-muted-foreground">{"#".repeat(depth)}</span>
                    <span className="min-w-0 flex-1 truncate text-sm" title={analysis.headingSamples[rank]}>{analysis.headingSamples[rank] || "(empty)"}</span>
                    <span aria-hidden className="text-muted-foreground">→</span>
                    <select
                      ref={rank === 0 ? firstFieldRef : undefined}
                      aria-label={`Heading level ${depth} becomes`}
                      className={`${selectClass} w-44`}
                      value={rank === 0 && options.headingTop === "auto" ? "auto" : headingMap[rank]}
                      onChange={(event) => rank === 0 ? setTop(event.target.value as "auto" | HeadingTarget) : setRow(rank, event.target.value as HeadingTarget)}
                    >
                      {rank === 0 ? <option value="auto">Automatic ({HEADING_LABELS[autoTop]} here)</option> : null}
                      {ladder.map(({ command, disabled }) => (
                        <option key={command} value={command} disabled={disabled}>{HEADING_LABELS[command]}{disabled ? " (not in this class)" : ""}</option>
                      ))}
                      <option value="bold">{HEADING_LABELS.bold}</option>
                      <option value="plain">{HEADING_LABELS.plain}</option>
                      <option value="custom">{HEADING_LABELS.custom}</option>
                    </select>
                  </div>
                  {headingMap[rank] === "custom" ? (
                    <div className="ml-16 flex flex-col gap-0.5">
                      <input
                        className={`${inputClass} font-mono`}
                        placeholder="\frametitle  or  \textbf{\large #1}\par"
                        aria-label={`Custom command for heading level ${depth}`}
                        value={customs[rank] ?? ""}
                        spellCheck={false}
                        aria-invalid={!!templateErrors[rank]}
                        onChange={(event) => setCustoms((current) => current.map((value, index) => index === rank ? event.target.value : value))}
                      />
                      <span className={`text-xs ${templateErrors[rank] ? "text-destructive" : "text-muted-foreground"}`}>
                        {templateErrors[rank] ?? "A command name, or a template where #1 is the heading's text."}
                      </span>
                    </div>
                  ) : null}
                </div>
              ))}
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                <Toggle checked={options.headingStarred} onChange={(value) => set("headingStarred", value)}>Unnumbered (\section*)</Toggle>
                <Toggle checked={options.headingLabels} onChange={(value) => { setLabelsTouched(true); set("headingLabels", value); }}>Add labels</Toggle>
                {analysis.numberedHeadings ? (
                  <Toggle checked={options.stripHeadingNumbers} onChange={(value) => set("stripHeadingNumbers", value)}>Remove numbers such as “1.2”</Toggle>
                ) : null}
              </div>
            </Group>
          ) : null}

          {analysis.tables.length ? (
            <Group title={`Tables (${analysis.tables.length})`}>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">Environment</span>
                <div role="group" aria-label="Table environment" className="inline-flex overflow-hidden rounded-md border border-border">
                  {(["tabular", "tabularx", "longtable"] as TableEnvironment[]).map((name) => {
                    // longtable does not work in two-column documents.
                    const unavailable = name === "longtable" && twoColumn;
                    return (
                      <button
                        key={name}
                        type="button"
                        ref={name === "tabular" ? tableButtonRef : undefined}
                        aria-pressed={options.tableEnvironment === name}
                        disabled={unavailable}
                        title={unavailable ? "longtable does not work in two-column documents" : undefined}
                        className={`px-2.5 py-1 font-mono text-xs disabled:cursor-not-allowed disabled:opacity-50 ${options.tableEnvironment === name && !unavailable ? "bg-primary text-primary-foreground" : "bg-card text-foreground hover:bg-muted"}`}
                        onClick={() => set("tableEnvironment", name)}
                      >{name}</button>
                    );
                  })}
                </div>
              </div>
              {longtable ? <p className="text-xs text-muted-foreground">A longtable breaks across pages and repeats its header. It is shown as source in Visual mode.</p> : null}
              {longtableChosen && twoColumn ? <p className="text-xs text-muted-foreground">longtable does not work in two-column documents: the tables are written as tabular.</p> : null}
              <Choice label="Rules" value={options.tableRules} onChange={(value) => set("tableRules", value)} options={[["booktabs", "booktabs (\\toprule, \\midrule)"], ["simple", "\\hline top, header, bottom"], ["grid", "Grid (| and \\hline)"], ["none", "None"]]} />
              <Choice label="Size" value={options.tableSize} onChange={(value) => set("tableSize", value)} options={[["normal", "Normal"], ["small", "\\small"], ["footnotesize", "\\footnotesize"], ["scriptsize", "\\scriptsize"]]} />
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {options.tableEnvironment !== "tabularx" ? <Toggle checked={options.tableWrap} onChange={(value) => set("tableWrap", value)}>Wrap long columns</Toggle> : null}
                <Toggle checked={options.tableBoldHeader} onChange={(value) => set("tableBoldHeader", value)}>Bold header row</Toggle>
              </div>
              {!longtable ? (
                <Choice
                  label="Float"
                  value={options.tableFloat}
                  onChange={(value) => set("tableFloat", value)}
                  options={[["table", "table"], ...(twoColumn ? [["table*", "table* (both columns)"] as ["table*", string]] : []), ["none", "None (at the cursor)"]]}
                />
              ) : null}
              {floatAllowed ? (
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <Toggle checked={options.tableCentering} onChange={(value) => set("tableCentering", value)}>\centering</Toggle>
                  <Toggle checked={options.tableCaptionBelow} onChange={(value) => set("tableCaptionBelow", value)}>Caption below the table</Toggle>
                </div>
              ) : null}
              {(floatAllowed || longtable) && analysis.tables.some((table) => table.caption) ? (
                <Toggle checked={options.tableCaptionFromText} onChange={setCaptionDetection}>Use a “Table 1: …” line next to a table as its caption</Toggle>
              ) : null}
              {(floatAllowed || longtable) ? analysis.tables.map((table, index) => (
                <div key={index} className="flex flex-col gap-1 rounded-md bg-muted/40 p-2">
                  <span className="truncate text-xs text-muted-foreground" title={table.header.join(", ")}>
                    Table {index + 1}: {table.header.filter(Boolean).slice(0, 4).join(", ") || "no header"} ({table.columns} × {table.rows})
                  </span>
                  <input
                    className={inputClass}
                    placeholder="Caption (Markdown allowed; empty for none)"
                    aria-label={`Caption of table ${index + 1}`}
                    value={tables[index]?.caption ?? ""}
                    onChange={(event) => {
                      const caption = event.target.value;
                      setTouchedCaptions((current) => new Set(current).add(index));
                      setTables((current) => current.map((value, at) => at === index ? { ...value, caption } : value));
                    }}
                  />
                  <input
                    className={`${inputClass} font-mono`}
                    placeholder="Label (made from the caption when empty)"
                    aria-label={`Label of table ${index + 1}`}
                    spellCheck={false}
                    value={tables[index]?.label ?? ""}
                    onChange={(event) => setTables((current) => current.map((value, at) => at === index ? { ...value, label: event.target.value } : value))}
                  />
                </div>
              )) : <p className="text-xs text-muted-foreground">Without a float, tables have no caption or label.</p>}
            </Group>
          ) : null}

          {analysis.images ? (
            <Group title={`Images (${analysis.images})`}>
              <Choice label="Images as" value={options.images} onChange={(value) => set("images", value)} options={[["figure", "figure float"], ["inline", "\\includegraphics only"], ["comment", "A comment"]]} />
              {options.images !== "comment" ? (
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-muted-foreground">Width (× \linewidth)</span>
                  <input type="number" min={0.1} max={1} step={0.05} className={`${inputClass} w-24`} value={options.imageWidth}
                    onChange={(event) => { const value = Number(event.target.value); if (value > 0 && value <= 1) set("imageWidth", value); }} />
                </label>
              ) : null}
            </Group>
          ) : null}

          {showPlacement ? (
            <Group title="Float placement">
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {["h", "t", "b", "p", "!"].map((letter) => (
                  <Toggle key={letter} checked={options.tablePlacement !== "H" && options.tablePlacement.includes(letter)} onChange={(value) => togglePlacement(letter, value)}>
                    <span className="font-mono">{letter}</span>
                  </Toggle>
                ))}
                <Toggle checked={options.tablePlacement === "H"} onChange={(value) => togglePlacement("H", value)}>
                  <span className="font-mono">H</span> <span className="text-xs text-muted-foreground">(float package)</span>
                </Toggle>
              </div>
            </Group>
          ) : null}

          <details className="rounded-lg border border-border p-3 [&_summary]:cursor-pointer">
            <summary className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">More options</summary>
            <div className="mt-2 flex flex-col gap-2">
              <Choice label="Italics" value={options.italic} onChange={(value) => set("italic", value)} options={[["emph", "\\emph"], ["textit", "\\textit"]]} />
              <Choice label="Strikethrough" value={options.strike} onChange={(value) => set("strike", value)} options={[["sout", "\\sout (ulem)"], ["st", "\\st (soul)"]]} />
              <Choice label="Inline code" value={options.inlineCode} onChange={(value) => set("inlineCode", value)} options={[["texttt", "\\texttt"], ["verb", "\\verb"]]} />
              <Choice label="Code blocks" value={options.codeBlocks} onChange={(value) => set("codeBlocks", value)} options={[["verbatim", "verbatim"], ["lstlisting", "lstlisting (listings)"]]} />
              <Choice label="Display math" value={options.displayMath} onChange={(value) => set("displayMath", value)} options={[["brackets", "\\[ … \\]"], ["equation*", "equation*"], ["equation", "equation (numbered)"]]} />
              <Choice label="Inline math" value={options.inlineMath} onChange={(value) => set("inlineMath", value)} options={[["dollar", "$ … $"], ["paren", "\\( … \\)"]]} />
              <Choice label="Links" value={options.links} onChange={(value) => set("links", value)} options={[["href", "\\href"], ["footnote", "Text and \\footnote{\\url}"], ["text", "Text only"]]} />
              <Choice label="Quotation marks" value={options.quotes} onChange={(value) => set("quotes", value)} options={[["latex", "``…''"], ["csquotes", "\\enquote (csquotes)"], ["keep", "As written"]]} />
              <Choice label="Block quotes" value={options.blockquote} onChange={(value) => set("blockquote", value)} options={[["quote", "quote"], ["quotation", "quotation"], ["displayquote", "displayquote (csquotes)"]]} />
              <Choice label="Highlights" value={options.highlight} onChange={(value) => set("highlight", value)} options={[["hl", "\\hl (soul)"], ["colorbox", "\\colorbox"], ["drop", "Plain text"]]} />
              <Toggle checked={options.keepLatex} onChange={(value) => set("keepLatex", value)}>Keep LaTeX commands written in the text</Toggle>
              <Choice
                label="When pasting Markdown"
                value={options.ask}
                onChange={(value) => set("ask", value)}
                options={[["structure", "Ask when it has headings or tables"], ["always", "Always ask"], ["never", "Never ask"], ["off", "Do not convert Markdown"]]}
              />
            </div>
          </details>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <pre
            aria-label="LaTeX to be inserted"
            className="max-h-[48vh] min-h-40 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-2.5 font-mono text-xs leading-relaxed text-foreground"
          >{preview || " "}</pre>
          {result.missing.length ? (
            <div className="flex flex-col gap-1.5 rounded-lg border border-border p-2.5 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">The preamble does not load:</span>
                <button type="button" className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted" onClick={() => void copyPackages()}>
                  {copied ? <Check aria-hidden className="h-3 w-3" /> : <Copy aria-hidden className="h-3 w-3" />}{copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="select-text whitespace-pre-wrap font-mono text-xs text-muted-foreground">{missingLines}</pre>
              {request.canAddPackages ? (
                <Toggle checked={addPackages} onChange={setAddPackages}>Add to the preamble</Toggle>
              ) : (
                <p className="text-xs text-muted-foreground">Add them to the main file&apos;s preamble.</p>
              )}
            </div>
          ) : null}
          {result.warnings.length ? (
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
              {result.warnings.map((warning) => (
                <li key={warning.code} className="flex items-start gap-1.5"><TriangleAlert aria-hidden className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" />{warning.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </form>
    </ModalDialog>
  );
}
