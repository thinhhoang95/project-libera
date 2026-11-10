import { readGroup, readOptional, TEX_GROUPS } from "../../macros/core";
import type { LatexMacro, XparseArgument } from "./definitions";

/* Commands that packages define and the Visual mode cannot read from their
 * .sty files (they are not in the project): written here as the macros they
 * act as, for the reader to add where the document loads the package. Only
 * what they draw is kept; a use in a form not written here stays source. */

export type PackageMacro = Pick<LatexMacro, "name" | "arity" | "optional" | "spec" | "body" | "mathOnly"> & {
  /** Replaces an earlier definition of the name (`\renewcommand`, xparse's `\DeclareDocumentCommand`); else the package's `\newcommand` leaves it. */
  replaces?: boolean;
};

const S: XparseArgument = { type: "s" };
const M: XparseArgument = { type: "m" };
const O: XparseArgument = { type: "o" };
const G: XparseArgument = { type: "g" };

/** complexity.sty's classes written as their names (`\NP` is NP), in both modes; then those of its full mode (the default). */
const COMPLEXITY_CLASSES = "L P S AC ACC AH AL coAM AM AP BH BPE BPEE BPP coBPP BPSPACE BPTIME BQP BQTIME cc C CFL CH CSIZE DET DSPACE DTIME DTISP E EE EESPACE EEXP EH EEE EPTAS ESPACE EXP EXPSPACE FNL FNP FP FPRAS FQMA GA Gap GapAC GapL GapP GI Heur HSPACE HeurBPP HeurBPTIME IP K KT LIN LogFew LogFewNL MA coMA MAC mAL MaxNP MaxPB MaxSNP MinPB MIP mL mNC mNL mNP ModP mP MP MPC mTC NC coNE NE NEE NEEE NEEXP coNEXP NEXP coNL NL NLIN coNP NP NPC NPI NPSPACE coNQP NQP NSPACE NTIME Opt PAC PCD PCP PH PEXP PL PP PPSPACE p Promise PromiseBPP PromiseBQP PromiseP PromiseRP PrSPACE PSPACE PT PTAS QAC QACC QAM QCFL QCMA QH QIP QMA QMAM QMIP QNC QP QPSPACE R coRE RE REG RL coRNC RNC coRP RP RSPACE SAC SC SE SEH SKC SIZE SPACE SL coSL SPARSE SPL SPP SUBEXP SZK TC coUP UP W ZPE ZPP ZPTIME";
const COMPLEXITY_FULL_CLASSES = "A AlgP Amp AmpMP AmpPBQP APP APX AuxPDA AVBPP AvE AvP AW AWPP BP BPL BPQP BQNC BQNP CLOG CNP cofrIP Coh compIP compNP coUCC CP CSL CZK D DCFL DiffAC DisNP DistNP DP DQP Dyn EL ELEMENTARY EQP EQTIME EQBP ExistsBPP ExistsNISZK FBQP Few FewP FH FO FOLL FPR FPT FPTAS frIP G GC GCSL GPCD HVSZK IC IPP LOGCFL LOGNP LOGSNP LWPP M NAuxPDA NIPZK NIQPZK NIQSZK NISZK NLOG NPMV NPO NPOPB NPSV NT OBDD OCQ PBP PermUP PF PFCHK PhP PINC PIO PKC PLL PLS PODN polyL PostBQP PPA PPAD PPADS PPP PQUERY PR promiseBPP promiseBQP promiseP promiseRP PSK PTAPE PZK QPLIN Qpoly QSZK RevSPACE RNP RPP SAPTIME SBP Sel SelfNP SF SLICEWISEPSPACE SNP SP symP TALLY TFNP ThC TreeBQP UAP UCC UL UE US VNC VNP VP VQP WAPP WPP XP YACC";
/** complexity.sty's font options, by name (`classfont=roman`, or `roman` for every kind). */
const COMPLEXITY_FONTS: Record<string, string> = { sanserif: "\\mathsf", roman: "\\mathrm", bold: "\\mathbf", typewriter: "\\mathtt", italic: "\\mathit", caps: "\\textsc", slant: "\\textit" };

