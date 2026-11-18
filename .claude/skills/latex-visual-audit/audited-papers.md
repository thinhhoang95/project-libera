# Papers already audited in the LaTeX Visual mode

Passed to `fetch --exclude` so a new round picks new papers. Add each round's ids here.

## 2026-11-10, round 1 (36 papers, docs/audits/2026-11-10-latex-visual-paper-review.md)

1803.09015 1812.09970 2005.11710 2203.00671 1706.03762 2108.12419 1610.01271 1608.04644 1411.1607 2105.10386
2002.05709 1912.02762 1606.04838 2404.19590 2102.00618
2403.17206 2303.10367 1909.11219 2403.00471 2301.08083
1709.01953 2403.14606 2012.07805 2304.03442 1610.05820 1703.06907
2405.14734 2310.11511 2401.10891 2403.03507 2308.14508
2402.08434 2411.02681 2410.03413 2204.14024 2511.16492

## 2026-11-10, round 2 (12 papers, by category)

| Category | Id | Notes |
|---|---|---|
| quant-ph | 2611.11568 | JHEP style, slashed, `\ooalign` overlay macro |
| hep-th | 2611.10539 | revtex, `ruledtabular` |
| astro-ph.GA | 2611.08676 | aastex7: deluxetable, `\plottwo`, orcid authors, commented `\begin{document}` |
| math.AG | 2611.08810 | amsart, cite notes with font switches |
| math.CO | 2611.11191 | user theorem wrapper with `\ref` name, math `array` with booktabs |
| stat.ME | 2611.09678 | `\tbl{caption}{tabular}` macro, 16 table files |
| cs.LO | 2610.41832 | Cambridge JFP class, lhs2TeX (`\ensuremath`, hscode) |
| cond-mat.str-el | 2611.08102 | revtex `widetext`, supplementary numbering |
| math.PR | 2611.09890 | multi-file, clean |
| cs.CL | 2611.11838 | ACL, linguex, minipage figures |
| cs.DS | 2611.09172 | acmart, algorithm2e with user keywords, mleftright; main file in a subfolder (00README.json) |
| q-bio.NC | 2610.36484 | `\newif` switch, highlight macro around `\paragraph` |

## 2026-11-11, round 3 (12 papers, docs/audits/2026-11-11-latex-visual-paper-review-3.md)

| Category | Id | Notes |
|---|---|---|
| quant-ph | 2611.10887 | revtex, `\onecolumngrid` |
| hep-th | 2611.09538 | `\newtcolorbox` box, adjustbox, main file named by 00README toplevel |
| astro-ph.GA | 2611.07227 | A&A class, natbib notes with `\citealt` and formulas, `list`, table fragments |
| math.AG | 2611.06861 | xymatrix, tikzcd, TikZ pictures with `\foreach`, `\arraystretch` in math |
| math.CO | 2611.10154 | `\includepdf` |
| stat.ME | 2611.07519 | verbatim with `$` (R code), 2 files |
| cs.LO | 2610.39746 | `\Needspace` |
| cond-mat.str-el | 2611.06541 | revtex `\onecolumngrid` |
| math.PR | 2611.08611 | preamble-heavy, TikZ |
| cs.CL | 2611.11316 | 73 files, IEEEtran, lrbox/`\counterwithin` |
| cs.DS | 2611.07622 | BibTeX alpha `\etalchar` labels |
| q-bio.NC | 2610.30364 | `\url{\repourl}`, footnotetext with `\thefootnote` |

## 2026-11-11, round 4 (12 papers, docs/audits/2026-11-11-latex-visual-paper-review-4.md)

| Category | arXiv id | Notable |
|---|---|---|
| quant-ph | 2611.13347 | amsart + `subfiles` sections, local `stylesheet.sty` macros |
| hep-th | 2611.12698 | `jheppub` front matter |
| astro-ph.GA | 2611.10419 | MNRAS template |
| math.AG | 2611.12008 | amsart, long single file |
| math.CO | 2611.13390 | `\def\set#1:#2`, `\accentset`, enumitem math labels |
| stat.ME | 2611.11188 | pasted natbib `.bbl`, hand-rolled supplement title block |
| cs.LO | 2611.01825 | `arxiv.sty` `\keywords`, `.bbl` boilerplate |
| cond-mat.str-el | 2611.09434 | revtex, eqnarray in `widetext`, `\acknowledgments` |
| math.PR | 2611.11388 | `\let\c@lemmaL\c@theorem`, row-helper macros in a table fragment |
| cs.CL | 2611.13560 | MLSys class, `\twocolumn[{…}]`, 50 files |
| cs.DS | 2611.10440 | longtables with 25 KB of macro expansion |
| q-bio.NC | 2610.40511 | ICLR 2027 |

