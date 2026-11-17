// Widths of the notebook sidebar and the docked chat panel while their handles
// are dragged. Pure, so the drag can measure the layout once and compute each
// pointer position without touching React.

export const DEFAULT_SIDEBAR_WIDTH = 320;
export const MIN_SIDEBAR_WIDTH = 240;
export const MAX_SIDEBAR_WIDTH = 560;
export const MIN_WORKSPACE_WIDTH = 480;
export const MIN_CHAT_WIDTH = 280;
export const MAX_CHAT_WIDTH = 560;
/** Room the workspace keeps between the sidebar and the chat panel. */
const MIN_CHAT_WORKSPACE_WIDTH = 320;
/** The sidebar's width when the notebooks are collapsed. */
export const COLLAPSED_SIDEBAR_WIDTH = 48;

/** The layout's box in viewport coordinates, read once when a drag starts. */
export type LayoutBox = { left: number; right: number; width: number };

export function clampSidebarWidth(width: number, layoutWidth?: number) {
  const maximumWidth = layoutWidth
    ? Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(MAX_SIDEBAR_WIDTH, layoutWidth - MIN_WORKSPACE_WIDTH),
      )
    : MAX_SIDEBAR_WIDTH;

  return Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(maximumWidth, width)));
}

/** `dockedChatWidth` is the chat panel's width when it is docked, else 0. */
export function sidebarWidthFromPointer(clientX: number, layout: LayoutBox | null, dockedChatWidth: number) {
  return clampSidebarWidth(
    clientX - (layout?.left ?? 0),
    layout ? layout.width - dockedChatWidth : undefined,
  );
}

/** `sidebarWidth` is the sidebar's current width; `fallbackWidth` is the chat's, for a layout that could not be measured. */
export function chatWidthFromPointer(clientX: number, layout: LayoutBox | null, sidebarWidth: number, fallbackWidth: number) {
  const available = (layout?.width ?? 1200) - sidebarWidth - MIN_CHAT_WORKSPACE_WIDTH;
  return Math.round(Math.max(MIN_CHAT_WIDTH, Math.min(MAX_CHAT_WIDTH, available, (layout?.right ?? clientX + fallbackWidth) - clientX)));
}
