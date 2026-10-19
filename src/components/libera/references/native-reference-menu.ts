type NativeMenuItem = Parameters<NonNullable<Window["liberaMenu"]>["popup"]>[0]["items"][number];
export type ReferenceMenuItem =
  | { type: "separator" }
  | { id: string; label: string; enabled?: boolean; type?: "normal" | "radio" | "checkbox"; checked?: boolean; submenu?: ReferenceMenuItem[]; onSelect?: () => void };

/** Keep callbacks in the renderer; send only serializable menu data through IPC. */
export async function popupReferenceMenu(items: ReferenceMenuItem[], point: { x: number; y: number }): Promise<boolean> {
  const menu = window.liberaMenu;
  if (!menu) return false;
  const actions = new Map<string, () => void>();
  function serialize(items: ReferenceMenuItem[], parentEnabled = true): NativeMenuItem[] {
    return items.map((item) => {
      if (item.type === "separator") return item;
      const { onSelect, submenu, ...data } = item;
      const enabled = parentEnabled && item.enabled !== false;
      if (onSelect && enabled) actions.set(item.id, onSelect);
      return { ...data, ...(submenu ? { submenu: serialize(submenu, enabled) } : {}) };
    });
  }
  let selected: string | null;
  try {
    selected = await menu.popup({ items: serialize(items), x: Math.round(point.x), y: Math.round(point.y) });
  } catch {
    return false;
  }
  if (selected) actions.get(selected)?.();
  return true;
}