/**
 * The complexity package (Larrauri & Živný's `\NP`-hard): classes in sans serif, also in text (`\ensuremath`), and
 * `\P`, `\L`, `\S` as classes, not ¶, Ł and § (unless `disableredefinitions`).
 */
function complexityMacros(options: readonly string[]): PackageMacro[] {
  let classFont = "\\mathsf";
  let langFont = "\\mathsf";
  let funcFont = "\\mathsf";
  for (const option of options) {
    const [kind, value] = option.includes("=") ? option.split("=").map((part) => part.trim()) : ["", option];
    const font = COMPLEXITY_FONTS[value];
    if (!font) continue;
    if (kind === "" || kind === "classfont") classFont = font;
    if (kind === "" || kind === "langfont") langFont = font;
    if (kind === "" || kind === "funcfont") funcFont = font;
  }
  const macros: PackageMacro[] = [];
  const add = (name: string, body: string, arity = 0, replaces = false) => macros.push({ name, arity, body: `\\ensuremath{${body}}`, replaces });
  const keep = options.includes("disableredefinitions");
  for (const name of `${COMPLEXITY_CLASSES}${options.includes("basic") ? "" : ` ${COMPLEXITY_FULL_CLASSES}`}`.split(" ")) {
    if (keep && (name === "P" || name === "L" || name === "S")) continue;
    add(name, `${classFont}{${name}}`, 0, name === "P" || name === "L" || name === "S");
  }
  for (const name of ["L", "P", "S"]) add(`c${name}`, `${classFont}{${name}}`);
  add("class", `${classFont}{#1}`, 1);
  add("lang", `${langFont}{#1}`, 1);
  add("func", `${funcFont}{#1}`, 1);
  add("co", `${classFont}{co}#1`, 1);
  for (const name of ["poly", "polylog", "qpoly", "qlog", "MOD", "Mod"]) add(name, `${funcFont}{${name}}`);
  add("llog", `${funcFont}{log}`);
  for (const name of ["CVP", "SAT", "MaxSAT"]) add(name, `${langFont}{${name}}`);
  add("Ppoly", `${classFont}{P}/${funcFont}{poly}`);
  add("parity", "\\oplus");
  return macros;
}

/** A physics bracket sized to its content, or at normal size starred (`\abs*{x}`): its macro with a star and the content. */
function physicsBraces(name: string, left: string, right: string): PackageMacro {
  return { name, arity: 2, spec: [S, M], body: `\\IfBooleanTF{#1}{${left}{#2}${right}}{\\left${left}{#2}\\right${right}}`, mathOnly: true, replaces: true };
}

/**
 * The physics package (2511.16492's `\abs`, 2410.03413's `\ket`): its brackets, Dirac notation, derivatives, vector and
 * operator commands, in math. physics redefines `\div` as the divergence and `\Re`, `\Im` as operators, so those are
 * written only when it is loaded. Forms that read delimiters (`\qty(…)`, `\mqty[…]`) are left to math-render.ts.
 */
