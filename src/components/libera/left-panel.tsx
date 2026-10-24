"use client";

import { useEffect } from "react";
import type { RefObject } from "react";
import {
  BookMarked,
  BookOpen,
  Images,
  Layers3,
  LogOut,
  ListTree,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  ScanSearch,
  type LucideIcon,
} from "lucide-react";
import { CollabRailButtons } from "@/components/libera/collab/collab-shell";
import { CommentsWithSuggestions } from "@/components/libera/collab/suggestions";
import { SearchPanel } from "@/components/libera/global-search/search-panel";
import { ImageGenerationPanel } from "@/components/libera/image-generation-panel";
import { NotebookPanel, type NotebookPanelProps } from "@/components/libera/notebook-panel";
import { OutlinePanel } from "@/components/libera/outline-panel";
import { ReviewComments } from "@/components/libera/markdown-review-ui";
import { PdfReviewComments } from "@/components/libera/pdf-comments-panel";
import { ReferencesPanel, type ReferencesPanelProps } from "@/components/libera/references/references-panel";
import { SidebarAppMenu } from "@/components/libera/sidebar-app-menu";
import { SpendingPanel } from "@/components/libera/spending/spending-panel";
import { contextualPanelTabs, type ContextualPanelTab } from "@/components/libera/page-tabs";
import type { OpenTab } from "@/components/libera/types";

import { WorkspacesPanel, type WorkspaceManager } from "./workspaces-panel";
import type { MathMarkerSettings } from "@/lib/math-markers";
import type { LiberaFileNode, LiberaTree, LiberaTreeNode } from "@/lib/types";

/**
 * The rail's tabs. Contextual ones (page-tabs.ts) appear only while the page
 * they belong to is the active tab, in a group of their own below the others.
 */
export type LeftPanelTab = "notebook" | "outlines" | "comments" | "workspaces" | "gallery" | "search" | "references" | ContextualPanelTab;

/** What the References panel needs beyond the notebook and tree. */
export type LeftPanelReferences = Omit<ReferencesPanelProps, "notebook" | "tree">;

type LeftPanelProps = NotebookPanelProps & {
  workspaceManager: WorkspaceManager;
  fullTree: LiberaTree;
  activeTab?: OpenTab;
  activePanel: LeftPanelTab;
  onPanelChange: (panel: LeftPanelTab) => void;
  collapsed: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onLogout: () => Promise<void>;
  onSetDraft: (value: string) => void;
  onToggleCollapsed: () => void;
  onGeneratedFilesSaved: (files: LiberaFileNode[]) => void;
  onOpenSearchPreferences?: () => void;
  references?: LeftPanelReferences;
  /** Math markers for Markdown the panels render (Outlines → Definitions). */
  mathMarkers?: MathMarkerSettings;
};

type LeftPanelRailTab = {
  icon: LucideIcon;
  id: LeftPanelTab;
  label: string;
};

const TOP_PANEL_TABS: LeftPanelRailTab[] = [
  { id: "notebook", label: "Notebook", icon: BookOpen },
  { id: "outlines", label: "Outlines", icon: ListTree },
  { id: "comments", label: "Comments", icon: MessageSquare },
  { id: "references", label: "References", icon: BookMarked },
  { id: "gallery", label: "Image Gallery", icon: Images },
];

const BOTTOM_PANEL_TABS: LeftPanelRailTab[] = [
  { id: "search", label: "Search", icon: ScanSearch },
  { id: "workspaces", label: "Workspaces", icon: Layers3 },
];

