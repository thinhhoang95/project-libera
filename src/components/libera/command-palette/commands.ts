"use client";

import { useEffect, useLayoutEffect, useRef, type ComponentType, type RefObject } from "react";

/**
 * The command palette's shared API. Editors and viewers offer commands in two ways:
 *
 * - Toolbars are read from the page. Any `role="toolbar"` or `data-command-toolbar`
 *   element inside the active command scope lists its buttons, tabs and select
 *   options, so a new toolbar button shows up in the palette without extra code.
 * - Commands without a button (a colour inside a menu, an app action) are
 *   registered with `usePaletteCommands`.
 *
 * The active scope is the topmost visible `data-command-scope` element: the
 * focused canvas pane (1), the gallery or Search page covering the canvas (2),
 * or a full-screen photo (3). Higher numbers sit above lower ones.
 */
export type PaletteCommand = {
  id: string;
  title: string;
  /** Where the command comes from, e.g. the toolbar's name. */
  group?: string;
  /** A longer description, searched and shown beside the title. */
  detail?: string;
  /** Extra words to match, e.g. synonyms. */
  keywords?: string;
  shortcut?: string;
  icon?: ComponentType<{ className?: string }>;
  /** An icon copied from the toolbar button. */
  iconElement?: Element;
  /** A toggle's state, or the chosen option of a select. */
  checked?: boolean;
  disabled?: boolean;
  run: () => void;
};

export type PaletteMode = "files" | "commands";

type CommandProvider = {
  /** The element the commands belong to; null for commands available everywhere. */
  element: () => Element | null;
  global: boolean;
  commands: () => PaletteCommand[];
};

const providers = new Set<CommandProvider>();

export const OPEN_COMMAND_PALETTE_EVENT = "libera:open-command-palette";

/** Opens the palette from code, e.g. a menu item. */
export function openCommandPalette(mode: PaletteMode) {
  window.dispatchEvent(new CustomEvent<PaletteMode>(OPEN_COMMAND_PALETTE_EVENT, { detail: mode }));
}

/**
 * Offers commands while the component is mounted. With a ref they are listed
 * only while that element is in the active scope (its pane is focused);
 * without one (`null`) they are listed everywhere.
 */
export function usePaletteCommands(ref: RefObject<HTMLElement | null> | null, getCommands: () => PaletteCommand[]) {
  const latest = useRef(getCommands);
  useLayoutEffect(() => {
    latest.current = getCommands;
  });
  useEffect(() => {
    const provider: CommandProvider = {
      element: () => ref?.current ?? null,
      global: !ref,
      commands: () => latest.current(),
    };
    providers.add(provider);
    return () => {
      providers.delete(provider);
    };
  }, [ref]);
}

const SCOPE_SELECTOR = "[data-command-scope]";
const TOOLBAR_SELECTOR = '[role="toolbar"], [data-command-toolbar]';
const CONTROL_SELECTOR = 'button, select, [role="tab"]';

function shown(element: Element) {
  return element.getClientRects().length > 0 && !element.closest('[inert], [aria-hidden="true"]');
}

/** The scope commands are read from: the topmost one, preferring the one holding focus. */
export function activeCommandScope(focused: Element | null): HTMLElement | null {
  const scopes = [...document.querySelectorAll<HTMLElement>(SCOPE_SELECTOR)].filter(shown);
  const layer = (scope: HTMLElement) => Number(scope.dataset.commandScope) || 0;
  scopes.sort((left, right) =>
    layer(right) - layer(left)
    || Number(Boolean(focused && right.contains(focused))) - Number(Boolean(focused && left.contains(focused))),
  );
  return scopes[0] ?? null;
}

/** "Bold (Ctrl/Cmd+B)" → the key hint, when the parentheses hold one. */
function splitShortcut(text: string): { text: string; shortcut?: string } {
  const match = /^(.*?)\s*\(([^()]{1,24})\)\s*$/.exec(text);
  if (!match) return { text };
  const hint = match[2].trim();
  const looksLikeKeys = /^\S{1,5}$/.test(hint) || /^[\w⌘⌥⇧/]+(?:\+[^\s+]+)+$/.test(hint);
  return looksLikeKeys ? { text: match[1], shortcut: hint } : { text };
}