function physicsMacros(options: readonly string[]): PackageMacro[] {
  const d = options.includes("italicdiff") ? "d" : "\\mathrm{d}";
  const nabla = options.includes("arrowdel") ? "\\vec{\\boldsymbol{\\nabla}}" : "\\boldsymbol{\\nabla}";
  const macros: PackageMacro[] = [];
  const add = (name: string, spec: XparseArgument[], body: string) => macros.push({ name, arity: spec.length, ...(spec.length ? { spec } : {}), body, mathOnly: true, replaces: true });
  for (const name of ["qty", "quantity"]) add(name, [], "\\physics@qty");
  for (const name of ["mqty", "matrixquantity"]) add(name, [], "\\physics@mqty");
  for (const name of ["smqty", "smallmatrixquantity"]) add(name, [], "\\physics@smqty");
  macros.push(physicsBraces("pqty", "(", ")"), physicsBraces("bqty", "[", "]"), physicsBraces("Bqty", "\\{", "\\}"), physicsBraces("vqty", "\\lvert", "\\rvert"));
  macros.push(physicsBraces("abs", "\\lvert", "\\rvert"), physicsBraces("absolutevalue", "\\lvert", "\\rvert"), physicsBraces("norm", "\\lVert", "\\rVert"));
  for (const [name, env] of [["pmqty", "pmatrix"], ["bmqty", "bmatrix"], ["vmqty", "vmatrix"], ["mdet", "vmatrix"]]) add(name, [M], `\\begin{${env}}#1\\end{${env}}`);
  add("order", [S, M], "\\mathcal{O}\\IfBooleanTF{#1}{(#2)}{\\left(#2\\right)}");
  for (const [names, left, right] of [[["comm", "commutator"], "[", "]"], [["acomm", "acommutator", "anticommutator", "pb", "poissonbracket"], "\\{", "\\}"]] as const) {
    for (const name of names) add(name, [S, M, M], `\\IfBooleanTF{#1}{${left}#2,#3${right}}{\\left${left}#2,#3\\right${right}}`);
  }
  // Vectors and vector calculus.
  for (const name of ["vb", "vectorbold"]) add(name, [S, M], "\\IfBooleanTF{#1}{\\boldsymbol{#2}}{\\mathbf{#2}}");
  for (const name of ["va", "vectorarrow"]) add(name, [S, M], "\\IfBooleanTF{#1}{\\vec{\\boldsymbol{#2}}}{\\vec{\\mathbf{#2}}}");
  for (const name of ["vu", "vectorunit"]) add(name, [S, M], "\\IfBooleanTF{#1}{\\boldsymbol{\\hat{#2}}}{\\mathbf{\\hat{#2}}}");
  for (const name of ["vdot", "dotproduct"]) add(name, [], "\\boldsymbol{\\cdot}");
  for (const name of ["cross", "cp", "crossproduct"]) add(name, [], "\\boldsymbol{\\times}");
  add("vnabla", [], nabla);
  for (const name of ["grad", "gradient"]) add(name, [], nabla);
  for (const name of ["div", "divergence"]) add(name, [], `${nabla}\\boldsymbol{\\cdot}`);
  add("curl", [], `${nabla}\\boldsymbol{\\times}`);
  add("laplacian", [], "\\nabla^2");
  // Operators: `\Tr[\rho]` and `\tr{A}` with their brackets sized.
  for (const [names, text] of [[["tr", "trace"], "tr"], [["Tr", "Trace"], "Tr"], [["Res", "Residue"], "Res"]] as const) {
    for (const name of names) add(name, [G, O], `\\operatorname{${text}}\\IfNoValueF{#1}{\\left\\{#1\\right\\}}\\IfNoValueF{#2}{\\left[#2\\right]}`);
  }
  for (const name of ["rank", "erf"]) add(name, [], `\\operatorname{${name}}`);
  for (const name of ["Re", "Im"]) add(name, [G], `\\operatorname{${name}}\\IfNoValueF{#1}{\\left\\{#1\\right\\}}`);
  // Derivatives: `\dv{x}`, `\dv{f}{x}`, `\dv[n]{f}{x}`, `\pdv{f}{x}{y}`, and starred as flat fractions.
  const derivative = (symbol: string, partial: boolean) => {
    const power = "\\IfNoValueF{#2}{^{#2}}";
    const fraction = (numerator: string, denominator: string) => `\\IfBooleanF{#1}{\\frac}{${numerator}}\\IfBooleanT{#1}{/}{${denominator}}`;
    const single = `\\IfNoValueTF{#4}{${fraction(`${symbol}${power}`, `${symbol} #3${power}`)}}{${fraction(`${symbol}${power} #3`, `${symbol} #4${power}`)}}`;
    return partial ? `\\IfNoValueTF{#5}{${single}}{${fraction(`${symbol}^2 #3`, `${symbol} #4 ${symbol} #5`)}}` : single;
  };
  for (const name of ["dv", "derivative"]) add(name, [S, O, M, G], derivative(d, false));
  for (const name of ["pdv", "partialderivative", "pderivative"]) add(name, [S, O, M, G, G], derivative("\\partial", true));
  for (const name of ["fdv", "functionalderivative", "fderivative"]) add(name, [S, O, M, G], derivative("\\delta", false));
  for (const [names, symbol] of [[["dd", "differential"], d], [["var", "variation"], "\\delta"]] as const) {
    for (const name of names) add(name, [O, G], `\\IfNoValueTF{#2}{${symbol}\\IfNoValueF{#1}{^{#1}}}{\\mathinner{${symbol}\\IfNoValueF{#1}{^{#1}}#2}}`);
  }
  // Dirac notation. `\bra{a}\ket{b}` is one bracket (math-render.ts joins the two at their markers).
  add("bra", [S, M], "\\IfBooleanTF{#1}{\\langle{#2}\\rvert}{\\left\\langle{#2}\\right\\rvert}\\physics@bra");
  add("ket", [S, M], "\\physics@ket\\IfBooleanTF{#1}{\\lvert{#2}\\rangle}{\\left\\lvert{#2}\\right\\rangle}");
  for (const name of ["braket", "innerproduct", "ip"]) add(name, [S, M, G], "\\IfBooleanTF{#1}{\\langle{#2}\\vert{\\IfNoValueTF{#3}{#2}{#3}}\\rangle}{\\left\\langle{#2}\\middle\\vert{\\IfNoValueTF{#3}{#2}{#3}}\\right\\rangle}");
  for (const name of ["ketbra", "dyad", "op", "outerproduct"]) add(name, [S, M, G], "\\IfBooleanTF{#1}{\\lvert{#2}\\rangle\\!\\langle{\\IfNoValueTF{#3}{#2}{#3}}\\rvert}{\\left\\lvert{#2}\\middle\\rangle\\!\\middle\\langle{\\IfNoValueTF{#3}{#2}{#3}}\\right\\rvert}");
  for (const name of ["expval", "ev", "expectationvalue"]) add(name, [S, S, M, G], "\\IfNoValueTF{#4}{\\left\\langle{#3}\\right\\rangle}{\\left\\langle{#4}\\middle\\vert{#3}\\middle\\vert{#4}\\right\\rangle}");
  for (const name of ["mel", "matrixel", "matrixelement"]) add(name, [S, S, M, M, M], "\\left\\langle{#3}\\middle\\vert{#4}\\middle\\vert{#5}\\right\\rangle");
  // Spaced words: `\qq{text}`, `\qc`, `\qand`.
  for (const name of ["qq", "qqtext"]) add(name, [S, M], "\\IfBooleanF{#1}{\\quad}\\text{#2}\\quad");
  for (const name of ["qc", "qcomma"]) add(name, [], ",\\quad");
  for (const word of ["if", "then", "else", "otherwise", "unless", "given", "using", "assume", "since", "let", "for", "all", "even", "odd", "integer", "and", "or", "as", "in"]) add(`q${word}`, [S], `\\IfBooleanF{#1}{\\quad}\\text{${word}}\\quad`);
  add("qcc", [S], "\\IfBooleanF{#1}{\\quad}\\text{c.c.}\\quad");
  return macros;
}

