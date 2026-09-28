"use client";

import { memo, useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { Columns2, Rows2, X } from "lucide-react";
import {
  computeCanvasGeometry,
  resizeCanvasSplit,
  type CanvasDropZone,
  type CanvasLayout,
  type CanvasPaneNode,
  type CanvasRect,
  type CanvasSplitNode,
  TAB_DRAG_MIME,
} from "@/lib/canvas-layout";
import { CanvasPaneFocusContext } from "./canvas-pane-context";
import { FileTypeIcon } from "./file-type";
import type { OpenTab } from "./types";

const EDGE_ZONE = 0.28;
const KEYBOARD_RESIZE_STEP = 0.02;

type SplitZone = Exclude<CanvasDropZone, "center">;

type CanvasSplitViewProps = {
  layout: CanvasLayout;
  tabs: OpenTab[];
  renderPane: (pane: CanvasPaneNode, focused: boolean) => ReactNode;
  onFocusPane: (paneId: string) => void;
  onSplitPane: (paneId: string, zone: SplitZone) => void;
  onClosePane: (paneId: string) => void;
  onPlaceTab: (paneId: string, tabId: string) => void;
  onDropTab: (paneId: string, tabId: string, zone: CanvasDropZone) => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
};

type ResizeDrag = { split: CanvasSplitNode; rect: CanvasRect; ratio: number };
type DropTarget = { paneId: string; zone: CanvasDropZone };

const percent = (value: number) => `${value * 100}%`;

function rectStyle(rect: CanvasRect): CSSProperties {
  return { left: percent(rect.x), top: percent(rect.y), width: percent(rect.width), height: percent(rect.height) };
}

function hasTabDrag(event: ReactDragEvent) {
  return Array.from(event.dataTransfer.types).includes(TAB_DRAG_MIME);
}

function dropZoneAt(event: ReactDragEvent<HTMLElement>): CanvasDropZone {
  const bounds = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - bounds.left) / Math.max(1, bounds.width);
  const y = (event.clientY - bounds.top) / Math.max(1, bounds.height);
  const edges: [SplitZone, number][] = [["left", x], ["right", 1 - x], ["top", y], ["bottom", 1 - y]];
  const [zone, distance] = edges.reduce((closest, edge) => (edge[1] < closest[1] ? edge : closest));
  return distance < EDGE_ZONE ? zone : "center";
}

const DROP_ZONE_LABEL: Record<CanvasDropZone, string> = {
  center: "Show here",
  left: "Split left",
  right: "Split right",
  top: "Split up",
  bottom: "Split down",
};

// Memoised so resizing a split or hovering a drop zone re-lays out the panes
// without re-rendering the editors and viewers inside them.
const PaneContent = memo(function PaneContent({
  pane,
  focused,
  renderPane,
}: {
  pane: CanvasPaneNode;
  focused: boolean;
  renderPane: CanvasSplitViewProps["renderPane"];
}) {
  return (
    <CanvasPaneFocusContext.Provider value={focused}>
      {renderPane(pane, focused)}
    </CanvasPaneFocusContext.Provider>
  );
});

