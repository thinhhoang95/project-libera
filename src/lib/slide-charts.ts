/**
 * ```chart blocks in Markdown Slides: a small YAML (or JSON) spec turned into
 * a Chart.js configuration. Data comes inline (`labels` + `series`), as CSV
 * text, or from a CSV file next to the deck. The spec is data only, so it is
 * safe to render from any notebook; `options` is merged into Chart.js's
 * options for anything the shorthand does not cover.
 *
 *   type: bar
 *   title: Revenue by quarter
 *   labels: [Q1, Q2, Q3, Q4]
 *   series:
 *     2025: [12, 19, 8, 15]
 *     2026: [14, 22, 11, 18]
 */
import { load } from "js-yaml";

export const SLIDE_CHART_TYPES = [
  "bar",
  "line",
  "area",
  "pie",
  "doughnut",
  "scatter",
  "bubble",
  "radar",
  "polarArea",
] as const;

export type SlideChartType = (typeof SLIDE_CHART_TYPES)[number];

export type SlideChartLegend = "top" | "bottom" | "left" | "right" | "none";

export type SlideChartSpec = {
  beginAtZero: boolean;
  colors?: string[];
  /** CSV text, or a .csv/.tsv path relative to the deck. */
  data?: string;
  datasets?: Array<Record<string, unknown>>;
  height: number;
  horizontal: boolean;
  labels?: unknown[];
  legend?: SlideChartLegend;
  options?: Record<string, unknown>;
  series?: Record<string, unknown[]>;
  smooth: boolean;
  stacked: boolean;
  title?: string;
  type: SlideChartType;
  x?: string;
  y?: string;
  yMax?: number;
  yMin?: number;
};

export type SlideChartTable = {
  labels: string[];
  series: Array<{ name: string; values: Array<number | null> }>;
};

export type SlideChartTheme = {
  dark: boolean;
  foreground: string;
  muted: string;
  rule: string;
  surface: string;
};

/**
 * Each slide theme's palette, as markdown-slide CSS sets it (globals.css,
 * `.markdown-slide[data-theme]`), for charts and live frames that cannot
 * read CSS variables.
 */
export const SLIDE_THEME_TOKENS: Record<string, SlideChartTheme> = {
  dark: { dark: true, foreground: "#f4f4f5", muted: "#a1a1aa", rule: "#3f3f46", surface: "#18181b" },
  light: { dark: false, foreground: "#18181b", muted: "#71717a", rule: "#e4e4e7", surface: "#ffffff" },
  night: { dark: true, foreground: "#e2e8f0", muted: "#94a3b8", rule: "#334155", surface: "#0f172a" },
  paper: { dark: false, foreground: "#292524", muted: "#78716c", rule: "#e2d9c5", surface: "#fbf8f1" },
};

export function slideSeriesPalette(dark: boolean) {
  return dark ? SERIES_DARK : SERIES_LIGHT;
}

// The reference categorical palette (dataviz skill), validated as an
// ordered set in both modes. Hues go in this order and are never cycled
// into new ones; a ninth series reuses the order.
const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

const DEFAULT_HEIGHT = 300;
const LEGENDS: SlideChartLegend[] = ["top", "bottom", "left", "right", "none"];
const FILE_DATA_REGEX = /^[^\n]+\.(?:csv|tsv)$/i;

export function isSlideChartDataFile(data: string | undefined) {
  return Boolean(data && FILE_DATA_REGEX.test(data.trim()));
}

function stringValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The spec, or a message saying what is wrong with it. */
export function parseSlideChartSpec(source: string): { spec: SlideChartSpec } | { error: string } {
  let raw: unknown;

  try {
    raw = source.trim().startsWith("{") ? JSON.parse(source) : load(source);
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { error: `The chart settings do not parse: ${message}` };
  }

  if (!isRecord(raw)) {
    return { error: "A chart needs settings like `type: bar`, `labels` and `series` (or `data`)." };
  }

  const typeText = stringValue(raw.type) ?? "bar";
  const type = SLIDE_CHART_TYPES.find((candidate) => candidate.toLowerCase() === typeText.toLowerCase());

  if (!type) {
    return { error: `Unknown chart type "${typeText}"; use one of ${SLIDE_CHART_TYPES.join(", ")}.` };
  }

  const legendText = raw.legend === false ? "none" : stringValue(raw.legend)?.toLowerCase();
  const legend = LEGENDS.find((candidate) => candidate === legendText);

  if (legendText && !legend) {
    return { error: `Unknown legend position "${legendText}"; use ${LEGENDS.join(", ")}.` };
  }

  let series: Record<string, unknown[]> | undefined;

  if (raw.series !== undefined) {
    if (Array.isArray(raw.series)) {
      series = { [stringValue(raw.title) ?? "Series 1"]: raw.series };
    } else if (isRecord(raw.series) && Object.values(raw.series).every(Array.isArray)) {
      series = raw.series as Record<string, unknown[]>;
    } else {
      return { error: "`series` should map each series name to a list of values." };
    }
  }

  const datasets = Array.isArray(raw.datasets) ? raw.datasets.filter(isRecord) : undefined;
  const data = stringValue(raw.data);

  if (!series && !datasets && !data) {
    return { error: "The chart has no data: add `labels` and `series`, or `data` (CSV text or a .csv file)." };
  }

  const colors = Array.isArray(raw.colors)
    ? raw.colors.map((color) => stringValue(color)).filter((color): color is string => Boolean(color))
    : undefined;

  return {
    spec: {
      beginAtZero: raw.beginAtZero !== false,
      colors: colors?.length ? colors : undefined,
      data,
      datasets,
      height: Math.min(Math.max(numberValue(raw.height) ?? DEFAULT_HEIGHT, 80), 1000),
      horizontal: raw.horizontal === true,
      labels: Array.isArray(raw.labels) ? raw.labels : undefined,
      legend,
      options: isRecord(raw.options) ? raw.options : undefined,
      series,
      smooth: raw.smooth === true,
      stacked: raw.stacked === true,
      title: stringValue(raw.title),
      type,
      x: stringValue(raw.x),
      y: stringValue(raw.y),
      yMax: numberValue(raw.yMax ?? raw.max),
      yMin: numberValue(raw.yMin ?? raw.min),
    },
  };
}

function splitCsvLine(line: string, delimiter: string) {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }

  cells.push(cell.trim());
  return cells;
}

/**
 * CSV (or TSV) with a header row: the first column labels the points, each
 * other column is a series. Empty or non-numeric cells are gaps.
 */
export function parseSlideChartCsv(text: string): SlideChartTable {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#"));

  if (!lines.length) {
    return { labels: [], series: [] };
  }

  const delimiter = lines[0].includes("\t") ? "\t" : lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",";
  const [header, ...rows] = lines.map((line) => splitCsvLine(line, delimiter));

  return {
    labels: rows.map((row) => row[0] ?? ""),
    series: header.slice(1).map((name, column) => ({
      name: name || `Series ${column + 1}`,
      values: rows.map((row) => {
        const cell = row[column + 1]?.replace(/[,\s](?=\d{3}\b)/g, "");
        return numberValue(cell) ?? null;
      }),
    })),
  };
}

/** The inline data as a table, when the spec carries it (not a file to fetch). */
export function slideChartInlineTable(spec: SlideChartSpec): SlideChartTable | null {
  if (spec.series) {
    return {
      labels: (spec.labels ?? []).map((label) => String(label)),
      series: Object.entries(spec.series).map(([name, values]) => ({
        name,
        values: values.map((value) => numberValue(value) ?? null),
      })),
    };
  }

  if (spec.data && !isSlideChartDataFile(spec.data)) {
    return parseSlideChartCsv(spec.data);
  }

  return null;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const [key, value] of Object.entries(source)) {
    // Never let a spec reach the prototype chain.
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const existing = target[key];
    target[key] = isRecord(value) && isRecord(existing) ? deepMerge({ ...existing }, value) : value;
  }

  return target;
}

