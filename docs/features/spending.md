# Spending

Spending shows what Libera's OpenRouter requests cost and how many tokens they used. It opens in a tab of its own, like a PDF or a photo:

- **Command palette:** *Show OpenRouter spending*.
- **Preferences → AI:** *View spending*. Preferences closes and the tab opens.

## Contextual rail tabs

While the Spending tab is active, a **Spending** tab appears in the left rail, below Notebook, Outlines, Comments, References and Image Gallery. It has its own tint and a short rule above it. Like Word's Table Design tab, which shows only while a table is selected, it goes away when another tab becomes active. The left panel then goes back to the panel used before.

The rail tab opens on its own when the Spending tab opens or becomes active again. Its panel holds the page's controls:

| Control | Choices |
| --- | --- |
| Period | Today, This week (from Monday), Last 7 days, This month, Last 30 days, Last month, Last 90 days, This year, All time. Each row shows that period's total. |
| Measure | Cost or tokens |
| Break down by | Component (input, output, cache read, cache write, media and fees) or model |
| Models | All models, or one model alone. You can also click a row in the page's model table. |
| OpenRouter key | The key's own spend today, this week and this month (UTC days), and its credit limit. These figures come from OpenRouter and include every app that uses the key. |

The settings are remembered on this computer.

The groundwork is in `components/libera/page-tabs.ts`. An app page is a tab with a `page` marker and the file type `"page"`, so nothing that handles files treats it as a file. A page can declare a `railTab`. The left panel shows that rail tab only while the page is the active tab.

## The page

- **Totals:** total cost or tokens, compared with the period before it (of the same length). Also tokens or cost, requests, cache hit rate with an estimate of what caching saved, and a daily average.
- **Stacked bars** by hour, day, week or month, depending on the period. Point at a bar, or focus the chart and use the arrow keys, to see its breakdown.
- **Where it went:** the period's tokens and cost by component.
- **Calendar:** a heatmap of the last year by day. The selected period is shaded.
- **By model:** requests, input, output, cache reads, cost and share for each model.

Each model keeps the same color in every period. Colors follow the order of overall cost, and models after the seventh share "Other models".

## Where the numbers come from

Every OpenRouter response reports its tokens and what it cost. The server adds one line per request to `.libera/usage/openrouter-YYYY-MM.jsonl` in the data folder, one file per UTC month. This covers chat completions (streamed or not), the agent and image generation. Speech and transcription are not covered. History starts when this feature is installed; earlier requests are not shown.

OpenRouter reports one total cost per request. To split it into input, output and cache costs, Libera prices each part with the model's rates from OpenRouter's model list, then scales the parts so they add up to the charge OpenRouter reported. Web search and other fees are spread over the parts the same way. For a model OpenRouter no longer lists, the split uses typical weights instead. A charge with no tokens, such as a generated image, shows as *Media & fees*.

Tests turn recording off (`LIBERA_USAGE_LEDGER=off` in `scripts/editor/setup.cjs`), so stubbed responses never reach the ledger.