export function CanvasSplitView({
  layout,
  tabs,
  renderPane,
  onFocusPane,
  onSplitPane,
  onClosePane,
  onPlaceTab,
  onDropTab,
  onResizeSplit,
}: CanvasSplitViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [resizeDrag, setResizeDrag] = useState<ResizeDrag | null>(null);
  const [tabDragActive, setTabDragActive] = useState(false);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const shownLayout = resizeDrag ? resizeCanvasSplit(layout, resizeDrag.split.id, resizeDrag.ratio) : layout;
  const { panes, handles } = computeCanvasGeometry(shownLayout.root);
  const split = panes.length > 1;
  const visibleTabIds = new Set(panes.map(({ pane }) => pane.tabId).filter(Boolean));
  const hiddenTabs = tabs.filter((tab) => !visibleTabIds.has(tab.id));

  useEffect(() => {
    if (!tabDragActive) return;
    const clear = () => {
      setTabDragActive(false);
      setDropTarget(null);
    };
    // Bubble phase: a pane's own drop handler must run before the layer unmounts.
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, [tabDragActive]);

  useEffect(() => {
    if (!resizeDrag) return;
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = resizeDrag.split.direction === "row" ? "col-resize" : "row-resize";
    return () => {
      document.body.style.cursor = previousCursor;
    };
  }, [resizeDrag]);

  function ratioFromPointer(drag: ResizeDrag, clientX: number, clientY: number) {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return drag.ratio;
    return drag.split.direction === "row"
      ? ((clientX - bounds.left) / Math.max(1, bounds.width) - drag.rect.x) / Math.max(0.0001, drag.rect.width)
      : ((clientY - bounds.top) / Math.max(1, bounds.height) - drag.rect.y) / Math.max(0.0001, drag.rect.height);
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>, splitNode: CanvasSplitNode, rect: CanvasRect) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizeDrag({ split: splitNode, rect, ratio: splitNode.ratio });
  }

  function moveResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!resizeDrag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const ratio = ratioFromPointer(resizeDrag, event.clientX, event.clientY);
    setResizeDrag((current) => (current ? { ...current, ratio } : current));
  }

  function finishResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!resizeDrag) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onResizeSplit(resizeDrag.split.id, ratioFromPointer(resizeDrag, event.clientX, event.clientY));
    setResizeDrag(null);
  }

  function resizeWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>, splitNode: CanvasSplitNode) {
    const back = splitNode.direction === "row" ? "ArrowLeft" : "ArrowUp";
    const forward = splitNode.direction === "row" ? "ArrowRight" : "ArrowDown";
    if (event.key === back || event.key === forward) {
      event.preventDefault();
      onResizeSplit(splitNode.id, splitNode.ratio + (event.key === forward ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP));
    } else if (event.key === "Home" || event.key === "Enter") {
      event.preventDefault();
      onResizeSplit(splitNode.id, 0.5);
    }
  }

  function handlePaneDragOver(event: ReactDragEvent<HTMLDivElement>, paneId: string) {
    if (!hasTabDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const zone = dropZoneAt(event);
    setDropTarget((current) => (current?.paneId === paneId && current.zone === zone ? current : { paneId, zone }));
  }

  function handlePaneDrop(event: ReactDragEvent<HTMLDivElement>, paneId: string) {
    if (!hasTabDrag(event)) return;
    event.preventDefault();
    const tabId = event.dataTransfer.getData(TAB_DRAG_MIME);
    const zone = dropZoneAt(event);
    setTabDragActive(false);
    setDropTarget(null);
    if (tabId) onDropTab(paneId, tabId, zone);
  }

  return (
    <div
      ref={containerRef}
      className="libera-canvas relative min-h-0 flex-1 overflow-hidden"
      data-split={split ? "true" : undefined}
      data-resizing={resizeDrag ? "true" : undefined}
      onDragEnter={(event) => {
        if (hasTabDrag(event)) setTabDragActive(true);
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
          setTabDragActive(false);
          setDropTarget(null);
        }
      }}
    >
      {panes.map(({ pane, rect }) => {
        const focused = pane.id === shownLayout.focusedPaneId;
        const tab = tabs.find((currentTab) => currentTab.id === pane.tabId);
        const target = dropTarget?.paneId === pane.id ? dropTarget.zone : null;

        return (
          <section
            key={pane.id}
            aria-label={split ? `Panel: ${tab?.file.name ?? "Empty"}` : undefined}
            className="libera-canvas-pane absolute flex min-h-0 min-w-0 flex-col overflow-hidden"
            data-canvas-pane-focused={focused ? "true" : "false"}
            style={rectStyle(rect)}
            onPointerDownCapture={() => onFocusPane(pane.id)}
            onFocusCapture={() => onFocusPane(pane.id)}
          >
            {split ? (
              <header
                className="libera-canvas-pane-header flex h-8 shrink-0 items-center gap-2 border-b border-border pl-3 pr-1 text-xs"
                draggable={Boolean(tab)}
                title={tab ? "Drag to move this panel" : undefined}
                onDragStart={(event) => {
                  if (!tab) return;
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData(TAB_DRAG_MIME, tab.id);
                }}
              >
                {tab ? (
                  <>
                    <span aria-hidden className="libera-tab-file-icon" data-type={tab.file.fileType}>
                      <FileTypeIcon fileType={tab.file.fileType} />
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">{tab.file.name}</span>
                    {tab.status === "dirty" ? (
                      <span aria-label="Unsaved" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" />
                    ) : null}
                  </>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">Empty panel</span>
                )}
                <span className="libera-canvas-pane-actions flex shrink-0 items-center">
                  <PaneButton label="Split right" onClick={() => onSplitPane(pane.id, "right")}>
                    <Columns2 aria-hidden className="h-3.5 w-3.5" />
                  </PaneButton>
                  <PaneButton label="Split down" onClick={() => onSplitPane(pane.id, "bottom")}>
                    <Rows2 aria-hidden className="h-3.5 w-3.5" />
                  </PaneButton>
                  <PaneButton label="Close panel (the tab stays open)" onClick={() => onClosePane(pane.id)}>
                    <X aria-hidden className="h-3.5 w-3.5" />
                  </PaneButton>
                </span>
              </header>
            ) : null}
            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
              {split && !tab ? (
                <EmptyPanePicker
                  hiddenTabs={hiddenTabs}
                  onPick={(tabId) => onPlaceTab(pane.id, tabId)}
                  onClose={() => onClosePane(pane.id)}
                />
              ) : (
                <PaneContent pane={pane} focused={focused} renderPane={renderPane} />
              )}
            </div>
            {tabDragActive ? (
              <div
                className="libera-canvas-drop-layer absolute inset-0 z-40"
                onDragOver={(event) => handlePaneDragOver(event, pane.id)}
                onDrop={(event) => handlePaneDrop(event, pane.id)}
              >
                {target ? (
                  <div className="libera-canvas-drop-preview" data-zone={target}>
                    <span>{DROP_ZONE_LABEL[target]}</span>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        );
      })}
      {handles.map(({ split: splitNode, rect }) => {
        const row = splitNode.direction === "row";
        const boundary = row ? rect.x + rect.width * splitNode.ratio : rect.y + rect.height * splitNode.ratio;
        const style: CSSProperties = row
          ? { left: percent(boundary), top: percent(rect.y), height: percent(rect.height) }
          : { top: percent(boundary), left: percent(rect.x), width: percent(rect.width) };

        return (
          <div
            key={splitNode.id}
            role="separator"
            aria-orientation={row ? "vertical" : "horizontal"}
            aria-label={row ? "Resize panels side by side" : "Resize stacked panels"}
            aria-valuemin={12}
            aria-valuemax={88}
            aria-valuenow={Math.round(splitNode.ratio * 100)}
            tabIndex={0}
            title="Drag to resize · double-click to even out"
            className="libera-canvas-split-handle absolute z-30 touch-none"
            data-direction={splitNode.direction}
            data-active={resizeDrag?.split.id === splitNode.id ? "true" : undefined}
            style={style}
            onDoubleClick={() => onResizeSplit(splitNode.id, 0.5)}
            onKeyDown={(event) => resizeWithKeyboard(event, splitNode)}
            onLostPointerCapture={() => setResizeDrag(null)}
            onPointerCancel={() => setResizeDrag(null)}
            onPointerDown={(event) => startResize(event, splitNode, rect)}
            onPointerMove={moveResize}
            onPointerUp={finishResize}
          />
        );
      })}
    </div>
  );
}

function PaneButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

function EmptyPanePicker({
  hiddenTabs,
  onPick,
  onClose,
}: {
  hiddenTabs: OpenTab[];
  onPick: (tabId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
      <div className="w-full max-w-sm">
        <h2 className="text-sm font-semibold text-foreground">Choose what to show here</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Pick an open tab, click a tab in the tab bar, open a file from the sidebar, or drag a tab onto this panel.
        </p>
        {hiddenTabs.length ? (
          <ul className="mt-4 max-h-72 space-y-1 overflow-auto">
            {hiddenTabs.map((tab) => (
              <li key={tab.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left text-sm transition hover:border-accent/50 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => onPick(tab.id)}
                >
                  <span aria-hidden className="libera-tab-file-icon" data-type={tab.file.fileType}>
                    <FileTypeIcon fileType={tab.file.fileType} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{tab.file.name}</span>
                  {tab.status === "dirty" ? (
                    <span aria-label="Unsaved" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
            Every open tab is already on screen.
          </p>
        )}
        <button
          type="button"
          className="mt-4 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={onClose}
        >
          Close this panel
        </button>
      </div>
    </div>
  );
}
