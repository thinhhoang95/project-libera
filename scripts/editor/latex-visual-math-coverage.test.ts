import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { katexForEnvironment, renderKatex } from "../../src/lib/latex/codemirror/visual/math-render";
import { bracketDelimitersForKatex, mathtoolsEnvironmentsForKatex, tensorForKatex } from "../../src/lib/latex/codemirror/visual/math-coverage";
import { expandLatexMacros } from "../../src/lib/latex/macros/expand";
import { readLatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* A sweep of commonly used math LaTeX through the pipeline the editor uses (macro expansion, then KaTeX as in
 * math-render.ts): every snippet is drawn whole (no KaTeX error, no part of it left as source), except the few listed
 * in STAYS_SOURCE, which have no faithful drawing: the Visual mode shows their source. One snippet per line.
 * Set COVERAGE_REPORT=1 to list the snippets that are not drawn instead of failing on the first group. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

/** A formula as the Visual mode draws it (macros expanded, then KaTeX); null when it stays source. */
function drawn(preamble: string, formula: string, display = false) {
  const defs = readLatexDefinitions(`${preamble}\n\\begin{document}\\end{document}`);
  const expanded = expandLatexMacros(formula, defs, { mode: "math", pos: 0 });
  return expanded.ok ? renderKatex(expanded.text, display) : null;
}

const whole = (html: string | null): html is string => html !== null && !html.includes("cm-vis-math-source") && !html.includes("katex-error");
const report = process.env.COVERAGE_REPORT === "1";
const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);

/** Asserts that none of `formulas` (one per line) fails to be drawn whole. */
function checked(preamble: string, text: string, display = false) {
  const gaps = lines(text).filter((formula) => !whole(drawn(preamble, formula, display)));
  if (!report) assert.deepEqual(gaps, []);
  else for (const gap of gaps) for (const part of gap.split(/(?<=[}\]\w)]) (?=\\[A-Za-z])/)) if (!whole(drawn(preamble, part, display))) console.log("GAP", part);
}

/** Symbols and commands (space separated), each as `x … y`, so relations, operators and arrows have their sides. */
function symbols(preamble: string, text: string) {
  checked(preamble, text.split(/\s+/).filter(Boolean).map((token) => `x ${token} y`).join("\n"));
}

/** A display through the editor's environment handling (katexForEnvironment): drawn whole. */
function environment(preamble: string, env: string, body: string) {
  const ok = whole(drawn(preamble, katexForEnvironment(env, body).latex, true));
  if (report && !ok) console.log("GAP", env, body);
  else assert.ok(ok, `${env}: ${body}`);
}

/** What these snippets have no faithful drawing for: they stay source (also in the editor), never drawn wrongly. */
function staysSource(preamble: string, text: string) {
  for (const formula of lines(text)) assert.ok(!whole(drawn(preamble, formula)), `drawn although it has no faithful drawing: ${formula}`);
}

const AMS = "\\usepackage{amsmath,amssymb,amsfonts}";
const STMARY = `${AMS}\\usepackage{stmaryrd}`;

test("Greek, Hebrew and letter-like symbols", () => {
  symbols(AMS, String.raw`\varepsilon \vartheta \varpi \varrho \varsigma \varphi \varkappa \digamma \Bbbk \hbar \hslash \ell \wp \Re \Im \aleph \beth \gimel \daleth \mho \eth \imath \jmath \Finv \Game`);
  symbols(AMS, String.raw`\varGamma \varDelta \varTheta \varLambda \varXi \varPi \varSigma \varUpsilon \varPhi \varPsi \varOmega`);
  symbols(AMS, String.raw`\partial \nabla \infty \emptyset \varnothing \complement \nexists \exists \forall \angle \measuredangle \sphericalangle \backprime \prime \bigstar \blacksquare \square \Box \Diamond \lozenge \blacklozenge \checkmark \maltese \circledS \diagup \diagdown`);
});

