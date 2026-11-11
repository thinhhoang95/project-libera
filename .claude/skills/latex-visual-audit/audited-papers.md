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
