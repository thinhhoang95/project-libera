// Server-side only: imported from src/i18n/request.ts. Client components get messages through the provider.
import type { AbstractIntlMessages } from "next-intl";
import en from "../../../messages/en.json";
import { PSEUDO_LOCALE, type AppLocale } from "./locales";

type Messages = AbstractIntlMessages;

/** Translation over English: keys a translation lacks fall back to the English message. */
function overlay(base: Messages, top: Messages): Messages {
  const out: Messages = { ...base };
  for (const [key, value] of Object.entries(top)) {
    const under = base[key];
    out[key] = value && typeof value === "object" && under && typeof under === "object" ? overlay(under, value) : value;
  }
  return out;
}

const ACCENTS: Record<string, string> = {
  a: "à", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "î", j: "ĵ", k: "ķ", l: "ļ", m: "ɱ",
  n: "ñ", o: "ö", p: "þ", r: "ŕ", s: "š", t: "ţ", u: "û", w: "ŵ", y: "ý", z: "ž",
  A: "Å", C: "Ç", D: "Ð", E: "É", G: "Ĝ", I: "Î", L: "Ļ", N: "Ñ", O: "Ö", S: "Š", U: "Û", Y: "Ý", Z: "Ž",
};

/**
 * Accent the literal text of an ICU message and pad it, leaving {arguments}, plural/select keywords,
 * <tags> and '-quoted text untouched.
 */
export function pseudoLocalize(message: string): string {
  let out = "";
  let depth = 0; // inside {…}: argument names and keywords until the first nested { (branch text)
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
    // Odd depth = argument head ("count, plural, one "); even depth = text (top level or inside a branch).
    if (depth % 2 === 1) { out += ch; continue; }
    if (/[A-Za-z]/.test(ch)) letters++;
    out += ACCENTS[ch] ?? ch;
  }
  const pad = "~".repeat(Math.max(1, Math.round(letters * 0.4)));
  return `[${out} ${pad}]`;
}

function mapStrings(messages: Messages, fn: (value: string) => string): Messages {
  return Object.fromEntries(
    Object.entries(messages).map(([key, value]) => [key, typeof value === "string" ? fn(value) : mapStrings(value, fn)]),
  );
}

let pseudo: Messages | undefined;

export async function loadMessages(locale: AppLocale): Promise<Messages> {
  if (locale === "en") return en;
  if (locale === PSEUDO_LOCALE) return (pseudo ??= mapStrings(en, pseudoLocalize));
  const translated = (await import(`../../../messages/${locale}.json`)).default as Messages;
  return overlay(en, translated);
}
