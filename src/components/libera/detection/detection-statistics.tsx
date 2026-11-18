"use client";

import { useTranslations } from "next-intl";
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

function Pattern({ pattern }: { pattern: SpatialPattern }) {
  const t = useTranslations("detection.detectionStatistics");
  return <span className={pattern === "random" || pattern === "insufficient" ? "text-muted-foreground" : "font-medium"}>{t(`pattern.${pattern}`)}</span>;
}

function Swatch({ color }: { color: string }) {
  return <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color }} />;
}

/** Stands for the "All objects" row in the distribution picker. */
const ALL_OBJECTS = "\u0000all";

const th = "whitespace-nowrap px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground";
const td = "whitespace-nowrap px-2 py-1.5 tabular-nums";

/** A histogram of one measurement, with a tooltip on each bar. */
function Histogram({ values, unit, label }: { values: number[]; unit: string; label: string }) {
  const t = useTranslations("detection.detectionStatistics");
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
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full max-w-md" role="img" aria-label={t("histogramLabel", { label })} onPointerLeave={() => setHover(null)}>
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
            <span className="ml-2 font-medium tabular-nums">{t("objectCount", { count: active.count })}</span>
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
  const t = useTranslations("detection.detectionStatistics");
  const unit = scale.unit;
  const areaUnit = `${unit}²`;
  const densityUnit = unit === "px" ? t("perMegapixel") : t("perAreaUnit", { unit });
  const overall = statistics.overall;
  const rows: ClassStatistics[] = [...statistics.classes.filter((entry) => entry.count > 0), overall];
  const length = unit === "px" ? 1 : scale.perPixel;
  const [histogramLabel, setHistogramLabel] = useState(ALL_OBJECTS);
  const histogramDetections = histogramLabel === ALL_OBJECTS ? detections : detections.filter((detection) => detection.label === histogramLabel);
  const scoredDetections = histogramDetections.filter((detection) => detection.origin !== "manual");

  if (!overall.count) return <p className="p-4 text-sm text-muted-foreground">{t("noDetections")}</p>;

  return (
    <div className="space-y-5 p-4 text-xs">
      <div className="grid grid-cols-2 gap-2">
        <Tile
          label={t("objectsTile")}
          value={String(overall.count)}
          detail={t(overall.origins.edited || overall.origins.manual ? "labelsSummaryEdits" : "labelsSummary", {
            classes: statistics.classes.filter((entry) => entry.count).length,
            total: statistics.classes.length,
            edited: overall.origins.edited,
            manual: overall.origins.manual,
          })}
        />
        <Tile label={t("densityTile")} value={formatNumber(overall.density, 3)} detail={densityUnit} />
        <Tile label={t("areaCovered")} value={t("percentValue", { value: formatNumber(overall.coverage * 100, 3) })} detail={t("sumOfMaskAreas")} />
        <Tile
          label={t("meanConfidence")}
          value={formatNumber(overall.confidence.mean, 3)}
          detail={overall.confidence.n
            ? t(overall.origins.manual ? "confidenceRangeModelOnly" : "confidenceRange", { min: formatNumber(overall.confidence.min, 2), max: formatNumber(overall.confidence.max, 2) })
            : t("noModelDetections")}
        />
      </div>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("countsAndDensity")}</h3>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse">
            <thead className="bg-muted/60"><tr><th className={th}>{t("thLabel")}</th><th className={th}>n</th><th className={th}>%</th><th className={th}>{t("thDensity", { unit: densityUnit })}</th><th className={th}>{t("thCoverage")}</th><th className={th}>{t("thConfidence")}</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className={`border-t border-border ${row === overall ? "font-medium" : ""}`}>
                  <td className="whitespace-nowrap px-2 py-1.5"><span className="flex items-center gap-1.5">{row !== overall ? <Swatch color={row.color} /> : null}{row === overall ? t("allObjects") : row.label}</span></td>
                  <td className={td}>{row.count}</td>
                  <td className={td}>{formatNumber((row.count / overall.count) * 100, 3)}</td>
                  <td className={td}>{formatNumber(row.density, 3)}</td>
                  <td className={td}>{t("percentValue", { value: formatNumber(row.coverage * 100, 3) })}</td>
                  <td className={td}>{meanSd(row.confidence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("sizeAndShape")}</h3>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse">
            <thead className="bg-muted/60"><tr><th className={th}>{t("thLabel")}</th><th className={th}>{t("thArea", { unit })}</th><th className={th}>{t("thMedianIqr")}</th><th className={th}>{t("thRange")}</th><th className={th}>{t("thCv")}</th><th className={th}>{t("thEquivalentDiameter", { unit })}</th><th className={th}>{t("thPerimeter", { unit })}</th><th className={th}>{t("thCircularity")}</th><th className={th}>{t("thAspectRatio")}</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className={`border-t border-border ${row === overall ? "font-medium" : ""}`}>
                  <td className="whitespace-nowrap px-2 py-1.5"><span className="flex items-center gap-1.5">{row !== overall ? <Swatch color={row.color} /> : null}{row === overall ? t("allObjects") : row.label}</span></td>
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
          <label htmlFor="detection-histogram-label" className="text-muted-foreground">{t("distributionOf")}</label>
          <select id="detection-histogram-label" className="rounded-md border border-input bg-background px-2 py-1" value={histogramLabel} onChange={(event) => setHistogramLabel(event.target.value)}>
            {rows.map((row) => <option key={row.label} value={row === overall ? ALL_OBJECTS : row.label}>{row === overall ? t("allObjects") : row.label}</option>)}
          </select>
        </div>
        <div className="grid gap-3">
          <Histogram label={t("areaLabel")} unit={areaUnit} values={histogramDetections.map((detection) => detection.area * length * length)} />
          <Histogram label={t("confidenceLabel")} unit={t("scoreUnit")} values={scoredDetections.map((detection) => detection.confidence)} />
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("spatialDistribution")}</h3>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse">
            <thead className="bg-muted/60"><tr><th className={th}>{t("thLabel")}</th><th className={th}>{t("thCentroid", { unit })}</th><th className={th}>{t("thNearestNeighbor", { unit })}</th><th className={th}>{t("thClarkEvans")}</th><th className={th}>z</th><th className={th}>p</th><th className={th}>{t("thPattern")}</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className={`border-t border-border ${row === overall ? "font-medium" : ""}`}>
                  <td className="whitespace-nowrap px-2 py-1.5"><span className="flex items-center gap-1.5">{row !== overall ? <Swatch color={row.color} /> : null}{row === overall ? t("allObjects") : row.label}</span></td>
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
            <thead className="bg-muted/60"><tr><th className={th}>{t("thLabel")}</th><th className={th}>{t("thQuadrats")}</th><th className={th}>{t("thVarianceMean")}</th><th className={th}>{t("thChiSquare")}</th><th className={th}>p</th><th className={th}>{t.rich("thMorisita", { sub: (chunks) => <sub>{chunks}</sub> })}</th><th className={th}>{t("thPattern")}</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className={`border-t border-border ${row === overall ? "font-medium" : ""}`}>
                  <td className="whitespace-nowrap px-2 py-1.5"><span className="flex items-center gap-1.5">{row !== overall ? <Swatch color={row.color} /> : null}{row === overall ? t("allObjects") : row.label}</span></td>
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
        <summary className="cursor-pointer font-medium text-foreground">{t("methods")}</summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li>{t("methodsAreas")}</li>
          <li>{t("methodsDiameter")}</li>
          <li>{t("methodsClarkEvans")}</li>
          <li>{t.rich("methodsQuadrat", { sub: (chunks) => <sub>{chunks}</sub> })}</li>
          <li>{t("methodsSample")}</li>
          <li>{unit === "px" ? t("methodsSizesPx") : t("methodsScale", { perPixel: formatNumber(scale.perPixel), unit })}</li>
        </ul>
      </details>
    </div>
  );
}
