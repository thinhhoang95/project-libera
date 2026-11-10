import { readGroup, readOptional, TEX_GROUPS } from "../../../macros/core";

/* siunitx's numbers and units (`\SI{12.5}{\kilo\meter\per\second}`, `\num{1.5e3}`, `\qty`, `\unit`, `\ang`, ranges and
 * lists), written as a formula KaTeX draws: the number as siunitx prints it by default (an exponent as `× 10ⁿ`, `+-` as
 * ±, long digit runs grouped), a thin space, then the units upright with their prefixes and powers (`\per` as a negative
 * power, siunitx's default). A command with a unit, prefix or number form not written here is not read (null): it stays
 * source. Options are not applied, except `per-mode=symbol` and `per-mode=fraction`. */

const PREFIXES: Record<string, string> = {
  quecto: "q", ronto: "r", yocto: "y", zepto: "z", atto: "a", femto: "f", pico: "p", nano: "n", micro: "\\text{µ}", milli: "m", centi: "c", deci: "d",
  deca: "da", deka: "da", hecto: "h", kilo: "k", mega: "M", giga: "G", tera: "T", peta: "P", exa: "E", zetta: "Z", yotta: "Y", ronna: "R", quetta: "Q",
  kibi: "Ki", mebi: "Mi", gibi: "Gi", tebi: "Ti", pebi: "Pi", exbi: "Ei",
};

/** Units by command: their symbol (letters are set upright). */
const UNITS: Record<string, string> = {
  ampere: "A", candela: "cd", kelvin: "K", kilogram: "kg", gram: "g", metre: "m", meter: "m", mole: "mol", second: "s", becquerel: "Bq",
  degreeCelsius: "{}^{\\circ}\\mathrm{C}", celsius: "{}^{\\circ}\\mathrm{C}", coulomb: "C", farad: "F", gray: "Gy", hertz: "Hz", henry: "H", joule: "J",
  katal: "kat", lumen: "lm", lux: "lx", newton: "N", ohm: "\\Omega", pascal: "Pa", radian: "rad", siemens: "S", sievert: "Sv", steradian: "sr",
  tesla: "T", volt: "V", watt: "W", weber: "Wb", day: "d", hectare: "ha", hour: "h", litre: "L", liter: "L", minute: "min", tonne: "t",
  astronomicalunit: "au", dalton: "Da", electronvolt: "eV", bel: "B", decibel: "dB", neper: "Np", bar: "bar", barn: "b", angstrom: "\\text{Å}",
  knot: "kn", mmHg: "mmHg", percent: "\\%", byte: "B", bit: "bit", atomicmassunit: "u", arcminute: "'", arcsecond: "''", arcmin: "'", arcsec: "''",
  degree: "{}^{\\circ}", micron: "\\text{µ}\\mathrm{m}", gauss: "G", erg: "erg", parsec: "pc", lightyear: "ly", year: "yr", calorie: "cal",
};
/** Units set right after the number, without the thin space (siunitx's angles). */
const CLOSE_UNITS = new Set(["degree", "arcminute", "arcsecond", "arcmin", "arcsec"]);

/** A unit symbol's LaTeX: letters upright. */
function symbolLatex(symbol: string) {
  return /^[A-Za-z]+$/.test(symbol) ? `\\mathrm{${symbol}}` : symbol;
}

type Unit = { latex: string; power: string | null; per: boolean; close: boolean };

