import type { PaletteCommand } from "./command-palette/commands";

type NativeMenuItem = Parameters<NonNullable<Window["liberaMenu"]>["popup"]>[0]["items"][number];
export type NativeMenuEntry =
  | { type: "separator" }
  | { id: string; label: string; enabled?: boolean; type?: "normal" | "radio" | "checkbox"; checked?: boolean; submenu?: NativeMenuEntry[]; onSelect?: () => void };

/**
 * The menu's data for IPC. Each enabled item's callback goes into `actions`
 * under its id, prefixed with `prefix` (so several menus can share one map).
 */
export function serializeNativeMenu(items: NativeMenuEntry[], actions: Map<string, () => void>, prefix = "", parentEnabled = true): NativeMenuItem[] {
  return items.map((item) => {
    if (item.type === "separator") return item;
    const { onSelect, submenu, ...data } = item;
    const id = `${prefix}${item.id}`;
    const enabled = parentEnabled && item.enabled !== false;
    if (onSelect && enabled) actions.set(id, onSelect);
    return { ...data, id, ...(submenu ? { submenu: serializeNativeMenu(submenu, actions, prefix, enabled) } : {}) };
  });
}

/** The same items, none of which can be chosen (a dialog is open over the toolbar they stand for). */
export function disabledMenu(items: NativeMenuEntry[]): NativeMenuEntry[] {
  return items.map((item) => (item.type === "separator" ? item : { ...item, enabled: false }));
}

/** Palette commands as menu items, for commands written once for the palette. */
export function commandMenuItems(commands: PaletteCommand[], label: (title: string) => string = (title) => title): NativeMenuEntry[] {
  return commands.map((command) => ({
    id: command.id,
    label: label(command.title),
    enabled: !command.disabled,
    ...(command.checked === undefined ? {} : { type: "checkbox" as const, checked: command.checked }),
    onSelect: command.run,
  }));
}

/** A menu's items as palette commands, for a submenu's choices, which have no toolbar button to read. */
export function menuCommands(items: NativeMenuEntry[], base: Pick<PaletteCommand, "group" | "icon" | "keywords">, title: (label: string) => string = (label) => label): PaletteCommand[] {
  return items.flatMap((item) => {
    if (item.type === "separator") return [];
    if (item.submenu) return menuCommands(item.submenu, base, title);
    const run = item.onSelect;
    return run ? [{ ...base, id: item.id, title: title(item.label), disabled: item.enabled === false, run }] : [];
  });
}

/** Keep callbacks in the renderer; send only serializable menu data through IPC. */
export async function popupNativeMenu(items: NativeMenuEntry[], point: { x: number; y: number }): Promise<boolean> {
  const menu = window.liberaMenu;
  if (!menu) return false;
  const actions = new Map<string, () => void>();
  let selected: string | null;
  try {
    selected = await menu.popup({ items: serializeNativeMenu(items, actions), x: Math.round(point.x), y: Math.round(point.y) });
  } catch {
    return false;
  }
  if (selected) actions.get(selected)?.();
  return true;
}

/** Where a menu opened from a toolbar button goes: under its left edge. */
export function nativeMenuPointBelow(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}
