import { ChartColumnStacked, type LucideIcon } from "lucide-react";
import type { OpenTab } from "@/components/libera/types";

/**
 * App pages, such as Spending, open in a tab of their own beside notebook
 * files, like a photo or a PDF. They are not files: the tab id and path use a
 * reserved prefix, the file type is "page", and the `page` marker is what code
 * checks before treating a tab as a file on disk.
 *
 * A page can bring a contextual rail tab: a left-panel tab that appears in the
 * rail only while the page's tab is the active one, like Word's Table tab
 * appears in the ribbon only while a table is selected. The rail tab holds the
 * page's controls; the page itself holds what they control.
 */
export const PAGE_TAB_PREFIX = "page:";

export type PageKind = "spending";

export type PageDefinition = {
  kind: PageKind;
  title: string;
  icon: LucideIcon;
  /** The left-panel tab shown in the rail while this page is active. */
  railTab?: { id: ContextualPanelTab; label: string; icon: LucideIcon };
};

/** Left-panel tabs that belong to a page and appear only while it is active. */
export type ContextualPanelTab = "spending";

export const PAGES: Record<PageKind, PageDefinition> = {
  spending: {
    kind: "spending",
    title: "Spending",
    icon: ChartColumnStacked,
    railTab: { id: "spending", label: "Spending", icon: ChartColumnStacked },
  },
};

export type PageOpenTab = OpenTab & { page: { kind: PageKind } };

export function isPageKind(value: unknown): value is PageKind {
  return typeof value === "string" && Object.hasOwn(PAGES, value);
}

export function pageTabId(kind: PageKind) {
  return `${PAGE_TAB_PREFIX}${kind}`;
}

export function isPageTab(tab: OpenTab | null | undefined): tab is PageOpenTab {
  return Boolean(tab?.page);
}

export function createPageTab(kind: PageKind): PageOpenTab {
  const id = pageTabId(kind);
  const now = new Date().toISOString();
  return {
    id,
    page: { kind },
    file: { kind: "file", name: PAGES[kind].title, path: id, notebook: "", fileType: "page", createdAt: now, updatedAt: now, size: 0 },
    draft: "",
    saved: "",
    status: "clean",
  };
}

/** The contextual rail tabs the active tab brings, if any. */
export function contextualPanelTabs(activeTab: OpenTab | null | undefined) {
  const railTab = isPageTab(activeTab) ? PAGES[activeTab.page.kind]?.railTab : undefined;
  return railTab ? [railTab] : [];
}

export function isContextualPanelTab(panel: string): panel is ContextualPanelTab {
  return Object.values(PAGES).some((page) => page.railTab?.id === panel);
}

/** Asks the workspace to open an app page, from a menu, the palette or Preferences. */
export const OPEN_PAGE_EVENT = "libera:open-page";

export function requestOpenPage(kind: PageKind) {
  window.dispatchEvent(new CustomEvent<PageKind>(OPEN_PAGE_EVENT, { detail: kind }));
}
