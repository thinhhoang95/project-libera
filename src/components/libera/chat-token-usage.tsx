import { ArrowDownToLine, ArrowUpFromLine, Database } from "lucide-react";
import { chatUsageRequests, totalChatUsage } from "@/lib/chat-token-usage";
import type { DocumentChat } from "@/lib/document-chat";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat("en");

export function ChatTokenUsage({ chat, model, models = [], onModelChange }: {
  chat: DocumentChat;
  model?: string;
  models?: string[];
  onModelChange?: (model: string) => void;
}) {
  const requests = chatUsageRequests(chat);
  const totals = totalChatUsage(requests);
  const modelName = model?.split("/").filter(Boolean).at(-1);
  const counters = [
    { label: "Input tokens", value: totals.inputTokens, reported: totals.reported, Icon: ArrowUpFromLine, detail: "Includes system instructions, attachments, and conversation history sent on each request." },
    { label: "Output tokens", value: totals.outputTokens, reported: totals.reported, Icon: ArrowDownToLine, detail: "Output usage reported by the model provider, including reasoning where counted." },
    { label: "Cached input tokens", value: totals.cachedTokens, reported: totals.cacheReported, Icon: Database, detail: "Input tokens read from cache; already included in input tokens." },
  ];
  async function openModelMenu(button: HTMLButtonElement) {
    if (!model || models.length < 2 || !window.liberaMenu) return;
    const bounds = button.getBoundingClientRect();
    try {
      const selected = await window.liberaMenu.popup({
        x: Math.round(bounds.left),
        y: Math.round(bounds.bottom),
        items: models.map((candidate, index) => ({
          id: `chat-model-${index}`,
          label: candidate,
          type: "radio" as const,
          checked: candidate === model,
        })),
      });
      const index = selected?.startsWith("chat-model-") ? Number(selected.slice("chat-model-".length)) : Number.NaN;
      if (Number.isInteger(index) && models[index]) onModelChange?.(models[index]);
    } catch {
      // Closing or losing the native menu should leave the current model unchanged.
    }
  }
  return <div className="libera-chat-status">
    <div className="libera-chat-token-usage" role="group" aria-label="Chat token usage">
      {counters.map(({ label, value, reported, Icon, detail }) => {
        const missing = requests.length - reported;
        const amount = requests.length && !reported ? "Unavailable" : `${missing ? "At least " : ""}${exact.format(value)}`;
        const description = `${label}: ${amount}. Chat total, including retries and inherited branch history. ${detail}${missing ? ` Usage unavailable for ${missing} request${missing === 1 ? "" : "s"} (older, pending, interrupted, or unreported).` : ""}`;
        return <span key={label} tabIndex={0} aria-label={description} title={description}>
          <Icon size={12} aria-hidden="true" />
          <span aria-hidden="true">{requests.length && !reported ? "—" : `${missing ? "≥" : ""}${compact.format(value)}`}</span>
        </span>;
      })}
    </div>
    {modelName && (models.length > 1
      ? <button type="button" className="libera-chat-model" aria-haspopup="menu" aria-label={`Model: ${model}`} title={`Model: ${model}. Click to switch models.`} onClick={(event) => void openModelMenu(event.currentTarget)}>{modelName}</button>
      : <span className="libera-chat-model" tabIndex={0} aria-label={`Model: ${model}`} title={`Model: ${model}`}>{modelName}</span>)}
  </div>;
}
