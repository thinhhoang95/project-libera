"use client";

import { useState } from "react";
import { histogram, type ClassStatistics, type Detection, type DetectionScale, type DetectionStatistics, type SpatialPattern, type Summary } from "@/lib/detection/results";

/**
 * A number with about four significant figures, written as in papers and the
 * CSV export: a decimal point and no grouping, so “x, y” pairs read unambiguously.
 */
export function formatNumber(value: number, digits = 4) {
  if (!Number.isFinite(value)) return "–";
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e6 || magnitude < 1e-3) return value.toExponential(2);
  return String(Number(value.toPrecision(digits)));
}

function formatP(p: number) {
  if (!Number.isFinite(p)) return "–";
  return p < 0.001 ? "< 0.001" : p.toFixed(3);
}

function meanSd(summary: Summary) {
  if (!summary.n) return "–";
  return summary.n > 1 ? `${formatNumber(summary.mean)} ± ${formatNumber(summary.sd, 3)}` : formatNumber(summary.mean);
}

function medianIqr(summary: Summary) {
  if (!summary.n) return "–";
  return summary.n > 1 ? `${formatNumber(summary.median)} [${formatNumber(summary.q1, 3)}–${formatNumber(summary.q3, 3)}]` : formatNumber(summary.median);
}

const PATTERN_LABELS: Record<SpatialPattern, string> = {
  clustered: "Clustered",
  random: "Random (CSR)",
  dispersed: "Regular (dispersed)",
  insufficient: "Too few objects",
};

function Pattern({ pattern }: { pattern: SpatialPattern }) {
  return <span className={pattern === "random" || pattern === "insufficient" ? "text-muted-foreground" : "font-medium"}>{PATTERN_LABELS[pattern]}</span>;
}

function Swatch({ color }: { color: string }) {
  return <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color }} />;
}

const th = "whitespace-nowrap px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground";
const td = "whitespace-nowrap px-2 py-1.5 tabular-nums";

