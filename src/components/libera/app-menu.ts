"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { activeCommandScope } from "./command-palette/commands";
import { serializeNativeMenu, type NativeMenuEntry } from "./native-menu";

/**
 * The macOS menu bar's document menus. The focused window describes them here
 * and the main process puts them in its application menu:
 *
 * - File: the active tab's file actions (the "File actions" button beside the
 *   tab strip), registered with `useAppMenuFileActions`, then app commands
 *   (such as Migration…), registered with `useAppMenuItems("file", …)`.
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
type Section = "file" | "fileApp" | "references" | "gallery" | "photo" | "view" | "tab" | "ai";
/** Menus built from every provider's items; the others show one provider's. */
const MERGED_SECTIONS = new Set<Section>(["fileApp", "view", "tab", "ai"]);

const editorProviders = new Set<EditorProvider>();
const sectionProviders: Record<Section, Set<SectionProvider>> = { file: new Set(), fileApp: new Set(), references: new Set(), gallery: new Set(), photo: new Set(), view: new Set(), tab: new Set(), ai: new Set() };
let actions = new Map<string, () => void>();
let lastSent = "";
let generation = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
// Renders only mark the menus possibly changed: when the first unsynced render
// happened, and the debounce waiting to act on it.
let dirtySince = 0;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let idleHandle: number | null = null;
const RENDER_DEBOUNCE_MS = 300;
const RENDER_MAX_WAIT_MS = 2000;
let listening = false;

// A render invalidates only the menus its provider shows; a sync rebuilds just
// those and reuses the serialized output and action ids of the rest.
type Dirty = Section | "editor";
type MenuName = "file" | "format" | "insert" | "references" | "gallery" | "photo" | "view" | "tab" | "ai";
const MENU_NAMES: MenuName[] = ["file", "format", "insert", "references", "gallery", "photo", "view", "tab", "ai"];
const ALL_DIRTY: Dirty[] = ["file", "fileApp", "references", "gallery", "photo", "view", "tab", "ai", "editor"];
/** The menus rebuilt when a provider's items change. The References menu also depends on whether the gallery is mounted. */
const MENUS_OF: Record<Dirty, MenuName[]> = {
  file: ["file"], fileApp: ["file"], references: ["references"], gallery: ["gallery", "references"], photo: ["photo"],
  view: ["view"], tab: ["tab"], ai: ["ai"], editor: ["format", "insert"],
};
const dirty = new Set<Dirty>();
// What a sync that has not finished (or was superseded) took, so a newer sync redoes it.
let inflight = new Set<Dirty>();
const built = new Map<MenuName, { entries: ReturnType<typeof serializeNativeMenu>; json: string; actions: Map<string, () => void> }>();

/** Gives every leaf item without its own callback `run(id)`, for menus written as ids plus a dispatcher. */
export function withMenuActions(items: NativeMenuEntry[], run: (id: string) => void): NativeMenuEntry[] {
  return items.map((item) => {
    if (item.type === "separator") return item;
    if (item.submenu) return { ...item, submenu: withMenuActions(item.submenu, run) };
    return item.onSelect ? item : { ...item, onSelect: () => run(item.id) };
  });
}

