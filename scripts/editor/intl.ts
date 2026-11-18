// English translators for tests that call message-taking helpers outside React (components get theirs from the
// provider that setup.cjs wraps around every test root). Same messages and ICU formatting as the app.
import { createElement, type ReactElement } from "react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import en from "../../messages/en.json";

/** `element` inside the English message provider, for test roots that setup.cjs cannot wrap (dynamic `import()`). */
export function withEnglishIntl(element: ReactElement): ReactElement {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return createElement(NextIntlClientProvider, { locale: "en", messages: en, timeZone, children: element });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests pass these to helpers typed by each namespace
export function englishTranslator(namespace: string): any {
  return createTranslator({ locale: "en", messages: en, namespace: namespace as never });
}