export function LeftPanel({
  workspaceManager,
  fullTree,
  activeTab,
  activePanel,
  onPanelChange,
  collapsed,
  textareaRef,
  onLogout,
  onSetDraft,
  onToggleCollapsed,
  onGeneratedFilesSaved,
  onOpenSearchPreferences,
  references,
  mathMarkers,
  ...notebookPanelProps
}: LeftPanelProps) {
  function selectPanel(panel: LeftPanelTab) {
    onPanelChange(panel);

    if (collapsed) {
      onToggleCollapsed();
    }
  }

  // macOS frameless window: the collapsed rail is too narrow for the traffic
  // lights, so hide them until the panel expands again. No-op elsewhere.
  useEffect(() => {
    void window.liberaWindow?.setButtonsVisible(!collapsed);
  }, [collapsed]);

  useEffect(() => () => {
    void window.liberaWindow?.setButtonsVisible(true);
  }, []);

  const contextualTabs = contextualPanelTabs(activeTab);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.shiftKey ||
        (!event.metaKey && !event.ctrlKey)
      ) {
        return;
      }

      const nextPanel =
        event.key === "1" || event.code === "Digit1"
          ? "notebook"
          : event.key === "2" || event.code === "Digit2"
            ? "outlines"
            : event.key === "3" || event.code === "Digit3"
              ? "comments"
              : event.key === "4" || event.code === "Digit4"
                ? "workspaces"
                : event.key === "5" || event.code === "Digit5"
                  ? "gallery"
                  : event.key === "6" || event.code === "Digit6"
                    ? "search"
                    : event.key === "7" || event.code === "Digit7"
                      ? "references"
                      : null;

      if (!nextPanel) {
        return;
      }

      event.preventDefault();
      onPanelChange(nextPanel);

      if (collapsed) {
        onToggleCollapsed();
      }
    }

    // ⌘/Ctrl+Shift+F searches everything, from anywhere. It is handled before
    // the editors, whose find bars take ⌘/Ctrl+F with or without Shift.
    function handleGlobalSearchKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.code !== "KeyF" || event.repeat || event.isComposing) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onPanelChange("search");

      if (collapsed) {
        onToggleCollapsed();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keydown", handleGlobalSearchKey, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keydown", handleGlobalSearchKey, true);
    };
  }, [collapsed, onToggleCollapsed, onPanelChange]);

  return (
    <aside className="libera-glass-panel libera-left-panel flex min-h-0 max-h-[40vh] flex-col overflow-hidden border-b border-border bg-card lg:max-h-none lg:border-b-0 lg:border-r">
      {/* Frameless macOS window: this strip carries the native traffic-light
          buttons and doubles as the window drag handle. It is hidden on web and
          non-macOS builds, which keep their own title bar. */}
      <div className="libera-sidebar-titlebar" aria-hidden />
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <LeftPanelRail
          activePanel={activePanel}
          contextualTabs={contextualTabs}
          collapsed={collapsed}
          onLogout={onLogout}
          onSelectPanel={selectPanel}
          onToggleCollapsed={onToggleCollapsed}
        />
        {!collapsed ? (
          <div role="tabpanel" id={`left-panel-${activePanel}`} aria-labelledby={`left-panel-tab-${activePanel}`} className="flex min-h-0 min-w-0 flex-1 flex-col pr-1.5">
            {activePanel === "spending" ? (
              <SpendingPanel />
            ) : activePanel === "workspaces" ? (
              <WorkspacesPanel manager={workspaceManager} tree={fullTree} />
            ) : activePanel === "notebook" ? (
              <>
                {workspaceManager.activeWorkspace && <div className="mx-3 mt-3 flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2">
                  <Layers3 className="h-4 w-4 shrink-0" style={{ color: workspaceManager.activeWorkspace.color }} />
                  <button className="min-w-0 flex-1 text-left" title="Manage active workspace" onClick={() => selectPanel("workspaces")}><span className="block text-[10px] uppercase tracking-wider text-muted-foreground">Workspace</span><span className="block truncate text-sm font-medium">{workspaceManager.activeWorkspace.name}</span></button>
                  <button className="libera-sidebar-icon-button rounded-lg p-1.5" aria-label="Exit workspace" title="Exit workspace" disabled={workspaceManager.switching} onClick={() => { void workspaceManager.switchWorkspace(null).catch(() => selectPanel("workspaces")); }}><LogOut className="h-3.5 w-3.5" /></button>
                </div>}
                <NotebookPanel {...notebookPanelProps} onManageWorkspace={() => selectPanel("workspaces")} workspaceActive={Boolean(workspaceManager.activeWorkspace)} />
              </>
            ) : activePanel === "gallery" ? (
              <ImageGenerationPanel
                tree={notebookPanelProps.tree}
                onFilesSaved={(files) => onGeneratedFilesSaved(files)}
                onOpenFile={(file) => {
                  onPanelChange("notebook");
                  notebookPanelProps.onOpenFile(file);
                }}
              />
            ) : activePanel === "search" ? (
              <SearchPanel onOpenPreferences={onOpenSearchPreferences} />
            ) : activePanel === "references" ? (
              <ReferencesPanel
                notebook={notebookPanelProps.selectedNotebookName}
                tree={notebookPanelProps.tree}
                activeMarkdownDraft={references?.activeMarkdownDraft ?? null}
                activeDocumentPath={references?.activeDocumentPath ?? null}
                openDrafts={references?.openDrafts ?? NO_DRAFTS}
                canCite={references?.canCite ?? false}
                onCite={references?.onCite ?? (() => undefined)}
                onCiteMany={references?.onCiteMany}
                onOpenCitation={references?.onOpenCitation}
                onInsertBibliography={references?.onInsertBibliography}
                onOpenPath={references?.onOpenPath ?? ((path) => {
                  const file = findFileNode(notebookPanelProps.tree, path);
                  if (file) notebookPanelProps.onOpenFile(file);
                })}
                onUploadFiles={references?.onUploadFiles}
                request={references?.request}
                onRequestHandled={references?.onRequestHandled}
                onApplyCitationRewrite={references?.onApplyCitationRewrite}
                onRevertCitationRewrite={references?.onRevertCitationRewrite}
              />
            ) : activePanel === "comments" ? (
              activeTab?.file.fileType === "pdf" && !activeTab.gallery ? (
                <PdfReviewComments key={activeTab.file.path} path={activeTab.file.path} />
              ) : (
                <CommentsWithSuggestions key={activeTab?.id ?? "no-document"} tabId={activeTab?.id} comments={<ReviewComments />} />
              )
            ) : (
              <OutlinePanel
                activeTab={activeTab}
                textareaRef={textareaRef}
                onOpenFile={notebookPanelProps.onOpenFile}
                onSetDraft={onSetDraft}
                mathMarkers={mathMarkers}
              />
            )}
          </div>
        ) : null}
      </div>
    </aside>
  );
}