test("relations and binary operators of amsmath, amssymb and mathtools", () => {
  symbols(AMS, String.raw`\nleq \ngeq \lesssim \gtrsim \lessgtr \gtrless \preceq \succcurlyeq \sqsubseteq \sqsupseteq \Vdash \vDash \nvdash \nvDash \Vvdash \ll \gg \lll \ggg \lnsim \gnsim \lneqq \gneqq \precnsim \succnsim \nless \ngtr \nprec \nsucc \subsetneq \supsetneq \nsubseteq \nsupseteq \Subset \Supset \sqcup \sqcap`);
  symbols(AMS, String.raw`\boxtimes \boxplus \boxminus \boxdot \ltimes \rtimes \rightthreetimes \leftthreetimes \wr \amalg \triangleq \bowtie \Join \divideontimes \dotplus \circledast \circledcirc \circleddash \pm \mp \setminus \smallsetminus \ast \star \circ \bullet \diamond \triangleleft \triangleright \oslash \ominus \uplus \barwedge \veebar \curlywedge \curlyvee`);
  symbols(AMS, String.raw`\simeq \approxeq \thickapprox \thicksim \backsim \eqsim \cong \ncong \propto \varpropto \asymp \shortmid \shortparallel \between \pitchfork \vartriangleleft \vartriangleright \trianglelefteq \trianglerighteq \blacktriangleleft \blacktriangleright \blacktriangle \blacktriangledown \triangle \vartriangle \triangledown`);
  symbols(AMS, String.raw`\varsubsetneq \varsupsetneq \varsubsetneqq \varsupsetneqq \subsetneqq \supsetneqq \subseteqq \supseteqq \nsubseteqq \nsupseteqq \eqslantless \eqslantgtr \leqslant \geqslant \nleqslant \ngeqslant \leqq \geqq \nleqq \ngeqq`);
  symbols(AMS, String.raw`\precsim \succsim \precapprox \succapprox \preccurlyeq \curlyeqprec \curlyeqsucc \lessapprox \gtrapprox \lessdot \gtrdot \doteq \doteqdot \risingdotseq \fallingdotseq \circeq \bumpeq \Bumpeq \therefore \because`);
  symbols(AMS, String.raw`\bot \top \vdash \dashv \models \perp \mid \parallel \vee \wedge \cup \cap \in \ni \owns \subset \supset \subseteq \supseteq \sqsubset \sqsupset \cdot \times \div \otimes \oplus \odot \bigcirc \dagger \ddagger \S \P \copyright \pounds \yen \ne \neq \nmid \nparallel \nsim \notin`);
  symbols(`${AMS}\\usepackage{mathtools}`, String.raw`\coloneqq \eqqcolon \defeq \coloneq \Coloneqq \eqcolon \colonapprox \vcentcolon \Coloneq \Eqqcolon \colonsim \dblcolon`);
  checked(AMS, String.raw`
    a \not\in b
    a \not= b
    a \not\subset b
    a \not\equiv b
    a \not\leq b
    a \not\sim b
    a \not\ni b
    a \mathrel{\mathop{=}\limits^{\mathrm{def}}} b
  `);
});

test("arrows of amssymb, amsmath and stmaryrd", () => {
  symbols(AMS, String.raw`\rightleftharpoons \leadsto \hookrightarrow \hookleftarrow \twoheadrightarrow \rightsquigarrow \longmapsto \mapsto \Longleftrightarrow \longleftrightarrow \Longrightarrow \Longleftarrow \implies \impliedby \iff \to \gets`);
  symbols(AMS, String.raw`\leftrightsquigarrow \looparrowright \looparrowleft \curvearrowright \curvearrowleft \circlearrowleft \circlearrowright \upuparrows \downdownarrows \leftleftarrows \rightrightarrows \rightleftarrows \leftrightarrows \Rrightarrow \Lleftarrow \nrightarrow \nleftarrow \nRightarrow \nLeftarrow \nleftrightarrow \nLeftrightarrow`);
  symbols(AMS, String.raw`\nearrow \searrow \nwarrow \swarrow \updownarrow \Updownarrow \uparrow \downarrow \Uparrow \Downarrow \Rightarrow \Leftarrow \Leftrightarrow \leftrightarrow \leftarrow \rightarrow \longrightarrow \longleftarrow`);
  symbols(AMS, String.raw`\rightharpoonup \rightharpoondown \leftharpoonup \leftharpoondown \leftrightharpoons \upharpoonright \upharpoonleft \downharpoonright \downharpoonleft \twoheadleftarrow \rightarrowtail \leftarrowtail \multimap \restriction \dashrightarrow \dashleftarrow \Lsh \Rsh`);
  // stmaryrd's operators and arrows.
  symbols(STMARY, String.raw`\mapsfrom \Mapsto \Mapsfrom \longmapsfrom \Longmapsto \shortrightarrow \shortleftarrow \shortuparrow \shortdownarrow \varoast \varobar \varocircle \varodot \varominus \varoplus \varoslash \varotimes \varbigcirc \fatsemi \fatbslash \binampersand \bindnasrepma \talloblong \trianglelefteqslant \trianglerighteqslant \boxbslash \boxslash \boxast \boxcircle \boxdot \varcurlywedge \varcurlyvee \sslash \interleave \oslash \bigtriangleup \bigtriangledown \lightning`);
});

