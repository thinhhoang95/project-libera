"use client";

import { Check, ChevronDown, Settings2 } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { apiRequest } from "./api-client";

/**
 * The small model label under AI Format, AI Rewrite and Write with AI in the
 * editors' context menus. It reads like a select without its border; picking
 * changes the model and reasoning effort for that action, from the Model Pool
 * (Preferences → AI), until the action's default in Preferences changes.
 */
export type AiTask = "formatting" | "rewrite" | "write";
type Effort = "low" | "medium" | "high" | "xhigh" | "max";
type TaskDefault = { model: string; reasoningEffort: Effort };
type Choices = { pool: string[]; tasks: Record<AiTask, TaskDefault> };
/** `base` is the default the choice was made against: a new default in Preferences replaces the choice. */
type TaskChoice = { model: string; reasoningEffort: Effort; base: string };

const STORAGE_KEY = "libera-ai-task-models";
const CHANGE_EVENT = "libera-ai-task-models-change";
const EFFORTS: { value: Effort; label: string; title: string }[] = [
  { value: "low", label: "Low", title: "Low" },
  { value: "medium", label: "Med", title: "Medium" },
  { value: "high", label: "High", title: "High" },
  { value: "xhigh", label: "XHigh", title: "Extra High" },
  { value: "max", label: "Max", title: "Max" },
];

let choices: Choices | null = null;
let unstoredChoices: Partial<Record<AiTask, TaskChoice>> = {};
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

function readChoices(): Partial<Record<AiTask, TaskChoice>> {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === null ? unstoredChoices : JSON.parse(stored) as Partial<Record<AiTask, TaskChoice>>;
  } catch {
    return unstoredChoices;
  }
}

