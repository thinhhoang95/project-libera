"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import {
  ArrowDownRight, ArrowUpRight, CalendarDays, ChartColumnStacked, Coins, Database, Info, Loader2, Minus, Repeat2, RotateCw, Sigma, X,
} from "lucide-react";
import {
  buildChart, buildHeatmap, COMPONENTS, formatCost, formatMetric, formatTokens, modelLabel, modelOrder, modelRows,
  previousRange, resolvePeriod, summarize,
  type Breakdown, type ChartData, type Heatmap, type Metric, type PeriodRange, type PeriodSummary, type UsageReport,
} from "@/lib/spending";
import { refreshSpending, updateSpendingSettings, useSpending } from "./spending-store";
import {
  binLabel, binTitle, componentColor, filterReport, formatDay, formatPercent, formatRange, formatShortDay, modelColor,
  niceScale, periodLabel, seriesColor,
} from "./spending-format";
import styles from "./spending.module.css";

const REFRESH_MS = 60_000;

/** Keeps the page current while it is open: on mount, every minute, and when the window regains focus. */
function useLiveSpending() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    void refreshSpending();
    const tick = () => {
      setNow(Date.now());
      void refreshSpending({ account: false });
    };
    const interval = window.setInterval(tick, REFRESH_MS);
    const onFocus = () => {
      setNow(Date.now());
      void refreshSpending();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return now;
}

function useElementWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function SpendingView() {
  const { settings, report } = useSpending();
  const now = useLiveSpending();
  const full = report.value;

  const derived = useMemo(() => {
    if (!full) return null;
    const order = modelOrder(full.buckets);
    const data = filterReport(full, settings.model);
    const range = resolvePeriod(settings.period, now, full.since);
    return {
      order,
      range,
      chart: buildChart(data, range, settings.metric, settings.breakdown),
      summary: summarize(data, range),
      previous: summarize(data, previousRange(range, now)),
      rows: modelRows(full, range, settings.metric),
      heatmap: buildHeatmap(data, settings.metric, now),
    };
  }, [full, settings.model, settings.period, settings.metric, settings.breakdown, now]);

  if (!full || !derived) {
    return (
      <div className={`${styles.tokens} ${styles.page}`}>
        <div className={styles.content}>
          {report.status === "error" ? (
            <div className={styles.empty} role="alert">
              <div className={styles.emptyArt}><ChartColumnStacked aria-hidden className="h-9 w-9" /></div>
              <h2>Spending could not be loaded</h2>
              <p>{report.error}</p>
              <button type="button" className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm" onClick={() => void refreshSpending()}>
                <RotateCw aria-hidden className="h-3.5 w-3.5" /> Try again
              </button>
            </div>
          ) : (
            <div className={styles.empty} role="status">
              <Loader2 aria-hidden className="h-6 w-6 animate-spin text-muted-foreground" />
              <p>Loading spending…</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  const { order, range, chart, summary, previous, rows, heatmap } = derived;
  const { metric, breakdown } = settings;
  const filteredLabel = settings.model ? modelLabel(settings.model, full.models) : null;

  return (
    <div className={`${styles.tokens} ${styles.page}`} data-command-scope="1">
      <div className={styles.content}>
        <header className={styles.header}>
          <div>
            <div className={styles.eyebrow}><ChartColumnStacked aria-hidden className="h-3.5 w-3.5" /> OpenRouter spending</div>
            <h1 className={styles.title}>{periodLabel(settings.period)}</h1>
            <p className={styles.range}>{formatRange(range, now)}</p>
          </div>
          <div className={styles.headerMeta}>
            {filteredLabel ? (
              <span className={styles.chip}>
                <span className={styles.swatch} style={{ background: modelColor(settings.model!, order) }} />
                Only {filteredLabel}
                <button type="button" aria-label="Show every model" title="Show every model" onClick={() => updateSpendingSettings({ model: null })}><X aria-hidden className="h-3 w-3" /></button>
              </span>
            ) : null}
            {report.status === "loading" ? <Loader2 aria-label="Refreshing" className="h-3.5 w-3.5 animate-spin" /> : null}
          </div>
        </header>

        {full.buckets.length === 0 ? <EmptyLedger /> : <>
          <StatTiles summary={summary} previous={previous} metric={metric} range={range} now={now} />

          <section className={styles.card} aria-labelledby="spending-chart-title">
            <div className={styles.cardHeader}>
              <div>
                <h2 id="spending-chart-title" className={styles.cardTitle}>{metric === "cost" ? "Cost" : "Tokens"} by {breakdown === "component" ? "component" : "model"}</h2>
                <p className={styles.cardSubtitle}>Per {range.unit === "hour" ? "hour" : range.unit}{metric === "cost" && breakdown === "component" ? " · input, output and cache costs are estimated from each model’s prices" : ""}</p>
              </div>
              <Legend keys={chart.keys} breakdown={breakdown} order={order} />
            </div>
            <StackedBars chart={chart} range={range} metric={metric} breakdown={breakdown} order={order} now={now} />
          </section>

          <div className={styles.split}>
            <Composition summary={summary} metric={metric} />
            <HeatmapCard heatmap={heatmap} metric={metric} range={range} />
          </div>

          <ModelTable rows={rows} order={order} metric={metric} selected={settings.model} report={full} />
        </>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function DeltaBadge({ current, previous, metric }: { current: number; previous: number; metric: Metric }) {
  if (!previous) return <span>{current ? "Nothing in the span before" : ""}</span>;
  const change = (current - previous) / previous;
  const Icon = Math.abs(change) < 0.005 ? Minus : change > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span title={`${formatMetric(previous, metric, { precise: true })} in the span before`}>
      <span className={styles.delta}><Icon aria-hidden className="h-3.5 w-3.5" />{formatPercent(Math.abs(change))}</span> vs. the span before
    </span>
  );
}

function StatTiles({ summary, previous, metric, range, now }: { summary: PeriodSummary; previous: PeriodSummary; metric: Metric; range: PeriodRange; now: number }) {
  const elapsedDays = Math.max(1, Math.ceil((Math.min(range.end, now) - range.start) / 86_400_000));
  const heroValue = metric === "cost" ? summary.cost : summary.totalTokens;
  const promptTokens = summary.tokens.input + summary.tokens.cacheRead + summary.tokens.cacheWrite;
  return (
    <section className={styles.stats} aria-label="Totals for the period">
      <div className={`${styles.stat} ${styles.hero}`}>
        <div className={styles.statLabel}>{metric === "cost" ? <Coins aria-hidden className="h-3.5 w-3.5" /> : <Sigma aria-hidden className="h-3.5 w-3.5" />}{metric === "cost" ? "Total cost" : "Total tokens"}{summary.estimated && metric === "cost" ? " (partly estimated)" : ""}</div>
        <div className={styles.statValue} title={formatMetric(heroValue, metric, { precise: true, exact: true })}>{formatMetric(heroValue, metric, { precise: true })}</div>
        <div className={styles.statDetail}><DeltaBadge current={heroValue} previous={metric === "cost" ? previous.cost : previous.totalTokens} metric={metric} /></div>
      </div>
      {metric === "cost" ? (
        <Stat icon={Sigma} label="Tokens" value={formatTokens(summary.totalTokens)} detail={`${formatTokens(promptTokens)} in · ${formatTokens(summary.tokens.output)} out`} title={`${formatTokens(summary.totalTokens, { exact: true })} tokens`} />
      ) : (
        <Stat icon={Coins} label="Cost" value={formatCost(summary.cost, { precise: true })} detail={summary.totalTokens ? `${formatCost(summary.cost / summary.totalTokens * 1e6)} per million tokens` : "—"} />
      )}
      <Stat icon={Repeat2} label="Requests" value={formatTokens(summary.requests)} detail={summary.requests ? `${formatCost(summary.cost / summary.requests, { precise: true })} each on average` : "—"} title={`${formatTokens(summary.requests, { exact: true })} requests`} />
      <Stat icon={Database} label="Cache hit rate" value={formatPercent(summary.cacheHitRate)} detail={summary.cacheSavings ? `≈ ${formatCost(summary.cacheSavings)} saved by caching` : "of prompt tokens read from cache"} />
      <Stat icon={CalendarDays} label="Daily average" value={formatMetric((metric === "cost" ? summary.cost : summary.totalTokens) / elapsedDays, metric)} detail={`${summary.activeDays} active ${summary.activeDays === 1 ? "day" : "days"} of ${elapsedDays}`} />
    </section>
  );
}

function Stat({ icon: Icon, label, value, detail, title }: { icon: typeof Coins; label: string; value: string; detail: string; title?: string }) {
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}><Icon aria-hidden className="h-3.5 w-3.5" />{label}</div>
      <div className={styles.statValue} title={title}>{value}</div>
      <div className={styles.statDetail} title={detail}>{detail}</div>
    </div>
  );
}

function Legend({ keys, breakdown, order }: { keys: ChartData["keys"]; breakdown: Breakdown; order: string[] }) {
  if (keys.length < 2) return null;
  return (
    <ul className={styles.legend} aria-label="Legend">
      {keys.map((key) => (
        <li key={key.key} className={styles.legendItem} title={key.detail ?? key.label}>
          <span className={styles.swatch} style={{ background: seriesColor(key.key, breakdown, order) }} />
          <span>{key.label}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Stacked bars.

const CHART_HEIGHT = 260;
const MARGIN = { top: 10, right: 6, bottom: 26, left: 54 };
const GAP = 2;
const RADIUS = 4;

function roundedTop(x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.max(0, Math.min(radius, width / 2, height));
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

function StackedBars({ chart, range, metric, breakdown, order, now }: { chart: ChartData; range: PeriodRange; metric: Metric; breakdown: Breakdown; order: string[]; now: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const [hover, setHover] = useState<number | null>(null);
  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotH = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
  const scale = niceScale(chart.max);
  const count = chart.bins.length;
  const band = count ? plotW / count : 0;
  const barW = Math.max(2, Math.min(24, band * 0.64));
  const toY = (value: number) => (value / scale.max) * plotH;
  const labelEvery = Math.max(1, Math.ceil(count / Math.max(2, Math.floor(plotW / 62))));
  const multiYear = new Date(range.start).getFullYear() !== new Date(range.end - 1).getFullYear();
  const currentIndex = chart.bins.findIndex((bin) => now >= bin.start && now < bin.end);
  // Evenly spaced labels, plus the current hour, day or month in bold; labels too close to it make way.
  const labelled = new Set(chart.bins.map((_, index) => index).filter((index) => index % labelEvery === 0 && (currentIndex < 0 || Math.abs(index - currentIndex) * band >= 46)));
  if (currentIndex >= 0) labelled.add(currentIndex);

  function indexAt(event: ReactMouseEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const index = Math.floor((event.clientX - bounds.left - MARGIN.left) / band);
    return index >= 0 && index < count ? index : null;
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    setHover((current) => {
      const start = current ?? (currentIndex >= 0 ? currentIndex : count - 1);
      if (event.key === "Home") return 0;
      if (event.key === "End") return count - 1;
      return Math.max(0, Math.min(count - 1, start + (event.key === "ArrowLeft" ? -1 : 1)));
    });
  }

  const hovered = hover !== null ? chart.bins[hover] : null;
  const tooltipLeft = hover !== null ? Math.min(Math.max(MARGIN.left + band * (hover + 0.5), 110), Math.max(110, width - 110)) : 0;
  const tooltipTop = hovered ? Math.max(MARGIN.top + plotH - toY(hovered.total), 70) : 0;

  return (
    <div
      ref={ref}
      className={styles.chart}
      data-hovering={hover !== null}
      tabIndex={0}
      role="group"
      aria-label={`${metric === "cost" ? "Cost" : "Tokens"} per ${range.unit}, ${formatMetric(chart.total, metric)} in total. Use the arrow keys to read each ${range.unit}.`}
      onKeyDown={onKeyDown}
      onBlur={() => setHover(null)}
    >
      {width > 0 ? (
        <svg width={width} height={CHART_HEIGHT} onMouseMove={(event) => setHover(indexAt(event))} onMouseLeave={() => setHover(null)} aria-hidden>
          <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
            {scale.ticks.map((tick) => (
              <g key={tick} transform={`translate(0,${plotH - toY(tick)})`}>
                {tick ? <line className={styles.gridLine} x1={0} x2={plotW} /> : null}
                <text className={styles.axisText} x={-10} dy="0.32em" textAnchor="end">{metric === "cost" ? formatAxisCost(tick) : formatTokens(tick)}</text>
              </g>
            ))}
            {hover !== null ? <rect className={styles.hoverBand} x={band * hover} y={0} width={band} height={plotH} rx={6} /> : null}
            {chart.bins.map((bin, index) => {
              const x = band * index + (band - barW) / 2;
              let cursor = plotH;
              const segments = chart.keys.filter((key) => bin.values[key.key]);
              return (
                <g key={bin.start} className={styles.bar} data-active={hover === index}>
                  {segments.map((key, position) => {
                    const height = toY(bin.values[key.key]);
                    const top = cursor - height;
                    cursor = top;
                    const drawn = position === 0 ? height : height - GAP;
                    if (drawn <= 0.25) return null;
                    const fill = seriesColor(key.key, breakdown, order);
                    return position === segments.length - 1
                      ? <path key={key.key} d={roundedTop(x, top, barW, drawn, RADIUS)} fill={fill} />
                      : <rect key={key.key} x={x} y={top} width={barW} height={drawn} fill={fill} />;
                  })}
                </g>
              );
            })}
            <line className={styles.baseline} x1={0} x2={plotW} y1={plotH} y2={plotH} />
            {chart.bins.map((bin, index) => labelled.has(index) ? (
              <text key={bin.start} className={`${styles.axisText} ${index === currentIndex ? styles.axisToday : ""}`} x={band * (index + 0.5)} y={plotH + 17} textAnchor="middle">
                {binLabel(bin.start, range.unit, multiYear)}
              </text>
            ) : null)}
          </g>
        </svg>
      ) : <div style={{ height: CHART_HEIGHT }} />}
      {chart.total === 0 && width > 0 ? <div className={styles.emptyChart}>Nothing recorded in this period</div> : null}
      {hovered ? (
        <div className={styles.tooltip} style={{ left: tooltipLeft, top: tooltipTop }} role="status">
          <div className={styles.tooltipTitle}><span>{binTitle(hovered.start, hovered.end, range.unit)}</span><span>{formatMetric(hovered.total, metric, { precise: true })}</span></div>
          {hovered.total ? (
            <div className={styles.tooltipRows}>
              {[...chart.keys].reverse().filter((key) => hovered.values[key.key]).map((key) => (
                <TooltipRow key={key.key} color={seriesColor(key.key, breakdown, order)} label={key.label} value={`${formatMetric(hovered.values[key.key], metric, { precise: true })} · ${formatPercent(hovered.values[key.key] / hovered.total)}`} />
              ))}
            </div>
          ) : <div className="mt-1 text-[12px] opacity-70">{hovered.start > now ? "Still to come" : "Nothing recorded"}</div>}
        </div>
      ) : null}
      <div className="sr-only">
      <table>
        <caption>{metric === "cost" ? "Cost" : "Tokens"} per {range.unit}</caption>
        <thead><tr><th scope="col">{range.unit}</th>{chart.keys.map((key) => <th key={key.key} scope="col">{key.label}</th>)}<th scope="col">Total</th></tr></thead>
        <tbody>
          {chart.bins.filter((bin) => bin.total).map((bin) => (
            <tr key={bin.start}><th scope="row">{binTitle(bin.start, bin.end, range.unit)}</th>{chart.keys.map((key) => <td key={key.key}>{formatMetric(bin.values[key.key] ?? 0, metric, { precise: true })}</td>)}<td>{formatMetric(bin.total, metric, { precise: true })}</td></tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

/** Axis ticks are round numbers: "$0.5", not "$0.500". */
function formatAxisCost(value: number) {
  return value ? `$${Number(value.toPrecision(3))}` : "$0";
}

function TooltipRow({ color, label, value }: { color: string; label: string; value: string }) {
  return <>
    <span className={styles.swatch} style={{ background: color }} />
    <span>{label}</span>
    <span>{value}</span>
  </>;
}

// ---------------------------------------------------------------------------
// Composition: the period's totals by component, both measures side by side.

function Composition({ summary, metric }: { summary: PeriodSummary; metric: Metric }) {
  const components = COMPONENTS.filter((component) => component.key === "input" || component.key === "output" || summary.tokens[component.key] || summary.costs[component.key]);
  const values = metric === "cost" ? summary.costs : summary.tokens;
  const total = metric === "cost" ? summary.cost : summary.totalTokens;
  return (
    <section className={styles.card} aria-labelledby="spending-composition-title">
      <div className={styles.cardHeader}>
        <div>
          <h2 id="spending-composition-title" className={styles.cardTitle}>Where it went</h2>
          <p className={styles.cardSubtitle}>{metric === "cost" ? "Cost" : "Tokens"} by component for the period</p>
        </div>
      </div>
      <div className={styles.composition} role="img" aria-label={components.map((component) => `${component.label} ${formatPercent(total ? values[component.key] / total : 0)}`).join(", ")}>
        {components.map((component) => values[component.key] ? (
          <span key={component.key} style={{ flexGrow: values[component.key], background: componentColor(component.key) }} title={`${component.label}: ${formatPercent(values[component.key] / total)}`} />
        ) : null)}
      </div>
      <div className={styles.compositionRows} role="table" aria-label="Components">
        <span aria-hidden />
        <span role="columnheader" className="text-[11px] font-semibold uppercase tracking-wide opacity-60">Component</span>
        <span role="columnheader" className={`${styles.muted} text-[11px] font-semibold uppercase tracking-wide`}>Tokens</span>
        <span role="columnheader" className={`${styles.muted} text-[11px] font-semibold uppercase tracking-wide`}>Cost</span>
        <span role="columnheader" className={`${styles.muted} text-[11px] font-semibold uppercase tracking-wide`}>Share</span>
        {components.map((component) => (
          <Row key={component.key} color={componentColor(component.key)} label={component.label} detail={component.detail}
            tokens={component.key === "other" ? "—" : formatTokens(summary.tokens[component.key])}
            cost={formatCost(summary.costs[component.key], { precise: true })}
            share={formatPercent(total ? values[component.key] / total : 0)} />
        ))}
      </div>
      <p className={styles.note}>
        <Info aria-hidden className="h-3.5 w-3.5" />
        <span>OpenRouter reports what each request cost in total. Libera splits it by component using the model’s prices for input, output and cache, so the parts add up to the real charge.{summary.reasoning ? ` Output includes ${formatTokens(summary.reasoning)} reasoning tokens.` : ""}</span>
      </p>
    </section>
  );
}

function Row({ color, label, detail, tokens, cost, share }: { color: string; label: string; detail: string; tokens: string; cost: string; share: string }) {
  return <>
    <span className={styles.swatch} style={{ background: color }} />
    <span title={detail}>{label}</span>
    <span className={styles.muted}>{tokens}</span>
    <span className={styles.muted}>{cost}</span>
    <span className={styles.strong}>{share}</span>
  </>;
}

// ---------------------------------------------------------------------------
// Calendar heatmap: a year of days, a column per week.

const HEAT_LABEL_W = 30;
const HEAT_TOP = 18;
const HEAT_GAP = 3;
const WEEKDAY_LABELS: [number, string][] = [[0, "Mon"], [2, "Wed"], [4, "Fri"]];
const heatMonth = new Intl.DateTimeFormat(undefined, { month: "short" });

function HeatmapCard({ heatmap, metric, range }: { heatmap: Heatmap; metric: Metric; range: PeriodRange }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const [hover, setHover] = useState<{ day: number; value: number; requests: number; x: number; y: number } | null>(null);
  const columns = heatmap.weeks.length;
  // Fit the year to the card; on narrow cards show the most recent weeks.
  const fitted = Math.floor((width - HEAT_LABEL_W) / (10 + HEAT_GAP));
  const visibleWeeks = width ? Math.max(8, Math.min(columns, fitted)) : columns;
  const weeks = heatmap.weeks.slice(columns - visibleWeeks);
  const cell = width ? Math.max(8, Math.min(15, Math.floor((width - HEAT_LABEL_W) / visibleWeeks) - HEAT_GAP)) : 11;
  const pitch = cell + HEAT_GAP;
  const busiest = heatmap.weeks.flat().reduce<{ day: number; value: number } | null>((best, day) => !best || day.value > best.value ? day : best, null);

  const months: { x: number; label: string }[] = [];
  weeks.forEach((week, index) => {
    const month = new Date(week[0].day).getMonth();
    const previous = index ? new Date(weeks[index - 1][0].day).getMonth() : -1;
    if (month !== previous && (!months.length || index * pitch - months.at(-1)!.x > 28)) months.push({ x: index * pitch, label: heatMonth.format(week[0].day) });
  });

  return (
    <section className={styles.card} aria-labelledby="spending-heatmap-title">
      <div className={styles.cardHeader}>
        <div>
          <h2 id="spending-heatmap-title" className={styles.cardTitle}>Calendar</h2>
          <p className={styles.cardSubtitle}>{metric === "cost" ? "Cost" : "Tokens"} per day · the selected period is shaded</p>
        </div>
      </div>
      <div ref={ref} className={styles.heatmap}>
        {width ? (
          <svg width={HEAT_LABEL_W + weeks.length * pitch} height={HEAT_TOP + 7 * pitch} role="img" aria-label={`${heatmap.activeDays} active days in the last year, ${formatMetric(heatmap.total, metric)} in total`} onMouseLeave={() => setHover(null)}>
            {months.map((month) => <text key={month.x} className={styles.axisText} x={HEAT_LABEL_W + month.x} y={11}>{month.label}</text>)}
            {WEEKDAY_LABELS.map(([row, label]) => <text key={label} className={styles.axisText} x={0} y={HEAT_TOP + row * pitch + cell / 2} dy="0.32em">{label}</text>)}
            <g transform={`translate(${HEAT_LABEL_W},${HEAT_TOP})`}>
              {weeks.map((week, column) => week.map((day, row) => day.day >= range.start && day.day < range.end && !day.future ? (
                <rect key={`r${day.day}`} className={styles.heatRange} x={column * pitch - HEAT_GAP / 2} y={row * pitch - HEAT_GAP / 2} width={pitch} height={pitch} />
              ) : null))}
              {weeks.map((week, column) => week.map((day, row) => day.future ? null : (
                <rect
                  key={day.day}
                  className={styles.heatCell}
                  x={column * pitch}
                  y={row * pitch}
                  width={cell}
                  height={cell}
                  rx={2.5}
                  fill={`var(--sp-heat-${day.level})`}
                  onMouseEnter={() => setHover({ day: day.day, value: day.value, requests: day.requests, x: HEAT_LABEL_W + column * pitch + cell / 2, y: HEAT_TOP + row * pitch })}
                />
              )))}
              <TodayRing weeks={weeks} cell={cell} pitch={pitch} />
            </g>
          </svg>
        ) : <div style={{ height: HEAT_TOP + 7 * 14 }} />}
        {hover ? (
          <div className={styles.tooltip} style={{ left: hover.x, top: hover.y }} role="status">
            <div className={styles.tooltipTitle}><span>{formatDay(hover.day)}</span></div>
            <div className="mt-1 text-[12px]">{hover.requests ? `${formatMetric(hover.value, metric, { precise: true })} · ${hover.requests} ${hover.requests === 1 ? "request" : "requests"}` : "No requests"}</div>
          </div>
        ) : null}
      </div>
      <div className={styles.heatFooter}>
        <span>{heatmap.activeDays} active {heatmap.activeDays === 1 ? "day" : "days"} in the last year{busiest?.value ? ` · busiest ${formatShortDay(busiest.day)} (${formatMetric(busiest.value, metric)})` : ""}</span>
        <span className={styles.heatScale} aria-hidden>
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((level) => <i key={level} style={{ background: `var(--sp-heat-${level})` }} />)}
          <span>More</span>
        </span>
      </div>
    </section>
  );
}

function TodayRing({ weeks, cell, pitch }: { weeks: Heatmap["weeks"]; cell: number; pitch: number }) {
  for (let column = weeks.length - 1; column >= 0; column--) {
    for (let row = 6; row >= 0; row--) {
      if (!weeks[column][row].future) {
        return <rect className={styles.heatToday} x={column * pitch - 1} y={row * pitch - 1} width={cell + 2} height={cell + 2} rx={3.5} pointerEvents="none" />;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Models.

function ModelTable({ rows, order, metric, selected, report }: { rows: ReturnType<typeof modelRows>; order: string[]; metric: Metric; selected: string | null; report: UsageReport }) {
  if (!rows.length) {
    return (
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Models</h2>
        <p className={styles.cardSubtitle}>No model was used in this period.</p>
      </section>
    );
  }
  const totals = rows.reduce((sum, row) => ({ requests: sum.requests + row.requests, input: sum.input + row.input, output: sum.output + row.output, cached: sum.cached + row.cached, cost: sum.cost + row.cost }), { requests: 0, input: 0, output: 0, cached: 0, cost: 0 });
  const toggle = (model: string) => updateSpendingSettings({ model: selected === model ? null : model });
  return (
    <section className={styles.card} aria-labelledby="spending-models-title">
      <div className={styles.cardHeader}>
        <div>
          <h2 id="spending-models-title" className={styles.cardTitle}>By model</h2>
          <p className={styles.cardSubtitle}>Select a model to see only its use; select it again to see every model.</p>
        </div>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Requests</th>
              <th scope="col">Input</th>
              <th scope="col">Output</th>
              <th scope="col">Cache read</th>
              <th scope="col">Cost</th>
              <th scope="col">Share of {metric === "cost" ? "cost" : "tokens"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.model} data-selected={selected === row.model} aria-selected={selected === row.model} tabIndex={0}
                onClick={() => toggle(row.model)}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(row.model); } }}>
                <td>
                  <div className={styles.modelCell}>
                    <span className={styles.swatch} style={{ background: modelColor(row.model, order) }} />
                    <div className="min-w-0">
                      <div className={styles.modelName}>{row.label}</div>
                      <div className={styles.modelId}>{row.model}{report.models[row.model]?.pricing ? "" : " · prices unknown"}</div>
                    </div>
                  </div>
                </td>
                <td>{formatTokens(row.requests, { exact: true })}</td>
                <td title={formatTokens(row.input, { exact: true })}>{formatTokens(row.input)}</td>
                <td title={formatTokens(row.output, { exact: true })}>{formatTokens(row.output)}</td>
                <td title={formatTokens(row.cached, { exact: true })}>{row.input ? `${formatTokens(row.cached)} · ${formatPercent(row.cached / row.input)}` : "—"}</td>
                <td className={styles.costCell}>{formatCost(row.cost, { precise: true })}</td>
                <td>
                  <div className={styles.shareCell}>
                    <span>{formatPercent(row.share)}</span>
                    <span className={styles.shareTrack}><span style={{ width: `${Math.max(2, row.share * 100)}%`, background: modelColor(row.model, order) }} /></span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          {rows.length > 1 ? (
            <tfoot>
              <tr>
                <td>All models</td>
                <td>{formatTokens(totals.requests, { exact: true })}</td>
                <td>{formatTokens(totals.input)}</td>
                <td>{formatTokens(totals.output)}</td>
                <td>{totals.input ? `${formatTokens(totals.cached)} · ${formatPercent(totals.cached / totals.input)}` : "—"}</td>
                <td>{formatCost(totals.cost, { precise: true })}</td>
                <td />
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </section>
  );
}

function EmptyLedger() {
  return (
    <section className={`${styles.card} ${styles.empty}`}>
      <div className={styles.emptyArt}><ChartColumnStacked aria-hidden className="h-9 w-9" /></div>
      <h2>No spending recorded yet</h2>
      <p>
        From now on Libera records every OpenRouter request it makes, from AI chat and writing to formatting, reviews and image generation, with its tokens and what it cost.
        Use any AI feature and its spending appears here. Your key’s overall usage across every app is in the Spending panel.
      </p>
    </section>
  );
}