/**
 * amsthm's end mark (□): `\qed` and `\qedsymbol` (which the document may renew, as `\renewcommand{\qedsymbol}{$\blacksquare$}`),
 * and `\qedhere`, drawn as nothing (the proof's end mark is drawn at `\end{proof}`).
 */
function amsthmMacros(): PackageMacro[] {
  return [
    { name: "qedsymbol", arity: 0, body: "\\ensuremath{\\square}" },
    { name: "openbox", arity: 0, body: "\\ensuremath{\\square}" },
    { name: "qed", arity: 0, body: "\\qedsymbol" },
    { name: "qedhere", arity: 0, body: "" },
  ];
}

/** Past spaces and comments. */
function skipSpace(source: string, at: number) {
  return at + /^(?:\s|%[^\n]*(?:\n|$))*/.exec(source.slice(at))![0].length;
}

/**
 * algorithmicx's block definitions: `\algblockdefx[ON]{Blk}{EndBlk}[1]{#1}{}` (2411.02681), `\algblock[Name]{Start}{End}`
 * and `\algdef{SE}[DOWHILE]{Do}{doWhile}{\algorithmicdo}[1]{\algorithmicwhile\ #1}` (flags S, E or SE), and `\algtext*{End}`
 * (the command draws no line). Each command is a macro writing `\algorithmic@begin{text}` or `\algorithmic@end{text}`,
 * the block's first and last lines for algorithm.ts. Null for the other forms (`\algdef{C}`, `\algtext` with a text),
 * whose commands stay unknown.
 */