function controlLabel(control: HTMLElement) {
  return (control.getAttribute("aria-label") || control.textContent || control.getAttribute("title") || "").replace(/\s+/g, " ").trim();
}

/** Sets a select's value the way a person would, so React's onChange runs. */
function chooseOption(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * A control kept offstage (in a `data-command-reveal` toolbar) is brought on
 * screen first, by clicking the scope's `data-command-reveal-button`, so menus
 * it opens are placed under the real button.
 */
async function clickRevealed(scope: HTMLElement, label: string) {
  scope.querySelector<HTMLElement>("[data-command-reveal-button]")?.click();
  await nextFrame();
  const control = [...scope.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)]
    .find((candidate) => shown(candidate) && controlLabel(candidate) === label);
  control?.click();
}

function toolbarCommands(scope: HTMLElement): PaletteCommand[] {
  const commands: PaletteCommand[] = [];
  const seen = new Set<string>();

  for (const toolbar of scope.querySelectorAll<HTMLElement>(TOOLBAR_SELECTOR)) {
    if (toolbar.closest(SCOPE_SELECTOR) !== scope) continue;
    const offstage = toolbar.hasAttribute("data-command-reveal");
    if (!offstage && !shown(toolbar)) continue;
    const group = toolbar.dataset.commandToolbar || toolbar.getAttribute("aria-label") || "Toolbar";

    for (const control of toolbar.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)) {
      if (control.closest(TOOLBAR_SELECTOR) !== toolbar || control.closest("[data-command-skip]")) continue;
      if (!offstage && !shown(control)) continue;
      const label = controlLabel(control);
      if (!label) continue;

      if (control instanceof HTMLSelectElement) {
        for (const option of control.options) {
          if (option.disabled || !option.text.trim()) continue;
          const title = `${label}: ${option.text.trim()}`;
          if (seen.has(`${group}\n${title}`)) continue;
          seen.add(`${group}\n${title}`);
          commands.push({
            id: `${group}\n${title}`,
            title,
            group,
            checked: control.value === option.value,
            disabled: control.disabled,
            run: () => chooseOption(control, option.value),
          });
        }
        continue;
      }

      const tooltip = splitShortcut(control.getAttribute("title") ?? "");
      const title = splitShortcut(label).text;
      if (seen.has(`${group}\n${title}`)) continue;
      seen.add(`${group}\n${title}`);
      const pressed = control.getAttribute("aria-pressed") ?? control.getAttribute("aria-selected");
      commands.push({
        id: `${group}\n${title}`,
        title,
        group,
        detail: tooltip.text && tooltip.text.toLowerCase() !== title.toLowerCase() ? tooltip.text : undefined,
        shortcut: tooltip.shortcut ?? splitShortcut(label).shortcut,
        iconElement: control.querySelector("svg") ?? undefined,
        checked: pressed === null ? undefined : pressed === "true",
        disabled: (control as HTMLButtonElement).disabled || control.getAttribute("aria-disabled") === "true",
        run: () => {
          if (offstage) void clickRevealed(scope, label);
          else control.click();
        },
      });
    }
  }

  return commands;
}

/** Every command available right now: the scope's own first, then the ones offered everywhere. */
export function collectPaletteCommands(focused: Element | null): PaletteCommand[] {
  const scope = activeCommandScope(focused);
  const scoped: PaletteCommand[] = [];
  const general: PaletteCommand[] = [];

  for (const provider of providers) {
    if (provider.global) {
      general.push(...provider.commands());
      continue;
    }
    const element = provider.element();
    if (scope && element && scope.contains(element) && element.closest(SCOPE_SELECTOR) === scope) scoped.push(...provider.commands());
  }

  // A registered command replaces the toolbar's own entry with the same name.
  const registered = new Set(scoped.map((command) => command.title.toLowerCase()));
  const harvested = scope ? toolbarCommands(scope).filter((command) => !registered.has(command.title.toLowerCase())) : [];
  return [...harvested, ...scoped, ...general];
}
