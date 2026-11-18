// English wording for the shared Electron helpers that also run outside the main process: latex-snippets.cjs and
// local-llms.cjs are imported by the Next app (the browser and the server), where electron/i18n.cjs (a file reader)
// cannot go. The text comes from messages/en.json, so there is no second copy to keep in step. The main process
// words the same messages in the interface language with electron/i18n.cjs and passes its own `translate`.
const english = require("../messages/en.json");

// intl-messageformat is ESM only; require() of an ES module works in Node 22+ and in the Next bundlers.
let IntlMessageFormat = null;
function formatterClass() {
  if (!IntlMessageFormat) {
    const loaded = require("intl-messageformat");
    IntlMessageFormat = loaded.IntlMessageFormat ?? loaded.default;
  }
  return IntlMessageFormat;
}

/** @param {string} namespace dotted, e.g. "electron.localLlms"
 *  @returns {(key: string, values?: Record<string, string | number>) => string} */
function englishTranslator(namespace) {
  let node = english;
  for (const part of namespace.split(".")) node = node?.[part];
  const messages = node && typeof node === "object" ? node : {};
  return (key, values) => {
    const message = messages[key];
    if (typeof message !== "string") return `${namespace}.${key}`;
    if (!values && !/[{<]/.test(message)) return message;
    try {
      const result = new (formatterClass())(message, "en").format(values ?? {});
      return Array.isArray(result) ? result.join("") : String(result);
    } catch {
      return message;
    }
  };
}

module.exports = { englishTranslator };
