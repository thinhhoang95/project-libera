import { LATEX_ENGINE_LABELS, type LatexEngine, type LatexEngineSetting } from "@/lib/latex/project";
import type { NativeMenuEntry } from "../native-menu";

export type LatexCompileTarget = "main" | "current";

/** Compile options behind the Recompile button, as native menu items: which
 * file to typeset, auto compile, the engine and the build cache. */
export function latexCompileMenuItems({
  target, mainName, currentName, currentDisabledReason, onSelect,
  autoCompile, onAutoCompileChange, engine, resolvedEngine, onEngineChange, clearCacheDisabled, onClearCache,
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
}): NativeMenuEntry[] {
  const engines: { value: LatexEngineSetting; label: string }[] = [
    { value: "auto", label: `Auto (${LATEX_ENGINE_LABELS[resolvedEngine]})` },
    { value: "pdflatex", label: "pdfLaTeX" },
    { value: "xelatex", label: "XeLaTeX" },
    { value: "lualatex", label: "LuaLaTeX" },
  ];
  return [
    { id: "target:main", label: `Compile Main File (${mainName})`, type: "radio", checked: target === "main", onSelect: () => onSelect("main") },
    {
      id: "target:current", label: `Compile Current File (${currentDisabledReason ?? currentName})`, type: "radio", checked: target === "current",
      enabled: !currentDisabledReason, onSelect: () => onSelect("current"),
    },
    { type: "separator" },
    { id: "auto-compile", label: "Auto Compile", type: "checkbox", checked: autoCompile, onSelect: () => onAutoCompileChange(!autoCompile) },
    { type: "separator" },
    // A "% !TEX program = …" line in the document takes precedence.
    { id: "engine", label: "TeX Engine", enabled: false },
    ...engines.map((option): NativeMenuEntry => ({
      id: `engine:${option.value}`, label: option.label, type: "radio", checked: engine === option.value, onSelect: () => onEngineChange(option.value),
    })),
    { type: "separator" },
    { id: "clear-cache", label: "Clear Cache…", enabled: !clearCacheDisabled, onSelect: onClearCache },
  ];
}