## 2026-11-12, round 5 (20 papers, docs/audits/2026-11-12-latex-visual-paper-review-5.md)

| Category | arXiv id | Notable |
|---|---|---|
| math.NT | 2611.11566 | `\DeclareMathSymbol{\Sha}`, `\hyperref` in math |
| math.AP | 2611.12463 | `\tag{\textbf{i}}` refs |
| math.OC | 2611.12757 | IEEEojcsys front matter, `$…\)` |
| math.ST | 2611.09087 | `\printbibliography` |
| math.DG | 2611.11400 | enumitem `label=\textup{(\roman*)}`, `\href` with a line break |
| math.NA | 2611.11466 | siamart predefined theorems, `AMS` |
| cs.CC | 2611.07413 | llncs, zref-clever `\zcsetup`, `\newtcolorbox` with counters, body `\newenvironment` |
| cs.PL | 2610.37006 | LMCS, `\def\+Bound`, `\mbox{\sc …}` in math |
| cs.CR | 2611.11859 | `\mathpalette`/`\ooalign`, 28 files |
| cs.DB | 2611.03327 | clean |
| cs.GT | 2611.05777 | TikZ inside body `\newcommand`, `reptheorem`, thm-restate |
| cs.SE | 2611.12982 | `\numberwithin{table}{section}` |
| cs.LG | 2611.14059 | jmlr `\tableref`, `\ifmlhdemo` |
| stat.ML | 2611.11460 | NeurIPS, 31 files, `hypbox` |
| cs.CV | 2611.13868 | IEEEtran biographies |
| cs.AI | 2611.13971 | Elsevier CAS front matter |
| econ.TH | 2611.01431 | INFORMS `APPENDICES`, `\prettyref` |
| econ.EM | 2610.41963 | clean |
| econ.GN | 2610.39843 | clean |
| q-fin.MF | 2610.16732 | macros from a body `\input` |

Skipped: cs.SE 2611.11216 (PDF only), econ.GN 2610.39844 (too small).

## 2026-11-12, round 6 (50 papers, docs/audits/2026-11-12-latex-visual-paper-review-6.md)

- cs.AI: 2611.13960 2611.13966
- cs.CC: 2611.04680 2611.04776
- cs.CR: 2611.10776 2611.10830
- cs.CV: 2611.13849 2611.13851
- cs.DB: 2610.38404 2610.38605
- cs.DS: 2611.10283 2611.10293
- cs.GT: 2611.05705 2611.05706
- cs.IT: 2611.09184 2611.09366
- cs.LG: 2611.14035 2611.14046
- cs.PL: 2610.26599 2610.28682
- cs.SE: 2611.11192 2611.11213
- econ.EM: 2610.41722 2610.41881
- econ.GN: 2610.39097 2610.39375
- econ.TH: 2611.01195 2611.05417
- math.AP: 2611.11530 2611.11553
- math.CO: 2611.12329 2611.12330
- math.DG: 2611.09689 2611.09697
- math.FA: 2611.07728 2611.07785
- math.NA: 2611.09574 2611.09593
- math.NT: 2611.09681 2611.09711
- math.OC: 2611.12089 2611.12134
- math.PR: 2611.09811 2611.10139
- math.ST: 2611.04598 2611.04705
- q-fin.MF: 2610.13543 2610.14524
- stat.ML: 2611.11386 2611.11387

Notable: math.DG 2611.09697 (`\def` with `&` and `\\` parameters swallowed the file), cs.IT 2611.09366 (Pandoc/Quarto output),
cs.PL 2610.26599 (etoolbox text macros, 54 files), math.AP 2611.11553 (`\m@th`), math.NA 2611.09593 (SIAM shared preamble),
stat.ML 2611.11386 (macro debris in captions). Skipped: math.ST 2611.04612 (PDF only).

## 2026-11-15, round 7 (51 papers, docs/audits/2026-11-15-latex-visual-paper-review-7.md)

