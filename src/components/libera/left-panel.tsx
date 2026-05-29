"use client";

import { useState } from "react";
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

  return (
    <aside className="flex min-h-0 max-h-[40vh] overflow-hidden border-b border-border bg-card lg:max-h-none lg:border-b-0 lg:border-r">
      <LeftPanelRail
        activePanel={activePanel}
        collapsed={collapsed}
        onLogout={onLogout}
        onSelectPanel={selectPanel}
        onToggleCollapsed={onToggleCollapsed}
      />
      {!collapsed ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {activePanel === "notebook" ? (
            <NotebookPanel {...notebookPanelProps} />
          ) : (
            <OutlinePanel
              activeTab={activeTab}
              textareaRef={textareaRef}
              onOpenFile={notebookPanelProps.onOpenFile}
            />
          )}
        </div>
      ) : null}
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
    <div className="flex w-14 shrink-0 flex-col border-r border-border bg-card">
      <div className="border-b border-border px-2 py-2">
        <button
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-input text-foreground hover:bg-muted"
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
        className="flex flex-col gap-1 px-2 py-2"
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
              className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border text-foreground ${
                selected
                  ? "border-accent bg-accent text-accent-foreground"
                  : "border-transparent hover:border-input hover:bg-muted"
              }`}
              role="tab"
              style={
                selected
                  ? {
                      backgroundColor: "var(--accent)",
                      borderColor: "var(--accent)",
                      color: "var(--accent-foreground)",
                    }
                  : undefined
              }
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
