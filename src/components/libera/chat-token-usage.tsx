import { useSyncExternalStore } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { ArrowDownToLine, ArrowUpFromLine, Database } from "lucide-react";
import { chatUsageRequests, totalChatUsage } from "@/lib/chat-token-usage";
import type { DocumentChat } from "@/lib/document-chat";

const MANAGE_MODELS_ID = "chat-model-manage";
const subscribeNever = () => () => {};

export function ChatTokenUsage({ chat, model, models = [], onModelChange }: {
  chat: DocumentChat;
  model?: string;
  models?: string[];
  onModelChange?: (model: string) => void;
}) {
  const t = useTranslations("chatTokenUsage");
  const format = useFormatter();
  const requests = chatUsageRequests(chat);
  const totals = totalChatUsage(requests);
  const modelName = model?.split("/").filter(Boolean).at(-1);
  // The desktop app can open Preferences → AI from the menu, so the menu is worth showing with one model too.
  const canManageModels = useSyncExternalStore(subscribeNever, () => !!window.liberaMenu && !!window.liberaPreferences, () => false);
  const switchable = models.length > 1 || canManageModels;
  const counters = [
    { label: t("inputTokens"), value: totals.inputTokens, reported: totals.reported, Icon: ArrowUpFromLine, detail: t("detailInput") },
    { label: t("outputTokens"), value: totals.outputTokens, reported: totals.reported, Icon: ArrowDownToLine, detail: t("detailOutput") },
    { label: t("cachedInputTokens"), value: totals.cachedTokens, reported: totals.cacheReported, Icon: Database, detail: t("detailCached") },
  ];
  async function openModelMenu(button: HTMLButtonElement) {
    if (!model || !switchable || !window.liberaMenu) return;
    const bounds = button.getBoundingClientRect();
    try {
      const selected = await window.liberaMenu.popup({
        x: Math.round(bounds.left),
        y: Math.round(bounds.bottom),
        items: [
          ...models.map((candidate, index) => ({
            id: `chat-model-${index}`,
            label: candidate,
            type: "radio" as const,
            checked: candidate === model,
          })),
          ...(window.liberaPreferences ? [{ type: "separator" as const }, { id: MANAGE_MODELS_ID, label: t("manageModels") }] : []),
        ],
      });
      if (selected === MANAGE_MODELS_ID) { void window.liberaPreferences?.open("ai"); return; }
      const index = selected?.startsWith("chat-model-") ? Number(selected.slice("chat-model-".length)) : Number.NaN;
      if (Number.isInteger(index) && models[index]) onModelChange?.(models[index]);
    } catch {
      // Closing or losing the native menu should leave the current model unchanged.
    }
  }
  return <div className="libera-chat-status">
    <div className="libera-chat-token-usage" role="group" aria-label={t("tokenUsageGroup")}>
      {counters.map(({ label, value, reported, Icon, detail }) => {
        const missing = requests.length - reported;
        const amount = requests.length && !reported ? t("unavailable") : missing ? t("atLeast", { amount: format.number(value) }) : format.number(value);
        const description = t("tokenDescription", { label, amount, detail, missing });
        return <span key={label} tabIndex={0} aria-label={description} title={description}>
          <Icon size={12} aria-hidden="true" />
          <span aria-hidden="true">{requests.length && !reported ? "—" : `${missing ? "≥" : ""}${format.number(value, { notation: "compact", maximumFractionDigits: 1 })}`}</span>
        </span>;
      })}
    </div>
    {modelName && (switchable
      ? <button type="button" className="libera-chat-model" aria-haspopup="menu" aria-label={t("modelLabel", { model: model ?? "" })} title={t("modelSwitchTitle", { model: model ?? "" })} onClick={(event) => void openModelMenu(event.currentTarget)}>{modelName}</button>
      : <span className="libera-chat-model" tabIndex={0} aria-label={t("modelLabel", { model: model ?? "" })} title={t("modelLabel", { model: model ?? "" })}>{modelName}</span>)}
  </div>;
}
