# Energy bench (mains power)

Before: `08e9c0b feat(latex-paste): close the Markdown→LaTeX gaps found in the Visual edi` · After: `2605871 test(editor): bring eleven stale test files up to the current behaviour` · 1 run(s) per version and scenario, alternating versions. Medians; ranges in brackets.

> **Correction (same day):** in these runs every session's server also installed the app's managed
> Python runtime (~570 MB via `uv`), because each run had a fresh config folder and the app sets
> Python up at sign-in. That added about 3 CPU s to the server in every scenario, for both versions,
> and made idle look busy. The bench now installs Python once and shares it. Re-run of idle
> (`2026-11-17-mains-power-idle-rerun.json`): server 0.08 s per minute, Energy Impact about 1,
> all processes about 0.6 CPU s per minute, in both versions.

## idle

| Metric | Before | After | Change |
| --- | --- | --- | --- |
| Energy Impact (avg) | 5.7 [5.2–6.3] | 5.6 [5.0–6.3] | -1% |
| CPU s, all processes | 3.66 [3.30–4.02] | 3.66 [3.18–4.13] | -0% |
| CPU s, renderer | 0.35 [0.32–0.39] | 0.32 [0.28–0.37] | -9% |
| CPU s, GPU | 0.05 [0.04–0.06] | 0.03 [0.02–0.04] | -39% |
| CPU s, browser | 0.12 [0.11–0.13] | 0.16 [0.10–0.21] | +29% |
| CPU s, server | 3.14 [2.83–3.46] | 3.13 [2.78–3.49] | -0% |
| Idle wakeups / s | 7 [7–8] | 7 [6–8] | -1% |
| Renderer task ms | 125 [103–146] | 113 [83–143] | -9% |
| Renderer script ms | 51 [44–59] | 39 [21–57] | -24% |
| Renderer layout ms | 1 [0–1] | 0 [0–0] | -100% |
| Renderer style ms | 1 [1–1] | 2 [0–3] | +87% |
| Menu-bar syncs | 0 [0–0] | 0 [0–0] | – |

## idle-background

| Metric | Before | After | Change |
| --- | --- | --- | --- |
| Energy Impact (avg) | 5.1 | 4.9 | -5% |
| CPU s, all processes | 3.25 | 3.19 | -2% |
| CPU s, renderer | 0.34 | 0.42 | +25% |
| CPU s, GPU | 0.06 | 0.04 | -26% |
| CPU s, browser | 0.20 | 0.36 | +74% |
| CPU s, server | 2.73 | 2.53 | -7% |
| Idle wakeups / s | 8 | 7 | -7% |
| Renderer task ms | 265 | 343 | +29% |
| Renderer script ms | 140 | 167 | +19% |
| Renderer layout ms | 7 | 0 | -100% |
| Renderer style ms | 9 | 10 | +8% |
| Menu-bar syncs | 0 | 0 | – |

## visual-typing

| Metric | Before | After | Change |
| --- | --- | --- | --- |
| Energy Impact (avg) | 20.3 | 20.0 | -1% |
| CPU s, all processes | 14.11 | 13.88 | -2% |
| CPU s, renderer | 8.92 | 8.09 | -9% |
| CPU s, GPU | 1.61 | 1.74 | +8% |
| CPU s, browser | 0.97 | 0.94 | -3% |
| CPU s, server | 2.84 | 3.33 | +17% |
| Idle wakeups / s | 155 | 155 | -0% |
| Renderer task ms | 5888 | 5405 | -8% |
| Renderer script ms | 2084 | 1536 | -26% |
| Renderer layout ms | 300 | 306 | +2% |
| Renderer style ms | 6 | 4 | -36% |
| Menu-bar syncs | 1 | 0 | -100% |

## panels

| Metric | Before | After | Change |
| --- | --- | --- | --- |
| Energy Impact (avg) | 35.5 | 34.7 | -2% |
| CPU s, all processes | 7.65 | 7.58 | -1% |
| CPU s, renderer | 4.15 | 4.13 | -0% |
| CPU s, GPU | 0.59 | 0.60 | +2% |
| CPU s, browser | 0.43 | 0.48 | +12% |
| CPU s, server | 2.59 | 2.67 | +3% |
| Idle wakeups / s | 123 | 123 | -0% |
| Renderer task ms | 2102 | 2113 | +1% |
| Renderer script ms | 923 | 820 | -11% |
| Renderer layout ms | 151 | 153 | +2% |
| Renderer style ms | 386 | 411 | +6% |
| Menu-bar syncs | 12 | 11 | -8% |

## source-typing

| Metric | Before | After | Change |
| --- | --- | --- | --- |
| Energy Impact (avg) | 25.9 | 25.7 | -1% |
| CPU s, all processes | 17.24 | 16.73 | -3% |
| CPU s, renderer | 10.69 | 10.44 | -2% |
| CPU s, GPU | 2.15 | 2.07 | -3% |
| CPU s, browser | 1.00 | 1.00 | -0% |
| CPU s, server | 3.64 | 3.55 | -2% |
| Idle wakeups / s | 185 | 183 | -1% |
| Renderer task ms | 6299 | 6279 | -0% |
| Renderer script ms | 1603 | 1532 | -4% |
| Renderer layout ms | 1091 | 1079 | -1% |
| Renderer style ms | 59 | 56 | -6% |
| Menu-bar syncs | 2 | 2 | 0% |

## pdf-annotate

| Metric | Before | After | Change |
| --- | --- | --- | --- |
| Energy Impact (avg) | 20.2 | 11.7 | -42% |
| CPU s, all processes | 12.75 | 7.45 | -42% |
| CPU s, renderer | 4.49 | 1.77 | -61% |
| CPU s, GPU | 3.61 | 1.07 | -70% |
| CPU s, browser | 0.53 | 0.40 | -25% |
| CPU s, server | 4.35 | 4.02 | -8% |
| Idle wakeups / s | 146 | 61 | -59% |
| Renderer task ms | 2346 | 2872 | +22% |
| Renderer script ms | 782 | 394 | -50% |
| Renderer layout ms | 45 | 13 | -71% |
| Renderer style ms | 112 | 92 | -18% |
| Menu-bar syncs | 1 | 1 | 0% |

## latex-typing

| Metric | Before | After | Change |
| --- | --- | --- | --- |
| Energy Impact (avg) | 17.9 | 16.2 | -9% |
| CPU s, all processes | 12.33 | 11.06 | -10% |
| CPU s, renderer | 6.60 | 6.53 | -1% |
| CPU s, GPU | 1.51 | 1.59 | +5% |
| CPU s, browser | 0.51 | 0.58 | +13% |
| CPU s, server | 3.60 | 2.59 | -28% |
| Idle wakeups / s | 143 | 142 | -0% |
| Renderer task ms | 3502 | 3742 | +7% |
| Renderer script ms | 1135 | 1205 | +6% |
| Renderer layout ms | 176 | 192 | +9% |
| Renderer style ms | 608 | 637 | +5% |
| Menu-bar syncs | 1 | 0 | -100% |

