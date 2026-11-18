// Node's editor tests exercise DOM behavior without a bundler. Styles are
// handled by Next/Electron in the app and have no runtime exports to mock.
require.extensions[".css"] = () => {};

// Tests answer OpenRouter requests with stubs; keep their made-up usage out of
// the Spending ledger in the real data folder (storage/usage-ledger.ts).
process.env.LIBERA_USAGE_LEDGER = "off";

// Components read their text through next-intl, whose hooks need a provider (the app's root layout supplies one).
// Tests render components without it, so here the hooks fall back to the English messages when no provider is
// mounted; a test that mounts one (scripts/editor/intl.ts withEnglishIntl) gets the real thing.
const Module = require("node:module");
const path = require("node:path");
const originalLoad = Module._load;
let intlForTests;

function englishIntl(intl) {
  const messages = require(path.join(__dirname, "../../messages/en.json"));
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const config = { locale: "en", messages, timeZone };
  const formatter = intl.createFormatter(config);
  // One translator per namespace, like the real provider: components list `t` in effect and memo dependencies, so a
  // new function on every render would re-run them forever.
  const translators = new Map();
  const translatorFor = (namespace) => {
    const key = namespace ?? "";
    if (!translators.has(key)) translators.set(key, intl.createTranslator({ ...config, namespace }));
    return translators.get(key);
  };
  // The original hook throws only when no provider is mounted; it does so on every render, so hook order is stable.
  const orFallback = (hook, fallback) => (...args) => { try { return hook(...args); } catch { return fallback(...args); } };
  return {
    ...intl,
    useTranslations: orFallback(intl.useTranslations, translatorFor),
    useFormatter: orFallback(intl.useFormatter, () => formatter),
    useLocale: orFallback(intl.useLocale, () => "en"),
    useMessages: orFallback(intl.useMessages, () => messages),
    useTimeZone: orFallback(intl.useTimeZone, () => timeZone),
    useNow: orFallback(intl.useNow, () => new Date()),
  };
}

Module._load = function load(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (request !== "next-intl") return loaded;
  return (intlForTests ??= englishIntl(loaded));
};