/** A histogram of one measurement, with a tooltip on each bar. */
function Histogram({ values, unit, label }: { values: number[]; unit: string; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const bins = histogram(values);
  if (bins.length < 2) return null;
  const width = 320;
  const height = 120;
  const pad = { left: 30, right: 8, top: 8, bottom: 28 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const maxCount = Math.max(...bins.map((bin) => bin.count));
  const barWidth = plotWidth / bins.length;
  const active = hover === null ? null : bins[hover];
  return (
    <figure className="space-y-1">
      <figcaption className="text-xs font-medium">{label}</figcaption>
      <div className="relative">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full max-w-md" role="img" aria-label={`${label} histogram`} onPointerLeave={() => setHover(null)}>
          <line x1={pad.left} x2={width - pad.right} y1={pad.top + plotHeight} y2={pad.top + plotHeight} className="stroke-border" strokeWidth={1} />
          <text x={pad.left - 4} y={pad.top + 8} textAnchor="end" className="fill-muted-foreground" fontSize={9}>{maxCount}</text>
          <text x={pad.left - 4} y={pad.top + plotHeight} textAnchor="end" className="fill-muted-foreground" fontSize={9}>0</text>
          {bins.map((bin, index) => {
            const barHeight = (bin.count / maxCount) * plotHeight;
            return (
              <g key={index} onPointerEnter={() => setHover(index)}>
                {/* The hit target spans the whole column, taller than the bar. */}
                <rect x={pad.left + index * barWidth} y={pad.top} width={barWidth} height={plotHeight} fill="transparent" />
                <rect
                  x={pad.left + index * barWidth + 1}
                  y={pad.top + plotHeight - barHeight}
                  width={Math.max(1, barWidth - 2)}
                  height={barHeight}
                  rx={Math.min(3, barWidth / 4)}
                  fill="#3987e5"
                  opacity={hover === null || hover === index ? 1 : 0.45}
                />
              </g>
            );
          })}
          <text x={pad.left} y={height - 14} className="fill-muted-foreground" fontSize={9}>{formatNumber(bins[0].from, 3)}</text>
          <text x={width - pad.right} y={height - 14} textAnchor="end" className="fill-muted-foreground" fontSize={9}>{formatNumber(bins.at(-1)!.to, 3)}</text>
          <text x={pad.left + plotWidth / 2} y={height - 3} textAnchor="middle" className="fill-muted-foreground" fontSize={9}>{unit}</text>
        </svg>
        {active ? (
          <div className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 rounded-md border border-border bg-card px-2 py-1 text-[11px] shadow-sm">
            <span className="tabular-nums">{formatNumber(active.from, 3)}–{formatNumber(active.to, 3)} {unit}</span>
            <span className="ml-2 font-medium tabular-nums">{active.count} {active.count === 1 ? "object" : "objects"}</span>
          </div>
        ) : null}
      </div>
    </figure>
  );
}

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      {detail ? <p className="text-[11px] text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

/** Counts, size and shape, and spatial distribution, per label and overall. */
export function DetectionStatisticsView({ statistics, detections, scale }: { statistics: DetectionStatistics; detections: Detection[]; scale: DetectionScale }) {
  const unit = scale.unit;
  const areaUnit = `${unit}²`;
  const densityUnit = unit === "px" ? "per MP" : `per ${unit}²`;
  const overall = statistics.overall;
  const rows: ClassStatistics[] = [...statistics.classes.filter((entry) => entry.count > 0), overall];
  const length = unit === "px" ? 1 : scale.perPixel;
  const [histogramLabel, setHistogramLabel] = useState("All objects");
  const histogramDetections = histogramLabel === "All objects" ? detections : detections.filter((detection) => detection.label === histogramLabel);
  const scoredDetections = histogramDetections.filter((detection) => detection.origin !== "manual");

  if (!overall.count) return <p className="p-4 text-sm text-muted-foreground">No detections at this confidence.</p>;

  return (
    <div className="space-y-5 p-4 text-xs">
      <div className="grid grid-cols-2 gap-2">
        <Tile
          label="Objects"
          value={String(overall.count)}
          detail={`${statistics.classes.filter((entry) => entry.count).length} of ${statistics.classes.length} labels${overall.origins.edited || overall.origins.manual ? ` · ${overall.origins.edited} edited, ${overall.origins.manual} manual` : ""}`}
        />
        <Tile label="Density" value={formatNumber(overall.density, 3)} detail={densityUnit} />
        <Tile label="Area covered" value={`${formatNumber(overall.coverage * 100, 3)}%`} detail="sum of mask areas" />
        <Tile label="Mean confidence" value={formatNumber(overall.confidence.mean, 3)} detail={overall.confidence.n ? `range ${formatNumber(overall.confidence.min, 2)}–${formatNumber(overall.confidence.max, 2)}${overall.origins.manual ? ", model scores only" : ""}` : "no model detections"} />
      </div>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Counts and density</h3>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse">
            <thead className="bg-muted/60"><tr><th className={th}>Label</th><th className={th}>n</th><th className={th}>%</th><th className={th}>Density ({densityUnit})</th><th className={th}>Coverage</th><th className={th}>Confidence</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className={`border-t border-border ${row === overall ? "font-medium" : ""}`}>
                  <td className="whitespace-nowrap px-2 py-1.5"><span className="flex items-center gap-1.5">{row !== overall ? <Swatch color={row.color} /> : null}{row.label}</span></td>
                  <td className={td}>{row.count}</td>
                  <td className={td}>{formatNumber((row.count / overall.count) * 100, 3)}</td>
                  <td className={td}>{formatNumber(row.density, 3)}</td>
                  <td className={td}>{formatNumber(row.coverage * 100, 3)}%</td>
                  <td className={td}>{meanSd(row.confidence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Size and shape</h3>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse">
            <thead className="bg-muted/60"><tr><th className={th}>Label</th><th className={th}>Area ({areaUnit}) mean ± SD</th><th className={th}>Median [IQR]</th><th className={th}>Range</th><th className={th}>CV</th><th className={th}>Eq. diameter ({unit})</th><th className={th}>Perimeter ({unit})</th><th className={th}>Circularity</th><th className={th}>Aspect ratio</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className={`border-t border-border ${row === overall ? "font-medium" : ""}`}>
                  <td className="whitespace-nowrap px-2 py-1.5"><span className="flex items-center gap-1.5">{row !== overall ? <Swatch color={row.color} /> : null}{row.label}</span></td>
                  <td className={td}>{meanSd(row.area)}</td>
                  <td className={td}>{medianIqr(row.area)}</td>
                  <td className={td}>{row.area.n ? `${formatNumber(row.area.min, 3)}–${formatNumber(row.area.max, 3)}` : "–"}</td>
                  <td className={td}>{row.area.n > 1 ? formatNumber(row.area.cv, 3) : "–"}</td>
                  <td className={td}>{meanSd(row.equivalentDiameter)}</td>
                  <td className={td}>{meanSd(row.perimeter)}</td>
                  <td className={td}>{meanSd(row.circularity)}</td>
                  <td className={td}>{meanSd(row.aspectRatio)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="detection-histogram-label" className="text-muted-foreground">Distribution of</label>
          <select id="detection-histogram-label" className="rounded-md border border-input bg-background px-2 py-1" value={histogramLabel} onChange={(event) => setHistogramLabel(event.target.value)}>
            {rows.map((row) => <option key={row.label} value={row.label}>{row.label}</option>)}
          </select>
        </div>
        <div className="grid gap-3">
          <Histogram label="Area" unit={areaUnit} values={histogramDetections.map((detection) => detection.area * length * length)} />
          <Histogram label="Confidence" unit="score" values={scoredDetections.map((detection) => detection.confidence)} />
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Spatial distribution</h3>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse">
            <thead className="bg-muted/60"><tr><th className={th}>Label</th><th className={th}>Centroid x̄, ȳ ({unit})</th><th className={th}>NN distance ({unit})</th><th className={th}>Clark–Evans R</th><th className={th}>z</th><th className={th}>p</th><th className={th}>Pattern</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className={`border-t border-border ${row === overall ? "font-medium" : ""}`}>
                  <td className="whitespace-nowrap px-2 py-1.5"><span className="flex items-center gap-1.5">{row !== overall ? <Swatch color={row.color} /> : null}{row.label}</span></td>
                  <td className={td}>{row.count ? `${formatNumber(row.centroid.x, 4)}, ${formatNumber(row.centroid.y, 4)}` : "–"}</td>
                  <td className={td}>{row.nearestNeighbor ? meanSd(row.nearestNeighbor.distances) : "–"}</td>
                  <td className={td}>{row.nearestNeighbor ? formatNumber(row.nearestNeighbor.r, 3) : "–"}</td>
                  <td className={td}>{row.nearestNeighbor ? formatNumber(row.nearestNeighbor.z, 3) : "–"}</td>
                  <td className={td}>{row.nearestNeighbor ? formatP(row.nearestNeighbor.p) : "–"}</td>
                  <td className={td}>{row.nearestNeighbor ? <Pattern pattern={row.nearestNeighbor.pattern} /> : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse">
            <thead className="bg-muted/60"><tr><th className={th}>Label</th><th className={th}>Quadrats</th><th className={th}>Variance/mean</th><th className={th}>χ² (df)</th><th className={th}>p</th><th className={th}>Morisita I<sub>δ</sub></th><th className={th}>Pattern</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className={`border-t border-border ${row === overall ? "font-medium" : ""}`}>
                  <td className="whitespace-nowrap px-2 py-1.5"><span className="flex items-center gap-1.5">{row !== overall ? <Swatch color={row.color} /> : null}{row.label}</span></td>
                  <td className={td}>{row.quadrats ? `${row.quadrats.columns} × ${row.quadrats.rows}` : "–"}</td>
                  <td className={td}>{row.quadrats ? formatNumber(row.quadrats.vmr, 3) : "–"}</td>
                  <td className={td}>{row.quadrats ? `${formatNumber(row.quadrats.chiSquare, 4)} (${row.quadrats.df})` : "–"}</td>
                  <td className={td}>{row.quadrats ? formatP(row.quadrats.p) : "–"}</td>
                  <td className={td}>{row.quadrats ? formatNumber(row.quadrats.morisita, 3) : "–"}</td>
                  <td className={td}>{row.quadrats ? <Pattern pattern={row.quadrats.pattern} /> : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <details className="rounded-lg border border-border bg-card px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">Methods</summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li>Areas and perimeters come from each instance mask’s outline (shoelace formula); objects without a mask use their box. Coverage sums mask areas, so overlapping masks count twice.</li>
          <li>Equivalent diameter = 2√(A/π). Circularity = 4πA/P² (1 for a circle). Aspect ratio = the box’s long side over its short side. SD is the sample standard deviation; CV = SD/mean; IQR is the 25th–75th percentile.</li>
          <li>Clark–Evans R = mean observed nearest-neighbour distance between centroids ÷ the expectation under complete spatial randomness, with Donnelly’s (1978) edge correction for the image rectangle. R &lt; 1 suggests clustering, R &gt; 1 regular spacing; z tests R = 1 (two-sided).</li>
          <li>Quadrat analysis counts centroids in a grid with five cells on the image’s shorter side. Variance/mean (index of dispersion) is 1 under randomness; (q − 1)·VMR follows χ² with q − 1 degrees of freedom (two-sided test). Morisita’s I<sub>δ</sub> is 1 under randomness, above 1 when clustered.</li>
          <li>Statistics cover model detections at or above the confidence filter, and every hand-tagged (manual) or hand-corrected (edited) object. Edited and hand-drawn outlines are smooth curves through their control points; their measurements come from those curves. Confidence statistics leave out manual objects. With fewer than five objects the tests are not interpreted.</li>
          <li>{unit === "px" ? "Sizes are in pixels; set a scale to measure in physical units." : `Scale: 1 px = ${formatNumber(scale.perPixel)} ${unit}.`}</li>
        </ul>
      </details>
    </div>
  );
}
