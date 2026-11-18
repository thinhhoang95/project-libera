import { headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { isAppLocale, matchAcceptLanguage, type AppLocale } from "@/lib/i18n/locales";
import { loadMessages } from "@/lib/i18n/messages";

/**
 * Libera has no locale in its URLs. Electron resolves the Language preference (including "System") and passes it
 * as LIBERA_LOCALE when it starts the server; outside Electron, the browser's Accept-Language decides.
 */
async function resolveLocale(): Promise<AppLocale> {
  const configured = process.env.LIBERA_LOCALE;
  if (isAppLocale(configured)) return configured;
  return matchAcceptLanguage((await headers()).get("accept-language"));
}

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
