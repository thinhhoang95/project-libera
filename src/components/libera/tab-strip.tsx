import { X } from "lucide-react";
import type { OpenTab } from "@/components/libera/types";

type TabStripProps = {
  activeTabId: string;
  tabs: OpenTab[];
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
};

export function TabStrip({ activeTabId, tabs, onActivateTab, onCloseTab }: TabStripProps) {
  return (
    <div className="border-b border-zinc-200 bg-white">
      <div className="flex min-h-12 items-center gap-2 overflow-x-auto px-3 py-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`flex max-w-64 items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${
              activeTabId === tab.id
                ? "border-zinc-950 bg-zinc-950 text-white"
                : "border-zinc-200 bg-white hover:bg-zinc-50"
            }`}
            type="button"
            onClick={() => onActivateTab(tab.id)}
          >
            <span className="truncate">{tab.file.name}</span>
            {tab.status === "dirty" ? <span aria-label="Unsaved">*</span> : null}
            <span
              className="ml-1 rounded p-0.5 hover:bg-black/10"
              role="button"
              tabIndex={0}
              aria-label={`Close ${tab.file.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onCloseTab(tab.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }
              }}
            >
              <X aria-hidden className="h-3.5 w-3.5" />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