export function readAlgorithmBlock(source: string, index: number, command: string, starred: boolean, defined: (name: string) => LatexMacro | null): { end: number; macros: PackageMacro[] } | null {
  let at = skipSpace(source, index);
  const group = () => {
    at = skipSpace(source, at);
    const read = source[at] === "{" ? readGroup(source, at, TEX_GROUPS) : null;
    if (read) at = read.end;
    return read?.content ?? null;
  };
  const optional = () => {
    const before = at;
    at = skipSpace(source, at);
    const read = source[at] === "[" ? readOptional(source, at, TEX_GROUPS) : null;
    if (read) at = read.end; else at = before;
    return read?.content ?? null;
  };
  const commandName = (text: string | null) => (text === null ? null : /^\s*\\?([A-Za-z@]+)\s*$/.exec(text)?.[1] ?? null);
  if (command === "algtext") {
    const name = commandName(group());
    const macro = name ? defined(name) : null;
    const marker = macro && /^\\algorithmic@(begin|end)\{/.exec(macro.body)?.[1];
    if (!starred || !name || !macro || !marker) return null;
    return { end: at, macros: [{ name, arity: macro.arity, optional: macro.optional, body: `\\algorithmic@${marker}{}` }] };
  }
  const flags = command === "algdef" ? group()?.trim() : "SE";
  if (!flags || !/^(?:SE|S|E)$/.test(flags)) return null;
  optional();
  const names = [...flags].map(() => commandName(group()));
  if (names.some((name) => !name)) return null;
  const macros: PackageMacro[] = [];
  for (const [n, flag] of [...flags].entries()) {
    const count = command === "algblock" ? null : optional();
    const fallback = count !== null ? optional() : null;
    const text = command === "algblock" ? `\\textbf{${names[n]}}` : group();
    if (text === null || (count !== null && !/^\s*\d\s*$/.test(count))) return null;
    const arity = count === null ? 0 : Number(count);
    macros.push({ name: names[n]!, arity, ...(fallback !== null && arity ? { optional: fallback } : {}), body: `\\algorithmic@${flag === "S" ? "begin" : "end"}{${text}}` });
  }
  return { end: at, macros };
}

/** The macros package `name` defines (with the options it was loaded with), or none. */
export function packageMacros(name: string, options: readonly string[]): PackageMacro[] {
  if (name === "complexity") return complexityMacros(options);
  if (name === "physics") return physicsMacros(options);
  if (name === "amsthm") return amsthmMacros();
  return [];
}
