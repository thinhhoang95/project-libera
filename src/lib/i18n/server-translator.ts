// Server-side only (loads every message file on demand): translators for route handlers and other server code.
import { createTranslator } from "next-intl";
import en from "../../../messages/en.json";
import type { AppLocale } from "./locales";
import { loadMessages } from "./messages";

/** Translates a message under one namespace: `t("format.tooLarge")`, with ICU arguments as the second parameter. */
export type ServerT = (key: string, values?: Record<string, string | number>) => string;

function make(locale: string, messages: unknown, namespace: string): ServerT {
  // The namespace is a runtime string, so the typed message-key overloads do not apply.
  const options = { locale, messages, namespace, onError: () => {} };
  return createTranslator(options as unknown as Parameters<typeof createTranslator>[0]) as unknown as ServerT;
}

/** English, for code that runs without a request (tests, scripts). */
export function englishServerT(namespace: string): ServerT {
  return make("en", en, namespace);
}

/** The translator for a locale, over English so a missing translation shows English. */
export async function createServerT(locale: AppLocale, namespace: string): Promise<ServerT> {
  return locale === "en" ? englishServerT(namespace) : make(locale, await loadMessages(locale), namespace);
}