function saveChoices(next: Partial<Record<AiTask, TaskChoice>>) {
  unstoredChoices = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable; the choice then lasts for this session only.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

const baseOf = (task: TaskDefault) => `${task.model}|${task.reasoningEffort}`;
const isLocal = (model: string) => model.startsWith("local/");

/** What the action will run with: the menu's choice while it still applies, else the default. */
function effectiveChoice(task: AiTask, current: Choices) {
  const fallback = current.tasks[task];
  const saved = readChoices()[task];
  return saved && saved.base === baseOf(fallback) && current.pool.includes(saved.model) ? { model: saved.model, reasoningEffort: saved.reasoningEffort } : fallback;
}

/** The `model` and `reasoningEffort` to add to a request, left out where they match the default. */
export function aiTaskRequestOptions(task: AiTask): { model?: string; reasoningEffort?: Effort } {
  if (!choices) return {};
  const fallback = choices.tasks[task];
  const { model, reasoningEffort } = effectiveChoice(task, choices);
  return {
    ...(model !== fallback.model ? { model } : {}),
    ...(reasoningEffort !== fallback.reasoningEffort ? { reasoningEffort } : {}),
  };
}

let loading: Promise<void> | null = null;

/** One request for the pickers of a menu, which all mount at once. */
function loadChoices() {
  loading ??= apiRequest<Choices>("/api/ai-models").then((loaded) => {
    if (!Array.isArray(loaded?.pool) || !loaded.tasks) return;
    choices = loaded;
    notify();
  }).catch(() => undefined).finally(() => { loading = null; });
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY) onChange(); };
  listeners.add(onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function choiceKey(task: AiTask) {
  if (!choices) return "";
  const { model, reasoningEffort } = effectiveChoice(task, choices);
  return `${model}|${reasoningEffort}|${choices.pool.join(",")}`;
}

/** `openai/gpt-6-luna` reads `gpt-6-luna`; a local alias keeps its prefix, which says where it runs. */
function modelLabel(model: string) {
  return isLocal(model) ? model : model.split("/").filter(Boolean).at(-1) ?? model;
}

const POPOVER_WIDTH = 248;

export function AiModelPicker({ task, disabled, className = "" }: { task: AiTask; disabled?: boolean; className?: string }) {
  useSyncExternalStore(subscribe, () => choiceKey(task), () => "");
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // The menu opens anew each time, so a model added in Preferences shows up here.
  useEffect(() => { loadChoices(); }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current?.getBoundingClientRect();
    const height = popoverRef.current?.offsetHeight ?? 0;
    if (!trigger) return;
    const below = trigger.bottom + 4 + height <= window.innerHeight - 8;
    setPosition({
      left: Math.max(8, Math.min(trigger.left, window.innerWidth - POPOVER_WIDTH - 8)),
      top: below ? trigger.bottom + 4 : Math.max(8, trigger.top - height - 4),
    });
  }, [open]);

  // Once placed: until then the popover is hidden, and hidden elements take no focus.
  useEffect(() => {
    if (position) popoverRef.current?.querySelector<HTMLElement>("[aria-checked='true']")?.focus();
  }, [position]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popoverRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    // Capturing: the context menus stop pointer events from leaving them.
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [open]);

  const current = choices;
  const chosen = current ? effectiveChoice(task, current) : null;
  const fallback = current?.tasks[task];
  const overridden = !!chosen && !!fallback && (chosen.model !== fallback.model || chosen.reasoningEffort !== fallback.reasoningEffort);
  const local = !!chosen && isLocal(chosen.model);
  const effortTitle = EFFORTS.find((effort) => effort.value === chosen?.reasoningEffort)?.title;

  function choose(next: Partial<Pick<TaskChoice, "model" | "reasoningEffort">>) {
    if (!current || !chosen) return;
    saveChoices({ ...readChoices(), [task]: { ...chosen, ...next, base: baseOf(current.tasks[task]) } });
  }

  function reset() {
    const next = { ...readChoices() };
    delete next[task];
    saveChoices(next);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Inside the popover these belong to it, not to the context menu around it.
    event.stopPropagation();
    if (event.key === "Escape") {
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const items = Array.from(popoverRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      event.preventDefault();
    }
  }

  return <div className={`min-w-0 ${className}`}>
    <button
      ref={triggerRef}
      type="button"
      className="libera-ai-model-trigger inline-flex h-5 max-w-full items-center gap-0.5 rounded text-[11px] leading-none text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:underline disabled:opacity-50"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={chosen ? `Model for this action: ${chosen.model}${local ? "" : `, ${effortTitle} reasoning`}. Click to change.` : "Model for this action"}
      title={chosen ? `${chosen.model}${local ? "" : ` · ${effortTitle} reasoning`}` : undefined}
      disabled={disabled || !chosen}
      onClick={() => { setPosition(null); setOpen((value) => !value); }}
    >
      <span className="truncate">{chosen ? modelLabel(chosen.model) : "Loading model…"}</span>
      {chosen && !local ? <span className="shrink-0 opacity-70">· {effortTitle}</span> : null}
      {overridden ? <span aria-hidden className="ml-0.5 h-1 w-1 shrink-0 rounded-full bg-primary" /> : null}
      <ChevronDown aria-hidden className="h-3 w-3 shrink-0" />
    </button>
    {open && current && chosen ? <div
      ref={popoverRef}
      role="dialog"
      aria-labelledby={titleId}
      className="fixed z-[60] rounded-lg border border-border bg-card p-1 shadow-lg"
      style={{ left: position?.left ?? 0, top: position?.top ?? 0, width: POPOVER_WIDTH, visibility: position ? "visible" : "hidden" }}
      onKeyDown={keyDown}
    >
      <p id={titleId} className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">Model</p>
      <div role="radiogroup" aria-label="Model" className="max-h-48 overflow-y-auto">
        {current.pool.map((model) => <button
          key={model}
          type="button"
          role="radio"
          aria-checked={model === chosen.model}
          title={model}
          className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-foreground hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
          onClick={() => choose({ model })}
        >
          <Check aria-hidden className={`h-3 w-3 shrink-0 ${model === chosen.model ? "" : "invisible"}`} />
          <span className="min-w-0 flex-1 truncate">{modelLabel(model)}</span>
          {model === fallback?.model ? <span className="shrink-0 text-[10px] text-muted-foreground">Default</span> : null}
        </button>)}
      </div>
      <div className="mt-1 border-t border-border px-2 pb-1.5 pt-1.5">
        <p className="pb-1 text-[11px] font-medium text-muted-foreground">Reasoning effort</p>
        {local
          ? <p className="text-[11px] leading-snug text-muted-foreground">Not sent to local models.</p>
          : <div role="radiogroup" aria-label="Reasoning effort" className="grid grid-cols-5 gap-0.5 rounded-md bg-muted p-0.5">
            {EFFORTS.map((effort) => <button
              key={effort.value}
              type="button"
              role="radio"
              aria-checked={effort.value === chosen.reasoningEffort}
              aria-label={effort.title}
              title={effort.title}
              className={`rounded px-0.5 py-0.5 text-[10.5px] font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${effort.value === chosen.reasoningEffort ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => choose({ reasoningEffort: effort.value })}
            >{effort.label}</button>)}
          </div>}
      </div>
      {overridden || window.liberaPreferences ? <div className="flex items-center justify-between gap-2 border-t border-border px-1 pt-1">
        {overridden ? <button type="button" className="rounded px-1 py-1 text-[11px] text-muted-foreground hover:text-foreground focus-visible:underline focus-visible:outline-none" onClick={reset}>Use default</button> : <span />}
        {window.liberaPreferences ? <button type="button" className="inline-flex items-center gap-1 rounded px-1 py-1 text-[11px] text-muted-foreground hover:text-foreground focus-visible:underline focus-visible:outline-none" onClick={() => { setOpen(false); void window.liberaPreferences?.open("ai"); }}><Settings2 aria-hidden className="h-3 w-3" />Manage models…</button> : null}
      </div> : null}
    </div> : null}
  </div>;
}
