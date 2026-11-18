// Check messages/<locale>.json files against messages/en.json.
//   node scripts/i18n/check-messages.mjs            -> check en, then every other locale
//   node scripts/i18n/check-messages.mjs fr         -> check en and fr only
// Every message must parse as ICU (with rich-text tags). Each translation must have the same keys as English,
// the same arguments (name and kind), and the same rich-text tags. Exit code 1 if anything is wrong.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, TYPE } from "@formatjs/icu-messageformat-parser";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dir = path.join(root, "messages");

function flatten(obj, prefix = "", out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

const KIND = { [TYPE.argument]: "argument", [TYPE.number]: "number", [TYPE.date]: "date", [TYPE.time]: "time", [TYPE.select]: "select", [TYPE.plural]: "plural" };

// Collect "name:kind" for arguments and "<tag>" for tags, walking into plural/select branches.
function shape(ast, out = new Set()) {
  for (const el of ast) {
    if (KIND[el.type]) out.add(`${el.value}:${el.type === TYPE.plural && el.pluralType === "ordinal" ? "selectordinal" : KIND[el.type]}`);
    if (el.type === TYPE.tag) { out.add(`<${el.value}>`); shape(el.children, out); }
    if (el.options) for (const opt of Object.values(el.options)) shape(opt.value, out);
  }
  return out;
}

function load(locale) {
  return flatten(JSON.parse(fs.readFileSync(path.join(dir, `${locale}.json`), "utf8")));
}

const problems = [];
const shapes = new Map();
const en = load("en");
for (const [key, value] of en) {
  if (typeof value !== "string") { problems.push(`en ${key}: not a string`); continue; }
  try { shapes.set(key, shape(parse(value))); } catch (e) { problems.push(`en ${key}: ${e.message} — ${JSON.stringify(value)}`); }
}

const wanted = process.argv.slice(2);
const locales = wanted.length ? wanted : fs.readdirSync(dir).filter((f) => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f) && f !== "en.json").map((f) => f.slice(0, -5));
const summary = { en: en.size };
for (const locale of locales) {
  const tr = load(locale);
  let missing = 0;
  for (const key of en.keys()) if (!tr.has(key)) missing++;
  for (const [key, value] of tr) {
    if (!en.has(key)) { problems.push(`${locale} ${key}: not in en.json`); continue; }
    if (typeof value !== "string") { problems.push(`${locale} ${key}: not a string`); continue; }
    let got;
    try { got = shape(parse(value)); } catch (e) { problems.push(`${locale} ${key}: ${e.message} — ${JSON.stringify(value)}`); continue; }
    const want = shapes.get(key);
    if (!want) continue;
    const a = [...want].filter((x) => !got.has(x)), b = [...got].filter((x) => !want.has(x));
    if (a.length || b.length) problems.push(`${locale} ${key}: ${a.length ? `missing ${a.join(", ")}` : ""}${a.length && b.length ? "; " : ""}${b.length ? `unexpected ${b.join(", ")}` : ""}`);
  }
  summary[locale] = `${tr.size} keys, ${missing} missing`;
}

for (const p of problems) console.log(p);
console.log(JSON.stringify(summary), `${problems.length} problem(s)`);
process.exit(problems.length ? 1 : 0);