- cond-mat.mes-hall: 2611.13157 2611.13235
- cond-mat.mtrl-sci: 2611.14782 2611.14809
- cond-mat.stat-mech: 2611.13526 2611.14576
- cs.LG: 2611.16789 2611.16792 2611.16803
- eess.SY: 2611.15142 2611.15162
- hep-ph: 2611.15628 2611.15647
- hep-th: 2611.15749
- math-ph: 2611.15209 2611.15304
- math.AP: 2611.14951 2611.14954
- math.CA: 2611.08401 2611.08653
- math.DS: 2611.13265 2611.13277
- math.GT: 2611.08002 2611.08165
- math.NA: 2611.13952 2611.14041
- math.OC: 2611.14966 2611.15035 2611.15055
- math.PR: 2611.15177 2611.15228
- math.RT: 2611.12492 2611.13050
- math.ST: 2611.11872 2611.11874
- physics.flu-dyn: 2611.12045 2611.12193
- physics.optics: 2611.13800 2611.13936
- quant-ph: 2611.16456 2611.16474 2611.16479
- stat.AP: 2611.10325 2611.10515
- stat.CO: 2611.01271 2611.01752
- stat.ME: 2611.14011 2611.14598
- stat.ML: 2611.13647 2611.13765 2611.14586

Notable: math.AP 2611.14954 (`\chardef` switch and `\hbox{#1}` macros with `$` hid every display), math.PR 2611.15228
(`\MoveEqLeft`, `equ`, `\burlalt`), siunitx abbreviations and `\DeclareSIUnit` (cond-mat.mes-hall 2611.13235,
physics.flu-dyn 2611.12193), math.ST 2611.11874 (a user `parts` list). Fetched but lost before the audit, not audited:
gr-qc 2611.15331 2611.15321, nucl-th 2611.10816 2611.10465.

## 2026-11-17, round 8 (48 papers, docs/audits/2026-11-17-latex-visual-paper-review-8.md)

- cond-mat.soft: 2611.14722 2611.18737
- cond-mat.str-el: 2611.17871 2611.17927
- cs.CL: 2611.20755 2611.20759
- cs.DS: 2611.16966 2611.17050
- cs.LG: 2611.21215 2611.21216
- cs.LO: 2611.10810 2611.10842
- cs.NI: 2611.13759 2611.13943
- cs.RO: 2611.20185 2611.20202
- econ.EM: 2611.06067 2611.06266
- econ.GN: 2611.02033 2611.02533
- econ.TH: 2611.05701 2611.05708
- gr-qc: 2611.18558 2611.18827
- hep-lat: 2611.09817 2611.09865
- math.AG: 2611.18317 2611.18357
- math.CT: 2611.03204 2611.03553
- math.GR: 2611.13956 2611.14085
- math.LO: 2611.11828 2611.11911
- math.OA: 2611.08419 2611.08668
- nucl-th: 2611.13953 2611.13954
- physics.chem-ph: 2611.14372 2611.14377
- physics.plasm-ph: 2611.11227 2611.11343
- q-bio.NC: 2611.07214 2611.07809
- q-bio.PE: 2610.35161 2610.38374
- stat.ML: 2611.18367 2611.18394

Notable: math.LO 2611.11828 (137 quiver tikz-cd diagrams), cs.NI 2611.13943 (sn-jnl inline bbl with `\ifx…\undefined\def` fallbacks),
cond-mat.str-el 2611.17927 (REVTeX 4.2 inline bbl), math.OA 2611.08668 (inline `theindex`, `\index` with `\ref`), math.CT 2611.03553
(`\usebox` arrows, its own `\lean` mark). q-bio.QM was asked for but the arXiv listing came back empty (rate limit); none audited.

## 2026-11-18, round 9 (23 papers, docs/audits/2026-11-18-latex-visual-paper-review-9.md)

- astro-ph.CO: 2611.17552 2611.17676
- astro-ph.EP: 2611.16040 2611.16046
- astro-ph.HE: 2611.20738 2611.21043
- astro-ph.SR: 2611.19134 2611.19628
- cs.DC: 2611.16180 2611.16219
- cs.HC: 2611.21095 2611.21155
- eess.SP: 2611.19192 2611.19238
- hep-ex: 2611.16397 2611.16454
- math.CV: 2611.13409 2611.13725
- math.MG: 2611.13338
- math.QA: 2611.13129 2611.13239
- physics.comp-ph: 2611.19014 2611.19128

Notable: hep-ex 2611.16454 (ATLAS: 15 collaboration style files with kvoptions booleans, `\AtlasOrcid` in the class, 2887 authors),
astro-ph.SR 2611.19628 (AASTeX 7 authors in an `\input` file, footnotes inside `\citep` notes), astro-ph.HE 2611.21043 (REVTeX
bbl with `\natexlab`), math.QA 2611.13129 (`\mathchar'26` barred d), eess.SP 2611.19192 (user environments wrapping floats).
50 were asked for; arXiv's listing API hung and 14 small categories came back empty (see the write-up).