test("brackets and delimiters, in every size", () => {
  symbols(AMS, String.raw`\lvert \rvert \lVert \rVert \lceil \rceil \lfloor \rfloor \langle \rangle \lbrace \rbrace \ulcorner \urcorner \llcorner \lrcorner \vert \Vert \| \{ \} \backslash \lbrack \rbrack \lgroup \rgroup \lmoustache \rmoustache`);
  symbols(STMARY, String.raw`\llbracket \rrbracket \llparenthesis \rrparenthesis \lBrace \rBrace \lAngle \rAngle \Lbag \Rbag`);
  checked(AMS, String.raw`
    \left\langle a \middle| b \right\rangle
    \bigl( x \bigr) \Bigl( x \Bigr) \biggl( x \biggr) \Biggl( x \Biggr)
    \bigl\lvert x \bigr\rvert \Bigl\| x \Bigr\| \bigl\{ x \bigr\} \Bigl\langle x \Bigr\rangle \biggl\lVert x \biggr\rVert
    \left\lfloor \frac{a}{b} \right\rfloor \left. x \right|_0^1 \left\| x \right\| \left\lvert x \right\rvert \left\{ x \right.
    \big| x \Big| \bigg| \Bigg| \bigm| \Bigm| \biggm| \Biggm|
    \left( \frac{a}{b} \middle/ c \right)
    \left\lceil x \right\rceil
    \left\lgroup x \right\rgroup
    \left[ x \right) \left( x \right] \left] x \right[
    \left\langle \frac{a}{b} \middle\vert c \middle\| d \right\rangle
  `);
  checked(STMARY, String.raw`
    \bigl\llbracket x \bigr\rrbracket
    \left\llbracket x \right\rrbracket
    \Bigl\llbracket x \Bigr\rrbracket
    \llbracket f \rrbracket(x)
  `);
});

test("big operators, integrals and dots", () => {
  symbols(AMS, String.raw`\bigoplus \bigotimes \bigsqcup \biguplus \coprod \bigodot \bigvee \bigwedge \bigcup \bigcap \sum \prod \int \iint \iiint \oint \oiint \oiiint \varointclockwise \ointctrclockwise \intop \smallint \iiiint \idotsint \bigsqcap \bigtimes`);
  checked(AMS, String.raw`
    \bigoplus_{i=1}^n A_i
    \bigotimes\nolimits_i A_i
    \sum\limits_{i} a_i
    \int\limits_0^1 f
    \oint_{C} f
    \iint_{D} f \,dA
    \iiint_{V} f \,dV
    \oiint_{\partial S} \mathbf{F}\cdot d\mathbf{S}
    \varointclockwise_C f
    \coprod_{i\in I} X_i
    \biguplus_{i} A_i
    \bigsqcup_{i} A_i
  `);
  symbols(AMS, String.raw`\dotsb \dotsc \dotsm \dotsi \dotso \ldots \cdots \vdots \ddots \iddots \mathellipsis \dots \hdots \cdotp \ldotp \colon`);
});

test("amsmath and mathtools display environments", () => {
  const rows = "a &= b \\\\ c &= d";
  const lined = "a = b \\\\ c = d";
  for (const env of ["align", "align*", "flalign", "flalign*", "eqnarray", "eqnarray*"]) environment(AMS, env, rows);
  for (const env of ["gather", "gather*", "multline", "multline*"]) environment(AMS, env, lined);
  environment(AMS, "alignat", "{2}\na &= b & c &= d \\\\ e &= f & g &= h");
  environment(AMS, "alignat*", "{2}\na &= b & c &= d");
  checked(AMS, String.raw`
    \begin{aligned} a &= b \\ c &= d \end{aligned}
    \begin{aligned}[t] a &= b \\ c &= d \end{aligned}
    \begin{alignedat}{2} a &= b & c &= d \\ e &= f & g &= h \end{alignedat}
    \begin{gathered} a \\ b \end{gathered}
    \begin{split} a &= b \\ &= c \end{split}
    f(x) = \begin{cases} 1 & x > 0 \\ 0 & \text{otherwise} \end{cases}
    \begin{matrix} a & b \\ c & d \end{matrix}
    \begin{pmatrix} a & b \\ c & d \end{pmatrix}
    \begin{bmatrix} a \end{bmatrix}
    \begin{Bmatrix} a \end{Bmatrix}
    \begin{vmatrix} a & b \\ c & d \end{vmatrix}
    \begin{Vmatrix} a \end{Vmatrix}
    \begin{smallmatrix} a & b \\ c & d \end{smallmatrix}
    \sum_{\substack{i < n \\ j < m}} a_{ij}
    \sum_{\begin{subarray}{l} i < n \\ j < m \end{subarray}} a_{ij}
    \begin{array}{c|c} a & b \\ \hline c & d \end{array}
  `, true);
  checked(`${AMS}\\usepackage{mathtools}`, String.raw`
    \begin{dcases} 1 & x>0 \\ 0 & x\le 0 \end{dcases}
    \begin{rcases} a & b \\ c & d \end{rcases}
    \begin{drcases} a & b \end{drcases}
    \begin{dcases*} 1 & if $x>0$ \\ 0 & otherwise \end{dcases*}
    \begin{cases*} 1 & if $x>0$ \end{cases*}
    \begin{pmatrix*}[r] 1 & -2 \\ 3 & 4 \end{pmatrix*}
    \begin{bmatrix*}[l] a \end{bmatrix*}
    \begin{psmallmatrix} a & b \end{psmallmatrix}
    \begin{bsmallmatrix} a & b \end{bsmallmatrix}
    \begin{matrix*}[c] a \end{matrix*}
    \begin{multlined} a \\ b \end{multlined}
    \begin{multlined}[t] a \\ b \end{multlined}
    \begin{lgathered} a \\ b \end{lgathered}
    \begin{rgathered} a \\ b \end{rgathered}
  `, true);
  // Numbers and annotations in rows.
  for (const body of ["a &= b \\tag{1a} \\\\ c &= d \\notag", "a &= b \\nonumber \\\\ c &= d \\tag*{(*)}", "a &= b \\\\ \\intertext{where} c &= d", "a &= b \\\\ \\shortintertext{and} c &= d", "a &= b \\label{x} \\\\ c &= d \\notag"]) environment(AMS, "align", body);
  for (const [env, body] of [["equation", "a = b \\tag{x}"], ["equation", "a = b \\tag*{x}"], ["equation", "a = b \\nonumber"], ["equation", "a = b \\notag"], ["equation*", "a = b"], ["displaymath", "a = b"]]) environment(AMS, env, body);
});

