// Messages for the Electron main process (menus, native dialogs) and the Preferences window (setup.html).
//
// Reads the same messages/<locale>.json files as the Next app (src/lib/i18n/messages.ts): a translation is laid
// over English, so a key a translation lacks shows its English text, and a missing locale file means English.
// ICU messages are formatted with intl-messageformat (the formatter next-intl uses).
//
// The files are at <app>/messages: next to electron/ in the repository, and copied to the staged app by
// electron/prepare-dist.cjs, so "../messages" from this file resolves in development and in a packaged build.
const fs = require("node:fs");
const path = require("node:path");

const PSEUDO_LOCALE = "en-XA";
const MESSAGES_DIRECTORY = process.env.LIBERA_MESSAGES_DIR || path.join(__dirname, "..", "messages");

// intl-messageformat is ESM only; require() of an ES module works in Node 22+ (Electron 45 ships Node 24).
let IntlMessageFormat = null;
function formatterClass() {
  if (!IntlMessageFormat) {
    const loaded = require("intl-messageformat");
    IntlMessageFormat = loaded.IntlMessageFormat ?? loaded.default;
  }
  return IntlMessageFormat;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Translation over English, key by key, recursively. */
function overlay(base, top) {
  const out = { ...base };
  for (const [key, value] of Object.entries(top)) {
    const under = base[key];
    out[key] = isPlainObject(value) && isPlainObject(under) ? overlay(under, value) : value;
  }
  return out;
}

function readMessageFile(locale) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIRECTORY, `${locale}.json`), "utf8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Same transform as pseudoLocalize in src/lib/i18n/messages.ts: accent the literal text of an ICU message and pad
// it by about 40%, leaving {arguments}, plural/select keywords, <tags> and '-quoted text untouched.
const ACCENTS = {
  a: "à", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "î", j: "ĵ", k: "ķ", l: "ļ", m: "ɱ",
  n: "ñ", o: "ö", p: "þ", r: "ŕ", s: "š", t: "ţ", u: "û", w: "ŵ", y: "ý", z: "ž",
  A: "Å", C: "Ç", D: "Ð", E: "É", G: "Ĝ", I: "Î", L: "Ļ", N: "Ñ", O: "Ö", S: "Š", U: "Û", Y: "Ý", Z: "Ž",
};

function pseudoLocalize(message) {
  let out = "";
  let depth = 0;
  let letters = 0;
  for (let i = 0; i < message.length; i++) {
    const ch = message[i];
    if (ch === "'" && /['{}<>#]/.test(message[i + 1] ?? "")) {
      const end = message[i + 1] === "'" ? i + 1 : message.indexOf("'", i + 1);
      const stop = end === -1 ? message.length - 1 : end;
      out += message.slice(i, stop + 1);
      i = stop;
      continue;
    }
    if (ch === "<") {
      const end = message.indexOf(">", i);
      if (end !== -1) { out += message.slice(i, end + 1); i = end; continue; }
    }
    if (ch === "{") { depth++; out += ch; continue; }
    if (ch === "}") { depth = Math.max(0, depth - 1); out += ch; continue; }
    if (depth % 2 === 1) { out += ch; continue; }
    if (/[A-Za-z]/.test(ch)) letters++;
    out += ACCENTS[ch] ?? ch;
  }
  const pad = "~".repeat(Math.max(1, Math.round(letters * 0.4)));
  return `[${out} ${pad}]`;
}

function mapStrings(messages, fn) {
  const out = {};
  for (const [key, value] of Object.entries(messages)) out[key] = typeof value === "string" ? fn(value) : isPlainObject(value) ? mapStrings(value, fn) : value;
  return out;
}

const loaded = new Map();

/** The full message tree for a locale (English under a translation; accented English for en-XA). */
function loadMessages(locale) {
  let messages = loaded.get(locale);
  if (messages) return messages;
  const english = readMessageFile("en");
  if (locale === PSEUDO_LOCALE) messages = mapStrings(english, pseudoLocalize);
  else if (locale === "en") messages = english;
  else messages = overlay(english, readMessageFile(locale));
  loaded.set(locale, messages);
  return messages;
}

function lookup(messages, key) {
  let node = messages;
  for (const part of key.split(".")) {
    if (!isPlainObject(node) || !(part in node)) return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** The language ICU rules (plurals, number formats) come from: en-XA is English. */
function formattingLocale(locale) {
  return locale === PSEUDO_LOCALE ? "en" : locale;
}

let activeLocale = "en";
const compiled = new Map();

function setLocale(locale) {
  activeLocale = typeof locale === "string" && locale ? locale : "en";
}

function getLocale() {
  return activeLocale;
}

/**
 * The message for a dotted key ("electron.main.fileMenu") in the active locale, with ICU arguments filled in.
 * A key nobody defined returns the key itself; a message that cannot be formatted returns its raw text.
 */
function t(key, values) {
  const message = lookup(loadMessages(activeLocale), key);
  if (message === undefined) return key;
  if (!values && !/[{<]/.test(message)) return message;
  const cacheKey = `${activeLocale}\u0000${key}`;
  try {
    let format = compiled.get(cacheKey);
    if (!format) {
      const Formatter = formatterClass();
      format = new Formatter(message, formattingLocale(activeLocale));
      compiled.set(cacheKey, format);
    }
    const result = format.format(values ?? {});
    return Array.isArray(result) ? result.join("") : String(result);
  } catch (error) {
    console.error(`Could not format message ${key} (${activeLocale}): ${error.message}`);
    return message;
  }
}

/**
 * The messages the Preferences window needs: its namespace parsed into ICU syntax trees, so the page can format
 * plurals and selects without bundling a parser. A message with no ICU syntax is sent as its plain string.
 */
function setupPayload(namespace = "electron.setup") {
  const locale = activeLocale;
  let node = loadMessages(locale);
  for (const part of namespace.split(".")) node = isPlainObject(node) ? node[part] : undefined;
  const messages = {};
  if (isPlainObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value !== "string") continue;
      if (!/[{<]/.test(value)) { messages[key] = value; continue; }
      try {
        const ast = new (formatterClass())(value, formattingLocale(locale)).getAst();
        messages[key] = ast.length === 1 && ast[0].type === 0 ? ast[0].value : ast;
      } catch (error) {
        console.error(`Could not parse message ${namespace}.${key} (${locale}): ${error.message}`);
        messages[key] = value;
      }
    }
  }
  // The page also checks error text coming back from main (see setup.html), so it gets the plain strings of the
  // namespaces whose errors it recognises, as "main:<key>", "preferencesIo:<key>", "quickPrompts:<key>".
  for (const name of ["main", "preferencesIo", "quickPrompts"]) {
    let errors = loadMessages(locale);
    for (const part of ["electron", name]) errors = isPlainObject(errors) ? errors[part] : undefined;
    if (isPlainObject(errors)) for (const [key, value] of Object.entries(errors)) if (typeof value === "string" && !/[{<]/.test(value)) messages[`${name}:${key}`] = value;
  }
  return { locale, formattingLocale: formattingLocale(locale), messages };
}

module.exports = { PSEUDO_LOCALE, MESSAGES_DIRECTORY, setLocale, getLocale, t, setupPayload, loadMessages, pseudoLocalize };
