"use client";

import { useEffect, useState } from "react";
import type { RefObject } from "react";
import {
  BookOpen,
  ListTree,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from "lucide-react";
import { NotebookPanel, type NotebookPanelProps } from "@/components/libera/notebook-panel";
import { OutlinePanel } from "@/components/libera/outline-panel";
import { SidebarAppMenu } from "@/components/libera/sidebar-app-menu";
import type { OpenTab } from "@/components/libera/types";

type LeftPanelTab = "notebook" | "outlines";

type LeftPanelProps = NotebookPanelProps & {
  activeTab?: OpenTab;
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
  { id: "notebook", label: "Notebook", icon: BookOpen },
  { id: "outlines", label: "Outlines", icon: ListTree },
];

export function LeftPanel({
  activeTab,
  collapsed,
  textareaRef,
  onLogout,
  onSetDraft,
  onToggleCollapsed,
  ...notebookPanelProps
}: LeftPanelProps) {
  const [activePanel, setActivePanel] = useState<LeftPanelTab>("notebook");

  function selectPanel(panel: LeftPanelTab) {
    setActivePanel(panel);

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
            : null;

      if (!nextPanel) {
        return;
      }

      event.preventDefault();
      setActivePanel(nextPanel);

      if (collapsed) {
        onToggleCollapsed();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [collapsed, onToggleCollapsed]);

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
          <div className="flex min-h-0 min-w-0 flex-1 flex-col pr-1.5">
            {activePanel === "notebook" ? (
              <NotebookPanel {...notebookPanelProps} />
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