test("stacked relations, labelled arrows, braces, accents", () => {
  checked(AMS, String.raw`
    A \xrightarrow[below]{above} B
    A \xleftarrow{f} B
    A \xrightarrow{f} B
    A \xrightarrow[g]{} B
    A \xleftrightarrow{f} B
    A \xRightarrow{f} B
    A \xLeftarrow{f} B
    A \xhookrightarrow{f} B
    A \xmapsto{f} B
    A \xtwoheadrightarrow{f} B
    A \xrightleftharpoons{f} B
    A \xleftrightarrow[x]{y} B
    A \xlongequal{f} B
    A \xLeftrightarrow{f} B
    \overset{a}{=} \underset{b}{=} \stackrel{c}{=} \overset{!}{=} \stackrel{\text{def}}{=} \overset{\mathrm{def}}{:=} \underset{x\to 0}{\lim} \overset{*}{\to}
    \underbrace{a+b}_{n}
    \overbrace{a+b}^{n}
    \underbrace{a+b}_{n}^{m}
    \overbrace{a+b}^{n}_{m}
    \overbracket{a+b}^{n}
    \underbracket{a+b}_{n}
    \overbracket[1pt]{a}
    \underbracket[1pt][2pt]{a}
    \underline{a} \overline{a+b} \overline{\overline{a}} \underline{\underline{a}}
    \widehat{xyz} \widetilde{xyz} \overrightarrow{AB} \overleftarrow{AB} \overleftrightarrow{AB} \underrightarrow{AB} \underleftarrow{AB} \underleftrightarrow{AB}
    \vec{v} \dot{x} \ddot{x} \dddot{x} \ddddot{x} \mathring{A} \hat{a} \check{a} \tilde{a} \acute{a} \grave{a} \breve{a} \bar{a} \widecheck{ab}
    \utilde{a}
    \utilde{abc}
    \overgroup{AB} \undergroup{AB} \overlinesegment{AB} \overleftharpoon{AB} \overrightharpoon{AB} \Overrightarrow{AB}
    \mathring{\mathbf{x}} \hat{\boldsymbol{\theta}} \tilde{\mathcal{A}} \bar{\mathbb{R}} \vec{\mathbf{v}}_i \hat{\mathbf{x}}^T
    \substack{a \\ b}
    \sideset{_a^b}{_c^d}\sum
    \overset{\sim}{=} \stackrel{\sim}{\to} \underset{\sim}{x}
  `);
});