/** The units of a `\si{…}` argument, as a formula; null for a form not written here. */
export function siunitxUnits(text: string, perMode = "power"): { latex: string; close: boolean } | null {
  const units: Unit[] = [];
  let prefix = "";
  let per = false;
  let power: string | null = null;
  let literal = "";
  let i = 0;
  const readArgument = () => {
    while (/\s/.test(text[i] ?? "")) i++;
    const group = text[i] === "{" ? readGroup(text, i, TEX_GROUPS) : null;
    if (group) { i = group.end; return group.content.trim(); }
    const char = text[i];
    if (char && /[\w+-]/.test(char)) { i++; return char; }
    return null;
  };
  while (i < text.length) {
    const char = text[i];
    if (/\s|~/.test(char)) { i++; continue; }
    if (char === "\\") {
      const name = /^\\([A-Za-z]+)/.exec(text.slice(i))?.[1];
      if (!name) {
        if (text[i + 1] === "%") { literal += "\\%"; i += 2; continue; }
        return null;
      }
      i += name.length + 1;
      if (name in PREFIXES) { prefix += PREFIXES[name]; continue; }
      if (name === "per") { per = true; continue; }
      if (name === "square") { power = "2"; continue; }
      if (name === "cubic") { power = "3"; continue; }
      if (name === "raiseto") { const value = readArgument(); if (value === null) return null; power = value; continue; }
      const last = units[units.length - 1];
      if (name === "squared" || name === "cubed" || name === "tothe") {
        const value = name === "squared" ? "2" : name === "cubed" ? "3" : readArgument();
        if (!last || value === null) return null;
        last.power = value;
        continue;
      }
      if (!(name in UNITS)) return null;
      const prefixLatex = prefix ? (/^[A-Za-z]+$/.test(prefix) ? `\\mathrm{${prefix}}` : prefix) : "";
      units.push({ latex: `${prefixLatex}${symbolLatex(UNITS[name])}`, power, per, close: CLOSE_UNITS.has(name) && !prefix });
      prefix = "";
      per = false;
      power = null;
      continue;
    }
    if (prefix || per || power !== null) return null;
    // A literal unit (`\si{km/s}`, `\unit{kg.m^2}`): letters upright, `.` a product, `/` a slash, `^` and `_` scripts.
    const run = /^[A-Za-z]+/.exec(text.slice(i))?.[0];
    if (run) { literal += `\\mathrm{${run}}`; i += run.length; continue; }
    if (char === ".") { literal += "\\,"; i++; continue; }
    if (char === "/" || char === "(" || char === ")" || /\d|-/.test(char)) { literal += char; i++; continue; }
    if (char === "^" || char === "_") {
      i++;
      const value = readArgument();
      if (value === null || !/^[\w+-]+$/.test(value)) return null;
      literal += `${char}{${char === "_" ? `\\mathrm{${value}}` : value}}`;
      continue;
    }
    return null;
  }
  if (prefix || per || power !== null) return null;
  if (literal && units.length) return null;
  if (literal) return { latex: literal, close: false };
  if (!units.length) return null;
  const scripted = (unit: Unit, negative: boolean) => {
    const value = negative ? (unit.power ? `-${unit.power}` : "-1") : unit.power;
    return value ? `${unit.latex}^{${value}}` : unit.latex;
  };
  let latex: string;
  if (perMode === "symbol" || perMode === "fraction") {
    const top = units.filter((unit) => !unit.per).map((unit) => scripted(unit, false)).join("\\,");
    const bottom = units.filter((unit) => unit.per).map((unit) => scripted(unit, false)).join("\\,");
    latex = !bottom ? top : perMode === "fraction" ? `\\frac{${top || "1"}}{${bottom}}` : `${top || "1"}/${units.filter((unit) => unit.per).length > 1 ? `(${bottom})` : bottom}`;
  } else latex = units.map((unit) => scripted(unit, unit.per)).join("\\,");
  return { latex, close: units.length === 1 && units[0].close && !units[0].power };
}

/** Digits grouped in threes with thin spaces, as siunitx does for five digits or more. */
function grouped(digits: string, fromLeft: boolean) {
  if (digits.length < 5) return digits;
  const parts: string[] = [];
  if (fromLeft) for (let at = 0; at < digits.length; at += 3) parts.push(digits.slice(at, at + 3));
  else for (let at = digits.length; at > 0; at -= 3) parts.unshift(digits.slice(Math.max(0, at - 3), at));
  return parts.join("\\,");
}

/** A real number (`-1.5e3`, `.5`, `1,2`, `1.23(4)`), as a formula; null for anything else. */
function realNumber(text: string): string | null {
  const match = /^([+-]?)(\d*)(?:[.,](\d*))?(?:\((\d+)\))?(?:[eEdD]([+-]?\d+))?$/.exec(text);
  if (!match) return null;
  const [, sign, whole, fraction, uncertainty, exponent] = match;
  if (!whole && !fraction && exponent === undefined) return null;
  let mantissa = whole || fraction !== undefined ? `${grouped(whole || "0", false)}${fraction !== undefined ? `.${grouped(fraction, true)}` : ""}` : "";
  if (uncertainty) mantissa += `(${uncertainty})`;
  const power = exponent === undefined ? "" : `10^{${exponent.replace(/^\+/, "")}}`;
  const body = mantissa && power ? `${mantissa}\\times ${power}` : mantissa || power;
  return `${sign === "-" ? "-" : sign === "+" ? "+" : ""}${body}`;
}

/** A siunitx number: real numbers with `+-` (or `\pm`) uncertainties and `x` (or `\times`) products. */
export function siunitxNumber(text: string): string | null {
  const factors = text.replace(/\s+/g, "").split(/x|\\times/);
  const out: string[] = [];
  for (const factor of factors) {
    const parts = factor.split(/\+-|\\pm/);
    if (parts.length > 2) return null;
    const value = parts[0] ? realNumber(parts[0]) : "";
    const error = parts.length === 2 ? realNumber(parts[1]) : null;
    if (value === null || (parts.length === 2 && error === null) || (!value && parts.length < 2)) return null;
    // `1.5+-0.1e3`: the exponent applies to both (siunitx moves it out): written as read, the value then ± the error.
    out.push(parts.length === 2 ? `${value}\\pm ${error}` : value);
  }
  return out.join("\\times ");
}

const COMMAND = /^\\(SI|si|num|qty|unit|ang|SIrange|numrange|qtyrange|SIlist|numlist|qtylist|degree|celsius|micro|percent)(?![A-Za-z@])/;

