"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { activeCommandScope } from "./command-palette/commands";
import { serializeNativeMenu, type NativeMenuEntry } from "./native-menu";

/**
 * The macOS menu bar's document menus. The focused window describes them here
 * and the main process puts them in its application menu:
 *
 * - File: the active tab's file actions (the "File actions" button beside the
 *   tab strip), registered with `useAppMenuFileActions`.
 * - Format and Insert: the active editor's tools, registered with
 *   `useAppMenuEditor`. The editor is the one in the focused canvas panel.
 * - References: the reference manager's menu (its panel's "More" button),
 *   registered with `useAppMenuReferences`. Hidden while the gallery is open.
 * - Gallery and Photo: the Photo gallery's toolbars, in place of References,
 *   registered with `useAppMenuGallery` and `useAppMenuPhoto`.
 * - View (above its standard items), Tab and AI: app commands, registered
 *   with `useAppMenuItems`. Several components can add to one of these menus;
 *   their groups are shown in priority order, between separators.
 *
 * `window.liberaAppMenu` exists only in the macOS app, so elsewhere (Windows,
 * a browser) these hooks do nothing.
 */
export type AppEditorMenus = { format?: NativeMenuEntry[]; insert?: NativeMenuEntry[] };

type EditorProvider = { element: () => Element | null; read: () => AppEditorMenus };
type SectionProvider = { priority: number; read: () => NativeMenuEntry[] | Promise<NativeMenuEntry[]> };
type Section = "file" | "references" | "gallery" | "photo" | "view" | "tab" | "ai";
/** Menus built from every provider's items; the others show one provider's. */
const MERGED_SECTIONS = new Set<Section>(["view", "tab", "ai"]);

const editorProviders = new Set<EditorProvider>();
const sectionProviders: Record<Section, Set<SectionProvider>> = { file: new Set(), references: new Set(), gallery: new Set(), photo: new Set(), view: new Set(), tab: new Set(), ai: new Set() };
let actions = new Map<string, () => void>();
let lastSent = "";
let generation = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

/** Gives every leaf item without its own callback `run(id)`, for menus written as ids plus a dispatcher. */
export function withMenuActions(items: NativeMenuEntry[], run: (id: string) => void): NativeMenuEntry[] {
  return items.map((item) => {
    if (item.type === "separator") return item;
    if (item.submenu) return { ...item, submenu: withMenuActions(item.submenu, run) };
    return item.onSelect ? item : { ...item, onSelect: () => run(item.id) };
  });
}

/** Insert > Table: a size as Rows > Columns, up to the toolbar grid's 8 × 8. */
export function tableSizeMenu(onPick: (rows: number, columns: number) => void, size = 8): NativeMenuEntry {
  const counts = Array.from({ length: size }, (_, index) => index + 1);
  return {
    id: "table",
    label: "Table",
    submenu: counts.map((rows) => ({
      id: `table-${rows}`,
      label: rows === 1 ? "1 Row" : `${rows} Rows`,
      submenu: counts.map((columns) => ({
        id: `table-${rows}x${columns}`,
        label: columns === 1 ? "1 Column" : `${columns} Columns`,
        onSelect: () => onPick(rows, columns),
      })),
    })),
  };
}

/** The editor the Format and Insert menus act on: the one holding focus, else the focused panel's. */
function activeEditorProvider() {
  const focused = document.activeElement;
  const mounted = [...editorProviders].filter((provider) => provider.element()?.isConnected);
  const holdingFocus = mounted.find((provider) => focused && provider.element()!.contains(focused));
  if (holdingFocus) return holdingFocus;
  const scope = activeCommandScope(focused);
  if (scope) return mounted.find((provider) => scope.contains(provider.element()));
  // A window without canvas panels (a file window) has at most one editor.
  return mounted.length === 1 ? mounted[0] : undefined;
}

