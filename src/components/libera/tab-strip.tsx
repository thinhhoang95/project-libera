import { X } from "lucide-react";
import type { OpenTab } from "@/components/libera/types";

type TabStripProps = {
  activeTabId: string;
  notebookColors: Record<string, string>;
  tabs: OpenTab[];
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
};

function readableTextColor(backgroundColor: string) {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(backgroundColor);

  if (!match) {
    return "#ffffff";
  }

  const [, redHex, greenHex, blueHex] = match;
  const red = Number.parseInt(redHex, 16);
  const green = Number.parseInt(greenHex, 16);
  const blue = Number.parseInt(blueHex, 16);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;

  return luminance > 0.58 ? "#18181b" : "#ffffff";
}

export function TabStrip({
  activeTabId,
  notebookColors,
  tabs,
  onActivateTab,
  onCloseTab,
}: TabStripProps) {
  return (
    <div className="border-b border-zinc-200 bg-white">
      <div className="flex min-h-12 items-center gap-2 overflow-x-auto px-3 py-2">
        {tabs.map((tab) => {
          const tabColor = notebookColors[tab.file.notebook] ?? "#64748b";
          const textColor = readableTextColor(tabColor);
          const isActive = activeTabId === tab.id;

          return (
            <button
              key={tab.id}
              className={`flex max-w-64 items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition ${
                isActive
                  ? "shadow-sm ring-2 ring-zinc-950/20"
                  : "opacity-85 hover:opacity-100"
              }`}
              style={{
                backgroundColor: tabColor,
                borderColor: tabColor,
                color: textColor,
              }}
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
          );
        })}
      </div>
    </div>
  );
}