/** A siunitx command at `at` in `source` (at its backslash), as a formula and where it ends; null when not one read here. */
export function readSiunitx(source: string, at: number): { latex: string; end: number } | null {
  const match = COMMAND.exec(source.slice(at, at + 12));
  if (!match) return null;
  const command = match[1];
  let i = at + match[0].length;
  const skip = () => { while (/\s/.test(source[i] ?? "")) i++; };
  const optional = () => {
    const before = i;
    skip();
    const read = source[i] === "[" ? readOptional(source, i, TEX_GROUPS) : null;
    if (read) { i = read.end; return read.content; }
    i = before;
    return null;
  };
  const group = () => {
    skip();
    const read = source[i] === "{" ? readGroup(source, i, TEX_GROUPS) : null;
    if (read) i = read.end;
    return read?.content ?? null;
  };
  // Units used on their own in a formula: `\degree`, `\celsius`, `\micro`, `\percent`.
  if (command === "degree") return { latex: "{}^{\\circ}", end: i };
  if (command === "celsius") return { latex: "{}^{\\circ}\\mathrm{C}", end: i };
  if (command === "micro") return { latex: "\\text{µ}", end: i };
  if (command === "percent") return { latex: "\\%", end: i };
  const options = optional() ?? "";
  const perMode = /per-mode\s*=\s*(symbol|fraction)/.exec(options)?.[1] ?? "power";
  const units = (text: string | null) => (text === null ? null : siunitxUnits(text, perMode));
  const quantity = (number: string, unit: { latex: string; close: boolean }) => `${number}${unit.close ? "" : "\\,"}${unit.latex}`;
  if (command === "num") {
    const number = group();
    const latex = number === null ? null : siunitxNumber(number);
    return latex === null ? null : { latex, end: i };
  }
  if (command === "si" || command === "unit") {
    const unit = units(group());
    return unit ? { latex: unit.latex, end: i } : null;
  }
  if (command === "ang") {
    const text = group();
    if (text === null) return null;
    const parts = text.split(";").map((part) => part.trim());
    if (parts.length > 3) return null;
    const marks = ["^{\\circ}", "'", "''"];
    const out: string[] = [];
    for (const [index, part] of parts.entries()) {
      if (!part) continue;
      const number = siunitxNumber(part);
      if (number === null) return null;
      out.push(`${number}${marks[index]}`);
    }
    return out.length ? { latex: out.join(""), end: i } : null;
  }
  if (command === "SI" || command === "qty") {
    const number = group();
    const pre = command === "SI" ? optional() : null;
    const unit = units(group());
    const value = number === null ? null : siunitxNumber(number);
    const before = pre === null ? "" : units(pre)?.latex;
    if (value === null || !unit || before === undefined || before === null) return null;
    return { latex: `${before ? `${before}\\,` : ""}${quantity(value, unit)}`, end: i };
  }
  const ranged = command.endsWith("range");
  const first = group();
  const second = ranged ? group() : null;
  const withUnit = command.startsWith("SI") || command.startsWith("qty");
  const unit = withUnit ? units(group()) : null;
  if (first === null || (ranged && second === null) || (withUnit && !unit)) return null;
  const values = (ranged ? [first, second!] : first.split(";")).map((part) => siunitxNumber(part.trim()));
  if (values.some((value) => value === null)) return null;
  const items = values.map((value) => (unit ? quantity(value!, unit) : value!));
  if (ranged) return { latex: `${items[0]}\\text{ to }${items[1]}`, end: i };
  const latex = items.length === 1 ? items[0] : `${items.slice(0, -1).join("\\text{, }")}\\text{${items.length > 2 ? "," : ""} and }${items[items.length - 1]}`;
  return { latex, end: i };
}

/** The siunitx commands drawn in running text (as a small formula). */
export const SIUNITX_TEXT = /^\\(?:SI|si|num|qty|unit|ang|SIrange|numrange|qtyrange|SIlist|numlist|qtylist|degree|celsius|micro|percent)$/;

const SIUNITX_IN_MATH =/\\(?:SI|si|num|qty|unit|ang|SIrange|numrange|qtyrange|SIlist|numlist|qtylist|degree|celsius|micro|percent)(?![A-Za-z@])/;

/** A formula with the siunitx commands it reads written out; the ones it cannot read are left (KaTeX then fails on them). */
export function siunitxForKatex(latex: string) {
  if (!SIUNITX_IN_MATH.test(latex)) return latex;
  let out = "";
  let at = 0;
  for (let i = latex.indexOf("\\"); i >= 0 && i < latex.length; i = latex.indexOf("\\", i)) {
    const read = readSiunitx(latex, i);
    if (read) {
      out += `${latex.slice(at, i)}{${read.latex}}`;
      at = i = read.end;
      continue;
    }
    // A control symbol (`\\`, `\{`) is skipped whole.
    const name = /^\\[A-Za-z@]*/.exec(latex.slice(i, i + 64))![0];
    i += name.length > 1 ? name.length : 2;
  }
  return out + latex.slice(at);
}