async function sync() {
  timer = null;
  const bridge = window.liberaAppMenu;
  if (!bridge) return;
  const current = ++generation;
  const editor = activeEditorProvider();
  const section = async (name: Section): Promise<NativeMenuEntry[]> => {
    const providers = [...sectionProviders[name]];
    if (MERGED_SECTIONS.has(name)) {
      const groups = await Promise.all(providers.sort((left, right) => left.priority - right.priority).map((provider) => provider.read()));
      return groups.filter((group) => group.length).flatMap((group, index) => index ? [{ type: "separator" as const }, ...group] : group);
    }
    // The provider with the highest priority; of equals, the latest mounted.
    const provider = providers.reduce<SectionProvider | undefined>((best, candidate) => !best || candidate.priority >= best.priority ? candidate : best, undefined);
    return provider ? provider.read() : [];
  };
  let fileItems: NativeMenuEntry[] = [];
  let referenceItems: NativeMenuEntry[] = [];
  let galleryItems: NativeMenuEntry[] = [];
  let photoItems: NativeMenuEntry[] = [];
  let viewItems: NativeMenuEntry[] = [];
  let tabItems: NativeMenuEntry[] = [];
  let aiItems: NativeMenuEntry[] = [];
  let editorMenus: AppEditorMenus = {};
  try {
    [fileItems, referenceItems, galleryItems, photoItems, viewItems, tabItems, aiItems, editorMenus] = await Promise.all([
      section("file"), section("references"), section("gallery"), section("photo"), section("view"), section("tab"), section("ai"), editor ? editor.read() : {},
    ]);
  } catch {
    // Keep the menus already shown.
    return;
  }
  if (current !== generation) return;
  const next = new Map<string, () => void>();
  const menus = {
    file: serializeNativeMenu(fileItems, next, "file:"),
    format: serializeNativeMenu(editorMenus.format ?? [], next, "format:"),
    insert: serializeNativeMenu(editorMenus.insert ?? [], next, "insert:"),
    // The gallery is mounted only while it is the active view.
    references: serializeNativeMenu(sectionProviders.gallery.size ? [] : referenceItems, next, "references:"),
    gallery: serializeNativeMenu(galleryItems, next, "gallery:"),
    photo: serializeNativeMenu(photoItems, next, "photo:"),
    view: serializeNativeMenu(viewItems, next, "view:"),
    tab: serializeNativeMenu(tabItems, next, "tab:"),
    ai: serializeNativeMenu(aiItems, next, "ai:"),
  };
  actions = next;
  const json = JSON.stringify(menus);
  if (json === lastSent) return;
  lastSent = json;
  bridge.update(menus);
}

/** Rebuilds the menus soon; cheap to call often, as unchanged menus are not resent. */
function scheduleSync() {
  if (!window.liberaAppMenu || timer) return;
  timer = setTimeout(() => void sync(), 120);
}

function listen() {
  const bridge = window.liberaAppMenu;
  if (listening || !bridge) return;
  listening = true;
  bridge.onSelect((id) => actions.get(id)?.());
  document.addEventListener("focusin", scheduleSync, true);
  window.addEventListener("focus", scheduleSync);
}

function useProvider<T extends object>(set: Set<T>, create: () => T, deps: unknown[]) {
  // Every render may change the items (an editor's state, the active tab).
  useLayoutEffect(() => scheduleSync());
  useEffect(() => {
    if (!window.liberaAppMenu) return;
    listen();
    const provider = create();
    set.add(provider);
    scheduleSync();
    return () => {
      set.delete(provider);
      scheduleSync();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * Offers an editor's Format and Insert menus while it is mounted. `ref` is an
 * element of the editor (its root or toolbar), used to find the editor of the
 * focused panel. `read` is called whenever the menus may have changed.
 */
export function useAppMenuEditor(ref: RefObject<HTMLElement | null>, read: () => AppEditorMenus) {
  const latest = useRef(read);
  useLayoutEffect(() => {
    latest.current = read;
  });
  useProvider(editorProviders, () => ({ element: () => ref.current, read: () => latest.current() }), [ref]);
}

function useSection(section: Section, priority: number, read: () => NativeMenuEntry[] | Promise<NativeMenuEntry[]>) {
  const latest = useRef(read);
  useLayoutEffect(() => {
    latest.current = read;
  });
  useProvider(sectionProviders[section], () => ({ priority, read: () => latest.current() }), [section, priority]);
}

/** Offers the active tab's file actions to the File menu while mounted. */
export function useAppMenuFileActions(read: () => NativeMenuEntry[] | Promise<NativeMenuEntry[]>) {
  useSection("file", 0, read);
}

/**
 * Offers the References menu while mounted. The References panel offers its
 * live menu ("panel"); while it is closed, the app offers one that opens the
 * panel to run each item ("fallback").
 */
export function useAppMenuReferences(source: "panel" | "fallback", read: () => NativeMenuEntry[]) {
  useSection("references", source === "panel" ? 1 : 0, read);
}

/** Offers the Gallery menu while mounted, and takes the References menu off the menu bar. */
export function useAppMenuGallery(read: () => NativeMenuEntry[]) {
  useSection("gallery", 0, read);
}

/**
 * Offers the Photo menu while mounted: the grid's selection actions
 * ("selection"), or the open photo's ("viewer"), which take their place.
 */
export function useAppMenuPhoto(source: "selection" | "viewer", read: () => NativeMenuEntry[]) {
  useSection("photo", source === "viewer" ? 1 : 0, read);
}

/**
 * Adds a group of items to the View, Tab or AI menu while mounted. Groups
 * with a lower `priority` come first.
 */
export function useAppMenuItems(section: "view" | "tab" | "ai", priority: number, read: () => NativeMenuEntry[]) {
  useSection(section, priority, read);
}
