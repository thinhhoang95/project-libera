"use client";

import {
  BookMarked, CaseSensitive, CaseUpper, ChevronDown, ChevronUp, Info, Replace, ReplaceAll, Search, Space, TextSelect, Trash2, WholeWord, X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import type { FindMessage, FindMode, FindScope, MatchPreview } from "@/lib/find";
import { BUILT_IN_FIND_PRESETS, type FindPreset } from "@/lib/find/presets";
import { deleteUserFindPreset, getUserFindPresets, saveUserFindPreset, subscribeFindStore } from "@/lib/find/settings-store";
import { FindField, groupColor, queryHighlights, replacementHighlights } from "./find-field";
import type { FindQueryState } from "./use-find-query";

/* The find & replace bar shared by every editor (docs/find-replace-patterns-plan.md §8).
 * Presentational: the editor owns matching and replacing and passes the
 * results in; query, replacement and options live in `useFindQuery`. */

const ICON_BUTTON = "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40";
const TOGGLE = "inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded px-1 text-xs text-muted-foreground hover:bg-muted aria-pressed:bg-primary/15 aria-pressed:text-foreground";
const TEXT_BUTTON = "inline-flex h-8 shrink-0 items-center gap-1 rounded px-2 text-xs text-foreground hover:bg-muted disabled:opacity-40";
const MODES: FindMode[] = ["plain", "pattern", "regex"];
const SCOPES: FindScope[] = ["anywhere", "outsideMath", "insideMath", "skipCommentsAndCode"];

export type FindBarProps = {
  find: FindQueryState;
  matchCount: number;
  activeIndex: number;
  /** The search stopped early (step budget or regex deadline). */
  incomplete?: boolean;
  /** The active match, its captures and what Replace would write. */
  preview?: MatchPreview | null;
  /** Shown after Replace All: how many were replaced and how many skipped. */
  summary?: { replaced: number; skipped: number } | null;
  placeholder: string;
  findInputRef: RefObject<HTMLInputElement | null>;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  /** Show the Where control (editors with math, comments or code). */
  showScopes?: boolean;
  /** In selection: available when the editor had a selection when it was turned on. */
  inSelection?: { active: boolean; onToggle: () => void };
  /** TipTap: interpret the replacement as Markdown. */
  markdownReplacement?: { active: boolean; onToggle: () => void };
  /** Called after a preset fills the bar (TipTap also applies its Markdown flag). */
  onPresetApplied?: (preset: FindPreset) => void;
  className?: string;
  /** Extra controls at the end of the options row. */
  extra?: ReactNode;
};

export function useFindMessageText() {
  const t = useTranslations("find.messages");
  return (message: FindMessage) => {
    switch (message.id) {
      case "invalidRegex": return t("invalidRegex", { detail: message.detail });
      case "unknownType": return t("unknownType", { type: message.type });
      case "unknownCapture": return t("unknownCapture", { name: message.name });
      case "dollarReference": return t("dollarReference", { written: message.written, suggestion: message.suggestion });
      case "notANumber": return t("notANumber", { value: message.value });
      default: return t(message.id);
    }
  };
}

function useUserPresets() {
  return useSyncExternalStore(subscribeFindStore, getUserFindPresets, () => EMPTY_PRESETS);
}
const EMPTY_PRESETS: FindPreset[] = [];

export function FindReplaceBar({
  find, matchCount, activeIndex, incomplete = false, preview, summary, placeholder, findInputRef,
  onNext, onPrevious, onClose, onReplace, onReplaceAll, showScopes = false, inSelection, markdownReplacement,
  onPresetApplied, className = "absolute right-3 top-3 z-20", extra,
}: FindBarProps) {
  const t = useTranslations("find");
  const messageText = useFindMessageText();
  const [panel, setPanel] = useState<"cheat" | "presets" | null>(null);
  const { settings, updateSettings, compiled, compiledReplacement } = find;
  const current = matchCount ? Math.min(activeIndex + 1, matchCount) : 0;
  const queryError = compiled.ok ? null : compiled.error;
  const replacementError = compiledReplacement && !compiledReplacement.ok ? compiledReplacement.error : null;
  const warnings = [...(compiled.ok ? compiled.finder.warnings : compiled.warnings), ...(compiledReplacement?.warnings ?? [])];
  const canReplace = matchCount > 0 && !!find.replacer;
  const isPattern = settings.mode !== "plain";

  function toggleShortcut(event: ReactKeyboardEvent) {
    if (!event.altKey || event.metaKey || event.ctrlKey) return false;
    const map: Record<string, () => void> = {
      KeyC: () => updateSettings({ matchCase: !settings.matchCase }),
      KeyW: () => updateSettings({ wholeWord: !settings.wholeWord }),
      KeyR: () => updateSettings({ mode: settings.mode === "regex" ? "plain" : "regex" }),
      KeyP: () => updateSettings({ mode: settings.mode === "pattern" ? "plain" : "pattern" }),
    };
    const action = map[event.code];
    if (!action) return false;
    event.preventDefault();
    action();
    return true;
  }

  function handleFindKeyDown(event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (toggleShortcut(event)) return;
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (canReplace) onReplaceAll(); }
    else if (event.key === "Enter") { event.preventDefault(); if (event.shiftKey) onPrevious(); else onNext(); }
  }

  function handleReplaceKeyDown(event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (toggleShortcut(event)) return;
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (canReplace) onReplaceAll(); }
    // Shift+Enter types a line break into the replacement.
    else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (canReplace) onReplace(); }
  }

  function applyPreset(preset: FindPreset) {
    find.applyPreset(preset);
    onPresetApplied?.(preset);
    setPanel(null);
    window.requestAnimationFrame(() => findInputRef.current?.focus());
  }

  const status = queryError ?? replacementError;
  return (
    <div
      role="search"
      className={`${className} flex w-[34rem] max-w-[calc(100%-1.5rem)] flex-col gap-1 rounded-lg border border-border bg-card p-1 shadow-lg`}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}
    >
      <div className="flex min-w-0 items-center gap-1">
        <Search aria-hidden className="ml-1 h-4 w-4 shrink-0 text-muted-foreground" />
        <FindField
          value={find.query}
          onChange={find.setQuery}
          onKeyDown={handleFindKeyDown}
          highlights={isPattern ? queryHighlights(compiled.ok ? compiled.finder.parts : compiled.parts) : []}
          label={placeholder}
          placeholder={placeholder}
          inputRef={findInputRef}
          invalid={!!queryError}
        />
        <span className="min-w-14 shrink-0 text-center text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {t("matchCount", { current, total: matchCount })}{incomplete ? "+" : ""}
        </span>
        <button className={ICON_BUTTON} type="button" aria-label={t("previousMatch")} title={t("previousMatch")} disabled={!matchCount} onClick={onPrevious}>
          <ChevronUp aria-hidden className="h-4 w-4" />
        </button>
        <button className={ICON_BUTTON} type="button" aria-label={t("nextMatch")} title={t("nextMatch")} disabled={!matchCount} onClick={onNext}>
          <ChevronDown aria-hidden className="h-4 w-4" />
        </button>
        <button className={ICON_BUTTON} type="button" aria-label={t("close")} title={t("close")} onClick={onClose}>
          <X aria-hidden className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-0.5 pl-6">
        <div role="radiogroup" aria-label={t("modes.label")} className="mr-1 flex shrink-0 rounded border border-border p-0.5">
          {MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={settings.mode === mode}
              title={t(`modeHints.${mode}`)}
              className={`h-6 rounded px-2 text-xs ${settings.mode === mode ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-muted"}`}
              onClick={() => updateSettings({ mode })}
            >
              {t(`modes.${mode}`)}
            </button>
          ))}
        </div>
        <button type="button" className={TOGGLE} aria-pressed={settings.matchCase} aria-label={t("matchCase")} title={t("matchCase")} onClick={() => updateSettings({ matchCase: !settings.matchCase })}>
          <CaseSensitive aria-hidden className="h-4 w-4" />
        </button>
        <button type="button" className={TOGGLE} aria-pressed={settings.wholeWord} aria-label={t("wholeWord")} title={t("wholeWord")} onClick={() => updateSettings({ wholeWord: !settings.wholeWord })}>
          <WholeWord aria-hidden className="h-4 w-4" />
        </button>
        {settings.mode !== "regex" ? (
          <button type="button" className={TOGGLE} aria-pressed={settings.flexibleSpacing} aria-label={t("flexibleSpacing")} title={t("flexibleSpacing")} onClick={() => updateSettings({ flexibleSpacing: !settings.flexibleSpacing })}>
            <Space aria-hidden className="h-4 w-4" />
          </button>
        ) : null}
        <button type="button" className={TOGGLE} aria-pressed={settings.preserveCase} aria-label={t("preserveCase")} title={t("preserveCase")} disabled={settings.matchCase} onClick={() => updateSettings({ preserveCase: !settings.preserveCase })}>
          <CaseUpper aria-hidden className="h-4 w-4" />
        </button>
        {inSelection ? (
          <button type="button" className={TOGGLE} aria-pressed={inSelection.active} aria-label={t("inSelection")} title={t("inSelection")} onClick={inSelection.onToggle}>
            <TextSelect aria-hidden className="h-4 w-4" />
          </button>
        ) : null}
        {markdownReplacement ? (
          <button type="button" className={`${TOGGLE} font-mono`} aria-pressed={markdownReplacement.active} aria-label={t("markdownReplacement")} title={t("markdownReplacement")} onClick={markdownReplacement.onToggle}>
            M↓
          </button>
        ) : null}
        {showScopes ? (
          <select
            aria-label={t("where")}
            title={t("where")}
            className="ml-1 h-7 max-w-40 shrink rounded border border-border bg-background px-1 text-xs text-foreground"
            value={settings.scope}
            onChange={(event) => updateSettings({ scope: event.target.value as FindScope })}
          >
            {SCOPES.map((scope) => <option key={scope} value={scope}>{t(`scopes.${scope}`)}</option>)}
          </select>
        ) : null}
        {extra}
        <span className="flex-1" />
        <button type="button" className={TOGGLE} aria-pressed={panel === "cheat"} aria-label={t("cheatSheet")} title={t("cheatSheet")} onClick={() => setPanel(panel === "cheat" ? null : "cheat")}>
          <Info aria-hidden className="h-4 w-4" />
        </button>
        <button type="button" className={TOGGLE} aria-pressed={panel === "presets"} aria-label={t("presets")} title={t("presets")} onClick={() => setPanel(panel === "presets" ? null : "presets")}>
          <BookMarked aria-hidden className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-w-0 items-start gap-1 pl-6">
        <FindField
          value={find.replacement}
          onChange={find.setReplacement}
          onKeyDown={handleReplaceKeyDown}
          highlights={isPattern && compiledReplacement ? replacementHighlights(compiledReplacement.parts) : []}
          multiline
          label={t("replaceWith")}
          placeholder={t("replaceWith")}
          invalid={!!replacementError}
        />
        <button type="button" className={TEXT_BUTTON} disabled={!canReplace} title={t("replaceTitle")} onClick={onReplace}>
          <Replace aria-hidden className="h-4 w-4" /><span className="libera-btn-label">{t("replace")}</span>
        </button>
        <button type="button" className={TEXT_BUTTON} disabled={!canReplace} title={t("replaceAllTitle")} onClick={onReplaceAll}>
          <ReplaceAll aria-hidden className="h-4 w-4" /><span className="libera-btn-label">{t("replaceAll")}</span>
        </button>
      </div>

      {status ? (
        <p role="alert" className="pl-7 pr-2 text-xs text-red-600 dark:text-red-400">{messageText(status.message)}</p>
      ) : null}
      {!status && warnings.length ? (
        <p className="pl-7 pr-2 text-xs text-amber-700 dark:text-amber-400">{warnings.map((warning) => messageText(warning.message)).join(" · ")}</p>
      ) : null}
      {!status && incomplete ? <p className="pl-7 pr-2 text-xs text-amber-700 dark:text-amber-400">{t("incomplete")}</p> : null}
      {!status && preview ? <PreviewLine preview={preview} /> : null}
      {summary ? (
        <p className="pl-7 pr-2 text-xs text-muted-foreground" aria-live="polite">
          {t("replacedSummary", { replaced: summary.replaced })}{summary.skipped ? ` · ${t("skippedSummary", { skipped: summary.skipped })}` : ""}
        </p>
      ) : null}

      {panel === "cheat" ? <CheatSheet onUse={(preset) => applyPreset(preset)} /> : null}
      {panel === "presets" ? <PresetsPanel find={find} markdownReplacement={markdownReplacement?.active} onApply={applyPreset} /> : null}
    </div>
  );
}

