"use client";

import { useTranslations } from "next-intl";
import { Loader2, Square } from "lucide-react";
import { useCancellableAiActivities } from "@/lib/ai-activity";

/**
 * The Gemini-style washes that flow along the top and bottom of a side panel
 * while its AI works (AI Chat, Create images). Styles live with
 * `.libera-chat-glow` in globals.css; the panel must be `relative overflow-hidden`
 * and keep its content in a positioned layer above these.
 */
export function AiPanelGlow({ active }: { active: boolean }) {
  return <>
    <div aria-hidden className="libera-chat-glow" data-active={active} />
    <div aria-hidden className="libera-chat-glow libera-chat-glow-bottom" data-active={active} />
  </>;
}

/**
 * A card near the bottom of the window while an editor AI action (Write with
 * AI, AI Formatting, AI Rewrite...) runs, so it can be stopped from anywhere.
 */
export function AiActivityCard() {
  const t = useTranslations("aiActivityUi");
  const tAction = useTranslations("lib.aiActivity.action");
  const activities = useCancellableAiActivities();
  if (!activities.length) return null;
  const labelOf = (activity: (typeof activities)[number]) => activity.action ? tAction(activity.action) : activity.label ?? "";
  return <div role="status" aria-label={t("aiWorking")} className="libera-ai-activity-card fixed bottom-10 left-1/2 z-50 flex w-max max-w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-1 rounded-2xl bg-card py-1.5 pl-3.5 pr-1.5 text-sm shadow-lg">
    {activities.map((activity) => <div key={activity.id} className="flex items-center gap-2">
      <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin text-[#457be6]" />
      <span className="min-w-0 flex-1 truncate">{t("activityLabel", { label: labelOf(activity) })}</span>
      <button type="button" className="ml-2 inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={t("stopActivityLabel", { label: labelOf(activity) })} title={t("stop")} onClick={activity.cancel}>
        <Square aria-hidden className="h-3 w-3" />{t("stop")}
      </button>
    </div>)}
  </div>;
}