test("font commands, math classes, fractions, roots, limits, styles, phantoms", () => {
  const preamble = `${AMS}\\usepackage{bm,mathrsfs,mathbbm,dsfont,cancel,mathtools,tensor,xcolor}`;
  checked(preamble, String.raw`
    \mathbf{x} \boldsymbol{\alpha} \bm{x} \bm{\alpha} \pmb{x} \pmb{\alpha} \bm{\nabla} \bm{\mu}\bm{\Sigma} \mathbf{\Gamma}
    \mathbb{R} \mathbb{1} \mathbb{E}[X] \mathbbm{1} \mathbbm{R} \mathds{1} \mathds{E} \bbm{R}
    \mathcal{L} \mathscr{L} \mathfrak{g} \mathsf{T} \mathtt{x} \mathrm{d}x \mathit{ab} \mathnormal{a}
    \textrm{ab} \textbf{ab} \textit{ab} \textsf{ab} \texttt{ab} \text{if } x \text{a $x$ b} \text{\textit{a} b} \textnormal{a} \mbox{a} \hbox{a}
    \text{\%} \text{\&} \text{\_} \text{\#} \text{\$} \text{\{} \text{--} \text{---}
    a \mathbin{\star} b \mathrel{R} b \mathop{\mathrm{Tr}} \mathop{\mathrm{argmax}}\limits_x f \mathopen{(} a \mathclose{)} a \mathpunct{,} b \mathord{a} \mathop{a}\nolimits_i \mathinner{a}
    \binom{n}{k} \dbinom{n}{k} \tbinom{n}{k} \binom{n}{k}^2
    \dfrac{a}{b} \tfrac{a}{b} \cfrac{a}{b+\cfrac{c}{d}} \cfrac[l]{a}{b} \cfrac[r]{a}{b}
    \genfrac{(}{)}{0pt}{}{n}{k} \genfrac{}{}{1pt}{0}{a}{b} \genfrac{[}{]}{0pt}{1}{n}{k}
    {a \over b} {n \choose k} {a \atop b} {n \brace k} {n \brack k}
    \sqrt[n]{x} \sqrt[3]{\frac{a}{b}} \sqrt{\sqrt{x}} \sqrt x \surd
    \sum\limits_a^b \sum\nolimits_a^b \int\limits_0^\infty \lim\nolimits_{x \to 0} \operatorname*{argmax}\limits_x \operatorname{sgn}\nolimits_x
    \operatorname{rank}(A) \operatorname*{lim}_{x} \operatorname{Var}[X] \operatorname*{arg\,min}_x f
    \displaystyle \sum_i a_i
    \textstyle \sum_i a_i
    \scriptstyle a \scriptscriptstyle a {\displaystyle \int_0^1 f} \mathchoice{a}{b}{c}{d}
    \smash{\frac{a}{b}} \smash[t]{a} \smash[b]{a}
    \vphantom{\frac{a}{b}} \hphantom{abc} \phantom{abc}
    \mathllap{a} b \mathrlap{c} d \mathclap{e}
    x_{\mathclap{i<j}}
    \cancel{x} \bcancel{x} \xcancel{x} \cancel{\frac{a}{b}}
    \boxed{x=1} \boxed{\frac{a}{b}} \fbox{a} \fcolorbox{red}{white}{a} \colorbox{yellow}{a} \framebox{a} \fbox{$x^2$} \boxed{\text{ab}}
    \color{red} x \textcolor{blue}{x^2} {\color{green} y} \textcolor{red}{\frac{a}{b}} \color[rgb]{1,0,0} a \textcolor[HTML]{00FF00}{a} \textcolor{red!50!blue}{a}
    \prescript{a}{b}{X} \prescript{14}{6}{\mathrm{C}} \prescript{}{n}{X}
    \tensor{T}{^a_b}
    \tensor{T}{^{ab}_{cd}}
    \tensor[^a_b]{T}{^c_d}
    \tensor{R}{^\mu_{\nu\rho\sigma}}
    \tensor{\Gamma}{^\lambda_{\mu\nu}}
    \mod{n} a \pmod{n} a \bmod n \pod{n} a \mod n a \pmod{2^n+1}
    \overline{z} \bar{z} \mathrm{e}^{i\pi} \mathrm{i} \vert x \vert \underline{\mathbf{a}} a\,\mathrm{d}x \mathrm{\,d}
    \not\!\!\ni
  `);
  // Spacing, in each of its forms.
  checked(AMS, String.raw`\hspace{1em}|\hspace*{2pt}|\quad|\qquad|\,|\;|\:|\!|\ |\enspace|\thinspace|\medspace|\thickspace|\negthinspace|\negmedspace|\negthickspace|\kern1pt|\mkern3mu|\mskip3mu|\hskip1em|\space|~|\enskip|\nobreakspace`.split("|").map((space) => `a ${space} b`).join("\n"));
});

test("physics: Dirac notation, brackets, derivatives, vectors, matrices and operators", () => {
  checked("\\usepackage{physics}", String.raw`
    \ket{\psi} \bra{\phi} \braket{\phi}{\psi} \braket{\psi} \ketbra{a}{b} \ketbra{a} \dyad{a} \dyad{a}{b} \ip{a}{b} \op{a}{b} \outerproduct{a}{b}
    \expval{A} \expval{A}{\psi} \ev{H} \ev{H}{\psi} \mel{m}{A}{n} \matrixel{m}{A}{n}
    \abs{x} \abs*{\frac{a}{b}} \norm{x} \norm*{v}
    \qty(a+b) \qty[a+b] \qty{a+b} \qty|a| \qty(\frac{a}{b}) \qty\big(a)
    \dd x \dd[3]{x} \dd{x} \dd{\vb{r}}
    \dv{x} \dv{f}{x} \dv[2]{f}{x} \dv*{f}{x} \pdv{f}{x} \pdv{f}{x}{y} \pdv[2]{f}{x} \pdv*{f}{x}
    \comm{A}{B} \acomm{A}{B} \comm*{A}{B} \pb{f}{g}
    \Tr \Tr[\rho] \tr{A} \trace A \rank A \erf(x)
    \order{x^2} \order*{x}
    \vb{x} \vb*{x} \va{a} \vu{n} \grad f \grad{f} \curl \vb{F} \div \vb{F} \laplacian f \nabla^2 \vdot \cross
    \mqty(a & b \\ c & d) \mqty[a & b \\ c & d] \mqty|a & b \\ c & d| \pmqty{a & b} \bmqty{a & b} \vmqty{a & b} \smqty(a & b) \mqty{a}
    \imat{3} \xmat{x}{2}{2} \zmat{2}{2} \dmat{a,b,c} \admat{a,b}
    \eval{x^2}_0^1 \eval*{f}_a^b \eval(f)|_a^b
    \Re z \Im z \Re{z} \var{x} \var{S} \pv\int f
    \qq{and} \qcomma \qif \qthen \qc
    f \sin x \cos x \tan x \cot x \sec x \csc x \arcsin x \sinh x \det A \gcd(a,b) \max_x f \min_x f \sup_x \inf_x \lim_{x\to 0} \limsup_n \dim V \ker f \deg p \hom(A,B) \Pr(A) \arg z \exp x \ln x \log_2 n \lg n
  `);
});

