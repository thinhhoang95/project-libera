import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SLIDE_THEME_TOKENS,
  buildSlideChartConfig,
  isSlideChartDataFile,
  parseSlideChartCsv,
  parseSlideChartSpec,
  slideChartInlineTable,
  type SlideChartSpec,
} from "../../src/lib/slide-charts";

function spec(source: string): SlideChartSpec {
  const parsed = parseSlideChartSpec(source);
  assert.ok("spec" in parsed, "error" in parsed ? parsed.error : "");
  return parsed.spec;
}

const light = SLIDE_THEME_TOKENS.light;

test("YAML labels and series become a bar chart", () => {
  const chart = spec("title: Revenue\nlabels: [Q1, Q2, Q3]\nseries:\n  2025: [1, 2, 3]\n  2026: [2, 3, 4]");
  const config = buildSlideChartConfig(chart, slideChartInlineTable(chart), light, { animate: false });

  assert.equal(config.type, "bar");
  assert.deepEqual(config.data.labels, ["Q1", "Q2", "Q3"]);
  assert.deepEqual(config.data.datasets.map((dataset) => dataset.label), ["2025", "2026"]);
  assert.deepEqual(config.data.datasets[1].data, [2, 3, 4]);
  // Two series: a legend; colors in the palette's fixed order.
  const plugins = config.options.plugins as { legend: { display: boolean } };
  assert.equal(plugins.legend.display, true);
  assert.deepEqual(config.data.datasets.map((dataset) => dataset.backgroundColor), ["#2a78d6", "#eb6834"]);
});

test("one series needs no legend; dark themes use the dark palette steps", () => {
  const chart = spec("labels: [a, b]\nseries: [3, 4]");
  const config = buildSlideChartConfig(chart, slideChartInlineTable(chart), SLIDE_THEME_TOKENS.night, { animate: false });
  const plugins = config.options.plugins as { legend: { display: boolean } };

  assert.equal(plugins.legend.display, false);
  assert.equal(config.data.datasets[0].backgroundColor, "#3987e5");
});

test("JSON settings work too", () => {
  const chart = spec('{"type": "line", "labels": ["x"], "series": {"y": [1]}, "smooth": true}');

  assert.equal(chart.type, "line");
  assert.equal(chart.smooth, true);
});

test("CSV data: first column labels, other columns series, gaps stay gaps", () => {
  const table = parseSlideChartCsv('month, sales, "costs, total"\nJan, 10, 4\nFeb, , 6\n# comment\nMar, 12.5, n/a');

  assert.deepEqual(table.labels, ["Jan", "Feb", "Mar"]);
  assert.deepEqual(table.series.map((series) => series.name), ["sales", "costs, total"]);
  assert.deepEqual(table.series[0].values, [10, null, 12.5]);
  assert.deepEqual(table.series[1].values, [4, 6, null]);
});

test("inline CSV under data:, and a .csv path means a file", () => {
  const chart = spec("type: area\ndata: |\n  day,visits\n  Mon,5\n  Tue,8");

  assert.deepEqual(slideChartInlineTable(chart)?.series[0].values, [5, 8]);
  assert.equal(isSlideChartDataFile("data/sales.csv"), true);
  assert.equal(isSlideChartDataFile("day,visits\nMon,5"), false);
  assert.equal(slideChartInlineTable(spec("data: sales.csv")), null);
});

test("area fills, horizontal bars swap axes, stacked stacks", () => {
  const area = spec("type: area\nlabels: [a]\nseries:\n  s: [1]");
  const areaConfig = buildSlideChartConfig(area, slideChartInlineTable(area), light, { animate: false });
  assert.equal(areaConfig.type, "line");
  assert.equal(areaConfig.data.datasets[0].fill, "origin");

  const bars = spec("horizontal: true\nstacked: true\nlabels: [a]\nseries:\n  s: [1]\n  t: [2]");
  const barConfig = buildSlideChartConfig(bars, slideChartInlineTable(bars), light, { animate: false });
  const scales = barConfig.options.scales as { x: { stacked: boolean; beginAtZero?: boolean }; y: { stacked: boolean } };
  assert.equal(barConfig.options.indexAxis, "y");
  assert.equal(scales.x.stacked, true);
  assert.equal(scales.x.beginAtZero, true);
});

test("pie slices take one color each", () => {
  const pie = spec("type: pie\nlabels: [a, b, c]\nseries: [1, 2, 3]");
  const config = buildSlideChartConfig(pie, slideChartInlineTable(pie), light, { animate: false });

  assert.deepEqual(config.data.datasets[0].backgroundColor, ["#2a78d6", "#eb6834", "#1baf7a"]);
  assert.equal(config.options.scales, undefined);
});

test("options merge into Chart.js options without touching prototypes", () => {
  const chart = spec('labels: [a]\nseries: [1]\noptions:\n  plugins:\n    legend:\n      display: true\n  "__proto__":\n    polluted: true');
  const config = buildSlideChartConfig(chart, slideChartInlineTable(chart), light, { animate: false });
  const plugins = config.options.plugins as { legend: { display: boolean; labels: unknown } };

  assert.equal(plugins.legend.display, true);
  assert.ok(plugins.legend.labels, "the rest of the legend settings stay");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("mistakes come back as messages", () => {
  assert.match((parseSlideChartSpec("type: donut\nseries: [1]") as { error: string }).error, /Unknown chart type/);
  assert.match((parseSlideChartSpec("type: bar") as { error: string }).error, /no data/);
  assert.match((parseSlideChartSpec("labels: [a\nseries: [1]") as { error: string }).error, /do not parse/);
  assert.match((parseSlideChartSpec("series: 4") as { error: string }).error, /series/);
});
