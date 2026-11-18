import type { useTranslations } from "next-intl";
import type { LatexEngine, LatexEngineSetting } from "@/lib/latex/project";
import type { NativeMenuEntry } from "../native-menu";

export type LatexCompileTarget = "main" | "current";

/** Compile options behind the Recompile button, as native menu items: which
 * file to typeset, auto compile, the engine and the build cache. */
export function latexCompileMenuItems({
  target, mainName, currentName, currentDisabledReason, onSelect,
  autoCompile, onAutoCompileChange, engine, resolvedEngine, onEngineChange, clearCacheDisabled, onClearCache, t,
}: {
  target: LatexCompileTarget;
  mainName: string;
  currentName: string;
  /** Why the current file cannot be typeset on its own, if it cannot. */
  currentDisabledReason: string | null;
  onSelect: (target: LatexCompileTarget) => void;
  autoCompile: boolean;
  onAutoCompileChange: (value: boolean) => void;
  engine: LatexEngineSetting;
  /** The engine "Auto" resolves to for this document. */
  resolvedEngine: LatexEngine;
  onEngineChange: (engine: LatexEngineSetting) => void;
  clearCacheDisabled: boolean;
  onClearCache: () => void;
  /** The `latex.latexCompileMenu` translator. */
  t: ReturnType<typeof useTranslations>;
}): NativeMenuEntry[] {
  const engines: { value: LatexEngineSetting; label: string }[] = [
    { value: "auto", label: t("autoEngine", { engine: t(`engineOptions.${resolvedEngine}`) }) },
    { value: "pdflatex", label: t("engineOptions.pdflatex") },
    { value: "xelatex", label: t("engineOptions.xelatex") },
    { value: "lualatex", label: t("engineOptions.lualatex") },
  ];
  return [
    { id: "target:main", label: t("compileMainFile", { mainName }), type: "radio", checked: target === "main", onSelect: () => onSelect("main") },
    {
      id: "target:current", label: t("compileCurrentFile", { current: currentDisabledReason ?? currentName }), type: "radio", checked: target === "current",
      enabled: !currentDisabledReason, onSelect: () => onSelect("current"),
    },
    { type: "separator" },
    { id: "auto-compile", label: t("autoCompile"), type: "checkbox", checked: autoCompile, onSelect: () => onAutoCompileChange(!autoCompile) },
    { type: "separator" },
    // A "% !TEX program = …" line in the document takes precedence.
    { id: "engine", label: t("texEngine"), enabled: false },
    ...engines.map((option): NativeMenuEntry => ({
      id: `engine:${option.value}`, label: option.label, type: "radio", checked: engine === option.value, onSelect: () => onEngineChange(option.value),
    })),
    { type: "separator" },
    { id: "clear-cache", label: t("clearCache"), enabled: !clearCacheDisabled, onSelect: onClearCache },
  ];
}