function clip(text: string, length = 60) {
  const flat = text.replace(/\n/g, "⏎");
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function PreviewLine({ preview }: { preview: MatchPreview }) {
  const t = useTranslations("find");
  const messageText = useFindMessageText();
  return (
    <div className="flex min-w-0 flex-col gap-0.5 pl-7 pr-2 text-xs text-muted-foreground">
      {preview.captures.length ? (
        <div className="flex min-w-0 flex-wrap gap-1">
          {preview.captures.map((capture) => (
            <span key={capture.group} className={`max-w-full truncate rounded px-1 font-mono text-foreground ${groupColor(capture.group)}`}>
              @{capture.label} = {clip(capture.text, 40) || "∅"}
            </span>
          ))}
        </div>
      ) : null}
      {preview.result !== null ? (
        <div className="flex min-w-0 items-center gap-1 font-mono" title={t("previewTitle")}>
          <span className="truncate line-through decoration-muted-foreground/60">{clip(preview.matched)}</span>
          <span aria-hidden>→</span>
          {typeof preview.result === "string"
            ? <span className="truncate text-foreground">{clip(preview.result) || "∅"}</span>
            : <span className="truncate text-red-600 dark:text-red-400">{messageText(preview.result.error)}</span>}
        </div>
      ) : null}
    </div>
  );
}

const CHEAT_ROWS: { syntax: string; key: string }[] = [
  { syntax: "*", key: "hole" },
  { syntax: "?", key: "single" },
  { syntax: "@name", key: "named" },
  { syntax: "@name:type", key: "typed" },
  { syntax: "@name/regex/", key: "regexHole" },
  { syntax: "\\*  \\?  \\@", key: "escapes" },
  { syntax: "@1  @name  @0", key: "references" },
  { syntax: "@#", key: "counter" },
  { syntax: "@(n+1)  @(x.upper)", key: "expressions" },
];

const CHEAT_EXAMPLES: FindPreset[] = [
  { id: "example-inline", query: "\\(*\\)", replacement: "\\[@1\\]", mode: "pattern" },
  { id: "example-swap", query: "\\(*,*\\)", replacement: "\\(@2,@1\\)", mode: "pattern" },
  { id: "example-frac", query: "\\frac@n:arg@d:arg", replacement: "\\dfrac{@n}{@d}", mode: "pattern" },
  { id: "example-same", query: "@a+@a", replacement: "2@a", mode: "pattern" },
  { id: "example-percent", query: "@p:num\\%", replacement: "@(p/100)", mode: "pattern" },
  { id: "example-counter", query: "TODO", replacement: "TODO-@#", mode: "pattern" },
  { id: "example-title", query: "\\section{*}", replacement: "\\section{@(1.title)}", mode: "pattern" },
];

function CheatSheet({ onUse }: { onUse: (preset: FindPreset) => void }) {
  const t = useTranslations("find.cheat");
  return (
    <div className="mx-1 mb-1 max-h-80 overflow-auto rounded border border-border bg-background p-2 text-xs">
      <table className="w-full border-collapse">
        <tbody>
          {CHEAT_ROWS.map((row) => (
            <tr key={row.key} className="align-top">
              <td className="whitespace-nowrap py-0.5 pr-3 font-mono text-foreground">{row.syntax}</td>
              <td className="py-0.5 text-muted-foreground">{t(`rows.${row.key}`)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-muted-foreground">{t("types")}</p>
      <p className="mt-2 font-medium text-foreground">{t("examples")}</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {CHEAT_EXAMPLES.map((example) => (
          <li key={example.id}>
            <button type="button" className="w-full rounded px-1 py-0.5 text-left font-mono hover:bg-muted" title={t("useExample")} onClick={() => onUse(example)}>
              <span className="text-foreground">{example.query}</span>
              <span className="text-muted-foreground"> → </span>
              <span className="text-foreground">{example.replacement}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PresetsPanel({ find, markdownReplacement, onApply }: { find: FindQueryState; markdownReplacement?: boolean; onApply: (preset: FindPreset) => void }) {
  const t = useTranslations("find");
  const userPresets = useUserPresets();
  const [name, setName] = useState("");
  const canSave = !!find.query && !!name.trim();
  const save = () => {
    if (!canSave) return;
    saveUserFindPreset({
      name: name.trim(),
      query: find.query,
      replacement: find.replacement,
      mode: find.settings.mode,
      matchCase: find.settings.matchCase,
      wholeWord: find.settings.wholeWord,
      flexibleSpacing: find.settings.flexibleSpacing,
      scope: find.settings.scope,
      ...(markdownReplacement !== undefined ? { markdownReplacement } : {}),
    });
    setName("");
  };
  const row = (preset: FindPreset, label: string, removable: boolean) => (
    <li key={preset.id} className="flex min-w-0 items-center gap-1">
      <button type="button" className="flex min-w-0 flex-1 flex-col rounded px-1 py-0.5 text-left hover:bg-muted" onClick={() => onApply(preset)}>
        <span className="truncate text-foreground">{label}</span>
        <span className="truncate font-mono text-muted-foreground">{preset.query} → {preset.replacement}</span>
      </button>
      {removable ? (
        <button type="button" className={ICON_BUTTON} aria-label={t("deletePreset", { name: label })} title={t("deletePreset", { name: label })} onClick={() => deleteUserFindPreset(preset.id)}>
          <Trash2 aria-hidden className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </li>
  );
  return (
    <div className="mx-1 mb-1 max-h-80 overflow-auto rounded border border-border bg-background p-2 text-xs">
      <p className="font-medium text-foreground">{t("yourPresets")}</p>
      {userPresets.length ? <ul className="mt-1 flex flex-col gap-0.5">{userPresets.map((preset) => row(preset, preset.name ?? preset.query, true))}</ul>
        : <p className="mt-1 text-muted-foreground">{t("noPresets")}</p>}
      <div className="mt-1 flex items-center gap-1">
        <input
          aria-label={t("presetName")}
          placeholder={t("presetName")}
          className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 text-xs outline-none"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); save(); } }}
        />
        <button type="button" className={TEXT_BUTTON} disabled={!canSave} onClick={save}>{t("savePreset")}</button>
      </div>
      <p className="mt-2 font-medium text-foreground">{t("builtInPresets")}</p>
      <ul className="mt-1 flex flex-col gap-0.5">{BUILT_IN_FIND_PRESETS.map((preset) => row(preset, t(`presetNames.${preset.id}`), false))}</ul>
    </div>
  );
}
