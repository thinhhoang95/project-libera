"use client";

import { useEffect } from "react";
import type { RefObject } from "react";
import {
  BookOpen,
  Layers3,
  LogOut,
  ListTree,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from "lucide-react";
import { NotebookPanel, type NotebookPanelProps } from "@/components/libera/notebook-panel";
import { OutlinePanel } from "@/components/libera/outline-panel";
import { ReviewComments } from "@/components/libera/markdown-review-ui";
import { SidebarAppMenu } from "@/components/libera/sidebar-app-menu";
import type { OpenTab } from "@/components/libera/types";

import { WorkspacesPanel, type WorkspaceManager } from "./workspaces-panel";
import type { LiberaTree } from "@/lib/types";

export type LeftPanelTab = "notebook" | "outlines" | "comments" | "workspaces";

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
};

const LEFT_PANEL_TABS: Array<{
  icon: LucideIcon;
  id: LeftPanelTab;
  label: string;
}> = [
  { id: "workspaces", label: "Workspaces", icon: Layers3 },
  { id: "notebook", label: "Notebook", icon: BookOpen },
  { id: "outlines", label: "Outlines", icon: ListTree },
  { id: "comments", label: "Comments", icon: MessageSquare },
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
  ...notebookPanelProps
}: LeftPanelProps) {
  function selectPanel(panel: LeftPanelTab) {
    onPanelChange(panel);

    if (collapsed) {
      onToggleCollapsed();
    }
  }

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

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
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
          collapsed={collapsed}
          onLogout={onLogout}
          onSelectPanel={selectPanel}
          onToggleCollapsed={onToggleCollapsed}
        />
        {!collapsed ? (
          <div role="tabpanel" id={`left-panel-${activePanel}`} aria-labelledby={`left-panel-tab-${activePanel}`} className="flex min-h-0 min-w-0 flex-1 flex-col pr-1.5">
            {activePanel === "workspaces" ? (
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
            ) : activePanel === "comments" ? (
              <ReviewComments key={activeTab?.id ?? "no-document"} />
            ) : (
              <OutlinePanel
                activeTab={activeTab}
                textareaRef={textareaRef}
                onOpenFile={notebookPanelProps.onOpenFile}
                onSetDraft={onSetDraft}
              />
            )}
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function LeftPanelRail({
  activePanel,
  collapsed,
  onLogout,
  onSelectPanel,
  onToggleCollapsed,
}: {
  activePanel: LeftPanelTab;
  collapsed: boolean;
  onLogout: () => Promise<void>;
  onSelectPanel: (panel: LeftPanelTab) => void;
  onToggleCollapsed: () => void;
}) {
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
        className="flex flex-col items-center gap-1 py-2"
        role="tablist"
      >
        {LEFT_PANEL_TABS.map((tab) => {
          const Icon = tab.icon;
          const selected = activePanel === tab.id;

          return (
            <button
              key={tab.id}
              id={`left-panel-tab-${tab.id}`}
              aria-controls={`left-panel-${tab.id}`}
              aria-label={`${tab.label} tab`}
              aria-selected={selected}
              className="libera-sidebar-icon-button inline-flex h-9 w-9 items-center justify-center rounded-lg"
              role="tab"
              title={tab.label}
              type="button"
              onClick={() => onSelectPanel(tab.id)}
            >
              <Icon aria-hidden className="h-4 w-4" />
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1" />
      <SidebarAppMenu collapsed onLogout={onLogout} />
    </div>
  );
}
