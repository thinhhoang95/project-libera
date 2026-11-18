import { getRequestConfig } from "next-intl/server";
import { loadMessages } from "@/lib/i18n/messages";
import { resolveLocale } from "@/lib/i18n/server-locale";

export default getRequestConfig(async () => {
  const locale = await resolveLocale();
  return {
    locale,
    messages: await loadMessages(locale),
    onError(error) {
      // A missing translation falls back to English in loadMessages; anything reaching here is a bug.
      if (process.env.NODE_ENV !== "production") console.error(error);
    },
    getMessageFallback({ namespace, key }) {
      return [namespace, key].filter(Boolean).join(".");
    },
  };
});