test("braket: bras, kets, braket and sets", () => {
  checked("\\usepackage{braket}", String.raw`
    \bra{\phi} \ket{\psi} \braket{\phi|\psi} \braket{\phi | \psi | \chi} \Bra{\phi} \Ket{\psi} \Braket{\phi|\psi} \Braket{\phi | \frac{a}{b} | \psi}
    \set{x \in X | x > 0} \Set{x \in X | x > 0} \Set{x | \frac{a}{b} > 0}
    \bra{\psi}A\ket{\psi} \braket{a}
  `);
  // KaTeX defines these itself, so they are drawn with or without the package (as the other KaTeX-native symbols are).
  checked("", String.raw`
    \ket{\psi}
    \braket{a|b}
    \Set{x | x > 0}
  `);
});

test("slashed, mleftright and mathtools' helpers", () => {
  checked(`${AMS}\\usepackage{slashed,mleftright,mathtools,cancel}`, String.raw`
    \slashed{k} \slashed{\partial} \slashed{p}_1 \slashed{D}
    \mleft( x \mright) \mleft[ \frac{a}{b} \mright] \mleft\{ a \mright\} \mleft\langle a \mright\rangle \mleft\lvert x \mright\rvert \mleft( a \middle| b \mright)
    \bigl\lvert x \bigr\rvert
    \smashoperator{\sum_{i=1}^n}
    \smashoperator[r]{\sum_i}
    \underbrace{a}_{\text{n}}
    \prescript{}{a}{b}
    \overbracket{x} \underbracket{x}
  `);
});

const MACROS = String.raw`
\newcommand{\R}{\mathbb{R}}
\newcommand{\N}{\mathbb{N}}
\newcommand{\eps}{\varepsilon}
\renewcommand{\P}{\mathbb{P}}
\newcommand{\Var}{\operatorname{Var}}
\newcommand{\Ex}[1]{\mathbb{E}\left[#1\right]}
\DeclareMathOperator*{\argmin}{arg\,min}
\DeclareMathOperator{\argmax}{arg\,max}
\DeclareMathOperator{\Tr}{Tr}
\DeclareMathOperator*{\esssup}{ess\,sup}
\renewcommand{\vec}[1]{\boldsymbol{#1}}
\def\x#1#2{#1_{#2}}
\def\y#1#2#3{(#1,#2,#3)}
\newcommand{\f}[2][x]{f_{#1}(#2)}
\providecommand{\prov}{p}
\providecommand{\R}{\mathbf{R}}
\newcommand\inner[2]{\langle #1, #2\rangle}
\newcommand{\diff}{\mathop{}\!\mathrm{d}}
\newcommand{\defeq}{\mathrel{\mathop:}=}
\NewDocumentCommand{\g}{m o O{z} s}{g_{#1}\IfValueT{#2}{^{#2}}(#3)\IfBooleanT{#4}{*}}
\NewDocumentCommand{\sset}{m}{\left\{#1\right\}}
\DeclareDocumentCommand{\pr}{ O{} m }{\mathbb{P}_{#1}\left[#2\right]}
\DeclarePairedDelimiter{\abs}{\lvert}{\rvert}
\DeclarePairedDelimiter{\nrm}{\lVert}{\rVert}
\DeclarePairedDelimiter{\ceil}{\lceil}{\rceil}
\let\oldphi\phi
\renewcommand{\phi}{\varphi}
\newcommand{\bigO}[1]{\mathcal{O}\!\left(#1\right)}
\newcommand{\T}{^{\mathsf{T}}}
\newcommand{\norm}[1]{\left\lVert#1\right\rVert}
\newcommand{\indep}{\perp\!\!\!\perp}
\newcommand{\dd}{\mathrm{d}}
\newcommand{\tr}{\operatorname{tr}}
\newcommand{\1}{\mathbf{1}}
\newcommand{\ip}[2]{\left\langle #1, #2 \right\rangle}
\newcommand{\vect}[1]{\mathbf{#1}}
\newcommand{\pa}[1]{\left(#1\right)}
\newcommand{\E}{\mathbb{E}}
`;