function withAlpha(hex: string, alpha: number) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return hex;
  return `#${match[1]}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

/** A Chart.js configuration for the spec and its data, styled for the slide's theme. */
export function buildSlideChartConfig(
  spec: SlideChartSpec,
  table: SlideChartTable | null,
  theme: SlideChartTheme,
  { animate }: { animate: boolean },
) {
  const palette = spec.colors ?? (theme.dark ? SERIES_DARK : SERIES_LIGHT);
  const color = (index: number) => palette[index % palette.length];
  const circular = spec.type === "pie" || spec.type === "doughnut" || spec.type === "polarArea";
  const pointBased = spec.type === "scatter" || spec.type === "bubble";
  const chartType = spec.type === "area" ? "line" : spec.type;
  const seriesCount = spec.datasets?.length ?? table?.series.length ?? 0;
  let datasets: Array<Record<string, unknown>>;

  if (spec.datasets) {
    datasets = spec.datasets.map((dataset, index) => ({
      backgroundColor: color(index),
      borderColor: color(index),
      ...dataset,
    }));
  } else if (pointBased && table) {
    // Scatter: the first column is x, each other column a series of y.
    datasets = table.series.map((series, index) => ({
      backgroundColor: color(index),
      borderColor: theme.surface,
      borderWidth: 2,
      data: series.values
        .map((y, row) => ({ x: numberValue(table.labels[row]), y }))
        .filter((point) => point.x !== undefined && point.y !== null),
      label: series.name,
      pointRadius: 5,
      pointHoverRadius: 7,
    }));
  } else {
    datasets = (table?.series ?? []).map((series, index) => {
      const base = { data: series.values, label: series.name };

      if (circular) {
        return {
          ...base,
          backgroundColor: series.values.map((_, point) => color(point)),
          borderColor: theme.surface,
          borderWidth: 2,
          hoverOffset: 6,
        };
      }

      if (chartType === "line" || chartType === "radar") {
        return {
          ...base,
          backgroundColor: spec.type === "area" || chartType === "radar" ? withAlpha(color(index), 0.18) : color(index),
          borderColor: color(index),
          borderWidth: 2,
          fill: spec.type === "area" ? (spec.stacked && index > 0 ? "-1" : "origin") : chartType === "radar",
          pointBackgroundColor: color(index),
          pointBorderColor: theme.surface,
          pointBorderWidth: 2,
          pointHoverRadius: 6,
          pointRadius: 4,
          tension: spec.smooth ? 0.35 : 0,
        };
      }

      // Bars: rounded data ends, a surface-colored gap between touching bars.
      return {
        ...base,
        backgroundColor: color(index),
        borderColor: theme.surface,
        borderRadius: 4,
        borderSkipped: "start",
        borderWidth: 1,
        maxBarThickness: 64,
      };
    });
  }

  const legendDisplay = spec.legend ? spec.legend !== "none" : circular || seriesCount > 1;
  const axisTitle = (text: string | undefined) =>
    text ? { color: theme.muted, display: true, font: { size: 13 }, text } : { display: false };
  const valueAxis = {
    beginAtZero: spec.beginAtZero,
    border: { display: false },
    grid: { color: theme.rule, drawTicks: false },
    max: spec.yMax,
    min: spec.yMin,
    stacked: spec.stacked,
    ticks: { color: theme.muted, padding: 8 },
    title: axisTitle(spec.y),
  };
  const categoryAxis = {
    border: { color: theme.rule },
    grid: { display: false },
    stacked: spec.stacked,
    ticks: { color: theme.muted },
    title: axisTitle(spec.x),
  };
  const horizontal = spec.horizontal && chartType === "bar";
  const scales = circular
    ? undefined
    : chartType === "radar"
      ? {
          r: {
            angleLines: { color: theme.rule },
            beginAtZero: spec.beginAtZero,
            grid: { color: theme.rule },
            pointLabels: { color: theme.foreground, font: { size: 13 } },
            ticks: { backdropColor: "transparent", color: theme.muted },
          },
        }
      : pointBased
        ? { x: { ...valueAxis, beginAtZero: false, max: undefined, min: undefined, title: axisTitle(spec.x) }, y: valueAxis }
        : horizontal
          ? { x: valueAxis, y: categoryAxis }
          : { x: categoryAxis, y: valueAxis };
  const options: Record<string, unknown> = {
    animation: animate ? { duration: 500 } : false,
    color: theme.foreground,
    indexAxis: horizontal ? "y" : "x",
    interaction: circular || pointBased ? { intersect: true, mode: "nearest" } : { intersect: false, mode: "index" },
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: legendDisplay,
        labels: { boxHeight: 10, boxWidth: 10, color: theme.foreground, font: { size: 13 }, padding: 14, useBorderRadius: true, borderRadius: 2 },
        position: spec.legend && spec.legend !== "none" ? spec.legend : "top",
      },
      title: spec.title
        ? { align: "start", color: theme.foreground, display: true, font: { size: 15, weight: "600" }, padding: { bottom: 12 }, text: spec.title }
        : { display: false },
      tooltip: {
        backgroundColor: theme.dark ? "#f4f4f5" : "#18181b",
        bodyColor: theme.dark ? "#18181b" : "#f4f4f5",
        boxPadding: 4,
        cornerRadius: 6,
        padding: 10,
        titleColor: theme.dark ? "#18181b" : "#f4f4f5",
      },
    },
    responsive: true,
    scales,
  };

  return {
    data: { datasets, labels: pointBased ? undefined : table?.labels },
    options: spec.options ? deepMerge(options, spec.options) : options,
    type: chartType,
  };
}