/** Insert > Table: a size as Rows > Columns, up to the toolbar grid's 8 × 8. */
export function tableSizeMenu(onPick: (rows: number, columns: number) => void, t: (key: "table" | "rows" | "columns", values?: { count: number }) => string, size = 8): NativeMenuEntry {
  const counts = Array.from({ length: size }, (_, index) => index + 1);
  return {
    id: "table",
    label: t("table"),
    submenu: counts.map((rows) => ({
      id: `table-${rows}`,
      label: t("rows", { count: rows }),
      submenu: counts.map((columns) => ({
        id: `table-${rows}x${columns}`,
        label: t("columns", { count: columns }),
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
  dirtySince = 0;
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
  if (idleHandle !== null) { window.cancelIdleCallback?.(idleHandle); idleHandle = null; }
  const bridge = window.liberaAppMenu;
  if (!bridge) return;
  const current = ++generation;
  const taken = new Set<Dirty>([...dirty, ...inflight]);
  dirty.clear();
  inflight = taken;
  const stale = new Set<MenuName>(MENU_NAMES.filter((name) => !built.has(name)));
  for (const key of taken) for (const name of MENUS_OF[key]) stale.add(name);
  const editor = stale.has("format") || stale.has("insert") ? activeEditorProvider() : undefined;
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
  const none = async (): Promise<NativeMenuEntry[]> => [];
  const items: Partial<Record<MenuName, NativeMenuEntry[]>> = {};
  try {
    const [fileItems, fileAppItems, referenceItems, galleryItems, photoItems, viewItems, tabItems, aiItems, editorMenus] = await Promise.all([
      stale.has("file") ? section("file") : none(), stale.has("file") ? section("fileApp") : none(),
      stale.has("references") ? section("references") : none(), stale.has("gallery") ? section("gallery") : none(),
      stale.has("photo") ? section("photo") : none(), stale.has("view") ? section("view") : none(),
      stale.has("tab") ? section("tab") : none(), stale.has("ai") ? section("ai") : none(),
      editor ? editor.read() : ({} as AppEditorMenus),
    ]);
    // The active tab's file actions, then the app's File commands.
    items.file = fileItems.length && fileAppItems.length ? [...fileItems, { type: "separator" }, ...fileAppItems] : [...fileItems, ...fileAppItems];
    // The gallery is mounted only while it is the active view.
    items.references = sectionProviders.gallery.size ? [] : referenceItems;
    items.gallery = galleryItems;
    items.photo = photoItems;
    items.view = viewItems;
    items.tab = tabItems;
    items.ai = aiItems;
    items.format = editorMenus.format ?? [];
    items.insert = editorMenus.insert ?? [];
  } catch {
    // Keep the menus already shown, and rebuild them on the next sync.
    for (const key of taken) dirty.add(key);
    return;
  }
  if (current !== generation) return;
  inflight = new Set();
  for (const name of stale) {
    const menuActions = new Map<string, () => void>();
    const entries = serializeNativeMenu(items[name] ?? [], menuActions, `${name}:`);
    built.set(name, { entries, json: JSON.stringify(entries), actions: menuActions });
  }
  const next = new Map<string, () => void>();
  for (const name of MENU_NAMES) for (const [id, run] of built.get(name)!.actions) next.set(id, run);
  actions = next;
  const json = MENU_NAMES.map((name) => built.get(name)!.json).join("|");
  if (json === lastSent) return;
  lastSent = json;
  bridge.update(Object.fromEntries(MENU_NAMES.map((name) => [name, built.get(name)!.entries])) as Parameters<typeof bridge.update>[0]);
}

/** Rebuilds the menus soon; cheap to call often, as unchanged menus are not resent. */
function scheduleSync(keys: readonly Dirty[] = ALL_DIRTY) {
  if (!window.liberaAppMenu) return;
  for (const key of keys) dirty.add(key);
  if (timer) return;
  timer = setTimeout(() => void sync(), 120);
}

/**
 * A render of a component providing items may have changed them. Rebuilding and
 * stringifying every menu per render is wasteful, so wait for the renders to
 * settle (trailing debounce, bounded by a maximum wait), then rebuild when the
 * browser is idle. A window that is hidden or unfocused rebuilds when it regains
 * focus instead, so nothing is lost.
 */
function markMenusDirty(key: Dirty) {
  if (!window.liberaAppMenu) return;
  dirty.add(key);
  const now = Date.now();
  if (!dirtySince) dirtySince = now;
  // A prompt sync is already pending and will read these items too.
  if (timer) return;
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(syncWhenIdle, Math.max(0, Math.min(RENDER_DEBOUNCE_MS, dirtySince + RENDER_MAX_WAIT_MS - now)));
}

function syncWhenIdle() {
  renderTimer = null;
  if (document.hidden || !document.hasFocus()) return;
  const run = () => { idleHandle = null; void sync(); };
  if (typeof window.requestIdleCallback === "function") idleHandle = window.requestIdleCallback(run, { timeout: 1000 });
  else run();
}

function listen() {
  const bridge = window.liberaAppMenu;
  if (listening || !bridge) return;
  listening = true;
  bridge.onSelect((id) => actions.get(id)?.());
  document.addEventListener("focusin", () => scheduleSync(), true);
  window.addEventListener("focus", () => scheduleSync());
}

function useProvider<T extends object>(key: Dirty, set: Set<T>, create: () => T, deps: unknown[]) {
  // Every render may change the items (an editor's state, the active tab), but
  // only the ones this provider shows.
  useLayoutEffect(() => markMenusDirty(key));
  useEffect(() => {
    if (!window.liberaAppMenu) return;
    listen();
    const provider = create();
    set.add(provider);
    scheduleSync([key]);
    return () => {
      set.delete(provider);
      scheduleSync([key]);
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
  useProvider("editor", editorProviders, () => ({ element: () => ref.current, read: () => latest.current() }), [ref]);
}

function useSection(section: Section, priority: number, read: () => NativeMenuEntry[] | Promise<NativeMenuEntry[]>) {
  const latest = useRef(read);
  useLayoutEffect(() => {
    latest.current = read;
  });
  useProvider(section, sectionProviders[section], () => ({ priority, read: () => latest.current() }), [section, priority]);
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
 * Adds a group of items to the File (after the active tab's file actions),
 * View, Tab or AI menu while mounted. Groups with a lower `priority` come first.
 */
export function useAppMenuItems(section: "file" | "view" | "tab" | "ai", priority: number, read: () => NativeMenuEntry[]) {
  useSection(section === "file" ? "fileApp" : section, priority, read);
}