test("the document's own macros: arguments, optional arguments, xparse, paired delimiters, operators, \\let", () => {
  checked(MACROS, String.raw`
    x \in \R^n, \N, \eps > 0, \P(A), \Var(X), \Ex{X^2}
    \argmin_x f(x) \quad \argmax_{x \in \R} g(x) \quad \esssup_x |f| \quad \Tr(A)
    \vec{x} \cdot \vec{y} \quad \x{a}{i} \quad \y{1}{2}{3}
    \f{y} \quad \f[t]{y} \quad \prov
    \inner{u}{v} \quad \int f \diff x \quad a \defeq b
    \g{a} \g{a}[b] \g{a}[b][c] \g{a}* \g{a}[b][c]* \sset{x | x > 0} \pr{A} \pr[x]{A}
    \abs{x} \abs*{\frac{a}{b}} \abs[\big]{x} \nrm{v} \nrm*{v} \ceil{x} \ceil*{\frac{a}{b}}
    \oldphi \phi \bigO{n \log n} A\T \X \indep \dd x \tr A \1_A \ip{a}{b} \vect{x} \pa{a+b} \E[X] \norm{x}
  `.replace("\\X ", ""));
  const html = drawn(MACROS, "\\argmin_x f(x)", true)!;
  assert.match(html, /arg/);
  assert.match(html, /op-limits/, "the star form puts its subscript under the operator");
  assert.doesNotMatch(drawn(MACROS, "\\argmax_x f(x)", true)!, /op-limits/);
  // The rewritten \vec is bold, not an arrow.
  assert.match(drawn(MACROS, "\\vec{x}")!, /mathbf|boldsymbol|textbf|mord mathbf|boldsymbol/);
  assert.doesNotMatch(drawn(MACROS, "\\vec{x}")!, /vec-body/);
  // \abs* grows with its content: \left … \right.
  assert.match(drawn(MACROS, "\\abs*{\\frac{a}{b}}")!, /minner|mopen delimcenter|delimsizing/);
});

test("macro hygiene: \\ifmmode, \\ensuremath, \\xspace, \\relax and \\@ifstar never draw junk or throw", () => {
  const preamble = String.raw`
\makeatletter
\newcommand{\vv}{\ifmmode\mathbf{v}\else\textbf{v}\fi}
\newcommand{\nn}{\ensuremath{n}\xspace}
\newcommand{\rx}{\relax x}
\newcommand{\st}{\@ifstar{\stx}{\sty}}
\newcommand{\stx}{a}
\newcommand{\sty}{b}
\newcommand{\opt}{\@ifnextchar[{\opta}{\optb}}
\newcommand{\opta}[1]{#1}
\newcommand{\optb}{b}
\makeatother
\newcommand{\mc}{\mathchar"0141}
\mathchardef\mychar="0141
\DeclareSymbolFont{ams}{U}{msa}{m}{n}
`;
  for (const formula of ["\\vv + 1", "\\nn \\cdot 2", "\\rx", "\\st", "\\st*", "\\opt", "\\opt[a]", "\\mychar", "\\mc"]) {
    const html = drawn(preamble, formula);
    // Drawn whole, or left as source: never the macro's internals as text, never KaTeX's error.
    if (html !== null) {
      assert.ok(whole(html), formula);
      assert.doesNotMatch(html, /ifmmode|ifstar|ifnextchar|@|relax/, formula);
    }
  }
  for (const formula of ["\\vv + 1", "\\nn \\cdot 2", "\\rx"]) assert.ok(whole(drawn(preamble, formula)), formula);
  assert.ok(whole(drawn("\\newcommand{\\E}{\\mathbb{E}}\\newcommand{\\P}[1]{\\mathbb{P}\\left(#1\\right)}", "\\E[X] = \\P{A}")));
  // Unsupported programming never throws.
  for (const body of ["\\expandafter\\def\\csname a\\endcsname{b}", "\\edef\\z{\\the\\count0}", "\\ifx\\a\\b c\\else d\\fi", "\\@namedef{a}{b}"]) {
    assert.doesNotThrow(() => drawn(`\\makeatletter${body}`, "\\z \\a x"), body);
  }
});

test("a macro defined after its use, or inside \\begin{document}, is drawn", () => {
  const view = mounted(`\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nBefore: $\\late{x}$ and $\\R$.\n\\newcommand{\\late}[1]{\\widehat{#1}}\n\\newcommand{\\R}{\\mathbb{R}}\nAfter: $\\late{y}$ and $\\R^n$.\n\\begin{equation}\n\\late{z} \\in \\R\n\\end{equation}\n\\end{document}\n`);
  // The formulas after the definitions are drawn; the earlier uses are as LaTeX would leave them (undefined: source) or drawn.
  assert.ok(view.drawn >= 3, `${view.drawn} formulas drawn`);
  assert.deepEqual(view.sources.filter((source) => /late\{y\}|R\^n|late\{z\}/.test(source ?? "")), []);
});

