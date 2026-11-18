import { headers } from "next/headers";
import { DEFAULT_LOCALE, isAppLocale, matchAcceptLanguage, type AppLocale } from "./locales";
import { createServerT, type ServerT } from "./server-translator";

/**
 * Libera has no locale in its URLs. Electron resolves the Language preference (including "System") and passes it
 * as LIBERA_LOCALE when it starts the server; outside Electron, the browser's Accept-Language decides.
 * Server-only: reads the request headers, so call it inside a request (a route handler or a server component).
 */
export async function resolveLocale(): Promise<AppLocale> {
  const configured = process.env.LIBERA_LOCALE;
  if (isAppLocale(configured)) return configured;
  try {
    return matchAcceptLanguage((await headers()).get("accept-language"));
  } catch {
    // headers() throws outside a request scope (a route handler called directly, as the tests do): English.
    return DEFAULT_LOCALE;
  }
}

/** The translator for the current request's interface language: `await getServerT("aiRoutes")`. Call inside a request. */
export async function getServerT(namespace: string): Promise<ServerT> {
  return createServerT(await resolveLocale(), namespace);
}