const NO_DRAFTS: LeftPanelReferences["openDrafts"] = [];

function findFileNode(tree: LiberaTree, path: string): LiberaFileNode | undefined {
  const walk = (nodes: LiberaTreeNode[]): LiberaFileNode | undefined => {
    for (const node of nodes) {
      if (node.kind === "file" && node.path === path) return node;
      if (node.kind === "folder") {
        const found = walk(node.children);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(tree.notebooks.flatMap((notebook) => notebook.children));
}

function LeftPanelRail({
  activePanel,
  contextualTabs,
  collapsed,
  onLogout,
  onSelectPanel,
  onToggleCollapsed,
}: {
  activePanel: LeftPanelTab;
  contextualTabs: LeftPanelRailTab[];
  collapsed: boolean;
  onLogout: () => Promise<void>;
  onSelectPanel: (panel: LeftPanelTab) => void;
  onToggleCollapsed: () => void;
}) {
  function renderTab(tab: LeftPanelRailTab) {
    const Icon = tab.icon;
    const label = tab.label;
    const selected = activePanel === tab.id;

    return (
      <button
        key={tab.id}
        id={`left-panel-tab-${tab.id}`}
        aria-controls={`left-panel-${tab.id}`}
        aria-label={`${label} tab`}
        aria-selected={selected}
        className="libera-sidebar-icon-button inline-flex h-9 w-9 items-center justify-center rounded-lg"
        role="tab"
        title={label}
        type="button"
        onClick={() => onSelectPanel(tab.id)}
      >
        <Icon aria-hidden className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div className="libera-glass-chrome flex w-12 shrink-0 flex-col bg-card">
      <div className="flex justify-center py-2">
        <button
          className="libera-sidebar-icon-button inline-flex h-9 w-9 items-center justify-center rounded-lg"
          type="button"
          aria-label={collapsed ? "Expand left panel" : "Collapse left panel"}
          title={collapsed ? "Expand left panel" : "Collapse left panel"}
          onClick={onToggleCollapsed}
        >
          {collapsed ? (
            <PanelLeftOpen aria-hidden className="h-4 w-4" />
          ) : (
            <PanelLeftClose aria-hidden className="h-4 w-4" />
          )}
        </button>
      </div>

      <div
        aria-label="Left panel tabs"
        className="flex min-h-0 flex-1 flex-col items-center gap-1 py-2"
        role="tablist"
      >
        <div className="flex flex-col items-center gap-1">
          {TOP_PANEL_TABS.map(renderTab)}
        </div>
        {contextualTabs.length ? (
          // Like a contextual ribbon tab: shown only while its page is the active tab.
          <div className="libera-rail-contextual flex flex-col items-center gap-1">
            {contextualTabs.map(renderTab)}
          </div>
        ) : null}
        <div className="min-h-0 flex-1" />
        <div className="flex flex-col items-center gap-1">
          {BOTTOM_PANEL_TABS.map(renderTab)}
        </div>
      </div>

      <CollabRailButtons />
      <SidebarAppMenu collapsed onLogout={onLogout} />
    </div>
  );
}