test("a formula with a user macro stays editable: a click opens its source, an Alt-click puts the cursor in it", async () => {
  const doc = String.raw`\documentclass{article}
\newcommand{\R}{\mathbb{R}}
\begin{document}
Let $x \in \R^n$ be given.
\end{document}
`;
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, doc.indexOf("Let") - 1), parent });
  refreshVisualWidgets(view);
  const formula = view.contentDOM.querySelector(".cm-vis-math");
  assert.ok(formula, "the formula is drawn");
  assert.match(formula.innerHTML, /katex/);
  assert.equal(formula.getAttribute("aria-label"), String.raw`$x \in \R^n$`, "its label is the source, macros unexpanded");
  const click = (init: Record<string, unknown>) => formula.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init }));
  // Alt-click: the cursor goes into the formula, which then shows as source.
  click({ altKey: true });
  const cursor = view.state.selection.main.head;
  assert.ok(cursor > doc.indexOf("$x") && cursor <= doc.indexOf("$ be"), `the cursor is inside the formula (${cursor})`);
  view.destroy();
  parent.remove();
  // A click opens the formula editor on the formula as written (MathLive does not start under jsdom: its source area shows).
  const quiet = console.error;
  console.error = () => {};
  const second = document.createElement("div");
  document.body.append(second);
  const editor = new EditorView({ state: visualState(doc, doc.indexOf("Let") - 1), parent: second });
  refreshVisualWidgets(editor);
  editor.contentDOM.querySelector(".cm-vis-math")!.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  console.error = quiet;
  const area = document.querySelector<HTMLTextAreaElement>(".cm-vis-math-editor .cm-vis-math-source");
  assert.ok(area, "the formula editor is open");
  assert.equal(area.value.trim(), String.raw`x \in \R^n`);
  editor.destroy();
  second.remove();
});

test("what the coverage rewrites write for KaTeX: tensor indices, \\llbracket delimiters, mathtools' cases* and multlined", () => {
  assert.equal(tensorForKatex(String.raw`\tensor{T}{^a_b}`), String.raw`{{T}{}^{a}{}_{b}}`);
  assert.equal(tensorForKatex(String.raw`\tensor[^a_b]{T}{^c_d}`), String.raw`{{}^{a}{}_{b}{T}{}^{c}{}_{d}}`);
  assert.equal(tensorForKatex(String.raw`\tensor{R}{^\mu_{\nu\rho}}`), String.raw`{{R}{}^{\mu}{}_{\nu\rho}}`);
  // An index list it does not read is left, and the formula stays source.
  assert.equal(tensorForKatex(String.raw`\tensor{T}{abc}`), String.raw`\tensor{T}{abc}`);
  assert.equal(bracketDelimitersForKatex(String.raw`\left\llbracket x \right\rrbracket \bigl\llbracket y \bigr\rrbracket`), String.raw`\left[\!\left[ x \right]\!\right] \bigl[\!\bigl[ y \bigr]\!\bigr]`);
  assert.equal(mathtoolsEnvironmentsForKatex(String.raw`\begin{dcases*} 1 & if $x>0$ \\ 0 & otherwise \end{dcases*}`), String.raw`\begin{dcases}1&\text{if $x>0$}\\0&\text{otherwise}\end{dcases}`);
  assert.equal(mathtoolsEnvironmentsForKatex(String.raw`\begin{cases*} a & b \end{cases*}`), String.raw`\begin{cases}\text{a}&\text{b}\end{cases}`);
  assert.equal(mathtoolsEnvironmentsForKatex(String.raw`\begin{lgathered} a \\ bb \end{lgathered}`), String.raw`\begin{aligned}&a\\&bb\end{aligned}`);
  assert.equal(mathtoolsEnvironmentsForKatex(String.raw`\begin{rgathered}[t] a \\ bb \end{rgathered}`), String.raw`\begin{aligned}a&\\bb&\end{aligned}`);
  assert.equal(mathtoolsEnvironmentsForKatex(String.raw`\begin{multlined}[b][5cm] a \\ b \end{multlined}`), String.raw`\begin{gathered}a \\ b \end{gathered}`);
  // A case body with three columns is not one KaTeX can draw: left as it is.
  assert.equal(mathtoolsEnvironmentsForKatex(String.raw`\begin{cases*} a & b & c \end{cases*}`), String.raw`\begin{cases*} a & b & c \end{cases*}`);
  assert.ok(drawn("", String.raw`\tensor{T}{^a_b}`));
  assert.match(drawn("", String.raw`\left\llbracket x \right\rrbracket`)!, /minner[\s\S]*minner/);
  assert.ok(drawn("", String.raw`\defeq`)!.includes("def"));
});

/** Formulas that have no faithful drawing in KaTeX: the Visual mode shows their source. */
test("what has no faithful drawing stays source", () => {
  staysSource(AMS, String.raw`
    \cancelto{0}{x}
    \overarc{AB}
    \rotatebox{90}{a}
    \left\ulcorner x \right\urcorner
  `);
  // stmaryrd's rarer symbols, which have neither a KaTeX symbol nor a Unicode character to stand for them.
  staysSource(STMARY, String.raw`
    a \Yup b
    a \Ydown b
    a \merge b
    a \moo b
    a \leftslice b
    a \rightslice b
    a \subsetplus b
    a \inplus b
    a \nplus b
    a \boxbar b
    \llceil x \rrceil
  `);
});

function visualState(doc: string, anchor = doc.length) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" })] });
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

/** What a mounted Visual mode shows: the formulas drawn and those left as source. */
function mounted(doc: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  const drawnCount = view.contentDOM.querySelectorAll(".cm-vis-math").length;
  const sources = [...view.contentDOM.querySelectorAll(".cm-vis-math-source")].map((node) => node.textContent);
  view.destroy();
  parent.remove();
  return { drawn: drawnCount, sources };
}
