"use client";

import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { ChartColumnStacked, Coins, Layers, RotateCw, Settings2, Sigma, Boxes } from "lucide-react";
import {
  formatCost, formatMetric, modelOrder, modelRows, PERIODS, resolvePeriod, summarize,
  type AccountUsage, type Breakdown, type Metric,
} from "@/lib/spending";
import { refreshSpending, updateSpendingSettings, useSpending } from "./spending-store";
import { filterReport, formatPercent, modelColor } from "./spending-format";
import styles from "./spending.module.css";

const iconButton = "libera-sidebar-icon-button inline-flex h-[29px] w-[29px] items-center justify-center rounded-lg disabled:opacity-50";
const sinceFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const subscribeNever = () => () => {};

/**
 * The Spending page's contextual rail panel: the period, the measure and the
 * breakdown the page shows, the models to focus on, and the OpenRouter key's
 * own counters.
 */
export function SpendingPanel() {
  const { settings, report, account } = useSpending();
  const full = report.value;
  // The report's load time stands in for "now"; it refreshes every minute while the page is open.
  const now = report.loadedAt || account.loadedAt;
  // Only the desktop app has a Preferences window.
  const hasPreferences = useSyncExternalStore(subscribeNever, () => !!window.liberaPreferences, () => false);

  useEffect(() => {
    if (!report.loadedAt) void refreshSpending();
  }, [report.loadedAt]);

  const derived = useMemo(() => {
    if (!full || !now) return null;
    const data = filterReport(full, settings.model);
    const range = resolvePeriod(settings.period, now, full.since);
    return {
      order: modelOrder(full.buckets),
      totals: new Map(PERIODS.map((period) => {
        const summary = summarize(data, resolvePeriod(period.key, now, full.since));
        return [period.key, settings.metric === "cost" ? summary.cost : summary.totalTokens];
      })),
      models: modelRows(full, range, settings.metric),
    };
  }, [full, now, settings.model, settings.period, settings.metric]);

  return (
    <div className={`${styles.tokens} ${styles.panel}`}>
      <div className="libera-notebook-heading flex items-center justify-between px-3 pb-2 pt-4">
        <h2 className="min-w-0 truncate text-sm font-semibold">Spending</h2>
        <div className="flex items-center">
          <button type="button" className={iconButton} aria-label="Refresh" title="Refresh" disabled={report.status === "loading"} onClick={() => void refreshSpending()}>
            <RotateCw aria-hidden className={`h-4 w-4 ${report.status === "loading" ? "animate-spin" : ""}`} />
          </button>
          {hasPreferences ? (
            <button type="button" className={iconButton} aria-label="AI preferences" title="Preferences → AI" onClick={() => void window.liberaPreferences?.open("ai")}>
              <Settings2 aria-hidden className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>
      <p className="px-3 pb-2 text-xs leading-relaxed text-muted-foreground">
        OpenRouter tokens and cost{full?.since ? ` recorded since ${sinceFormat.format(full.since)}` : ""}.
      </p>

      <div className={styles.panelScroll}>
        <Section title="Period">
          <div className={styles.periods} role="radiogroup" aria-label="Period">
            {PERIODS.map((period) => {
              const total = derived?.totals.get(period.key) ?? 0;
              return (
                <button key={period.key} type="button" role="radio" aria-checked={settings.period === period.key} className={styles.periodRow}
                  aria-label={derived ? `${period.label}, ${formatMetric(total, settings.metric, { precise: true })}` : period.label}
                  onClick={() => updateSpendingSettings({ period: period.key })}>
                  <span>{period.label}</span>
                  <span className={styles.periodValue}>{derived ? formatMetric(total, settings.metric) : ""}</span>
                </button>
              );
            })}
          </div>
        </Section>

        <Section title="Measure">
          <Segmented<Metric> label="Measure" value={settings.metric} onChange={(metric) => updateSpendingSettings({ metric })}
            options={[{ value: "cost", label: "Cost", icon: Coins }, { value: "tokens", label: "Tokens", icon: Sigma }]} />
        </Section>

        <Section title="Break down by">
          <Segmented<Breakdown> label="Break down by" value={settings.breakdown} onChange={(breakdown) => updateSpendingSettings({ breakdown })}
            options={[{ value: "component", label: "Component", icon: Layers }, { value: "model", label: "Model", icon: Boxes }]} />
          <p className={`${styles.panelNote} mt-2`}>
            {settings.breakdown === "component" ? "Input, output, cache reads and cache writes." : "The seven costliest models overall; the rest are grouped as Other models."}
          </p>
        </Section>

        {derived && derived.models.length ? (
          <Section title="Models">
            <div role="radiogroup" aria-label="Models">
              <button type="button" role="radio" aria-checked={settings.model === null} aria-label="All models" className={styles.modelRow} onClick={() => updateSpendingSettings({ model: null })}>
                <span className={styles.swatch} style={{ background: "conic-gradient(var(--sp-1) 0 25%, var(--sp-2) 0 50%, var(--sp-3) 0 75%, var(--sp-7) 0)" }} />
                <span>All models</span>
                <span />
              </button>
              {derived.models.map((row) => (
                <button key={row.model} type="button" role="radio" aria-checked={settings.model === row.model} className={styles.modelRow} title={row.model}
                  aria-label={`${row.label}, ${formatPercent(row.share)}`}
                  onClick={() => updateSpendingSettings({ model: settings.model === row.model ? null : row.model })}>
                  <span className={styles.swatch} style={{ background: modelColor(row.model, derived.order) }} />
                  <span>{row.label}</span>
                  <span>{formatPercent(row.share)}</span>
                </button>
              ))}
            </div>
          </Section>
        ) : null}

        <Section title="OpenRouter key">
          <AccountCard status={account.status} account={account.value} error={account.error} />
        </Section>

        <p className={styles.panelNote}>
          <ChartColumnStacked aria-hidden className="mr-1 inline h-3 w-3 align-[-1px]" />
          Libera keeps this history on this computer. The key’s counters above come from OpenRouter and include every app that uses the key.
        </p>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: { value: T; label: string; icon: typeof Coins }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className={styles.segmented} role="radiogroup" aria-label={label}>
      {options.map(({ value: option, label: optionLabel, icon: Icon }) => (
        <button key={option} type="button" role="radio" aria-checked={value === option} onClick={() => onChange(option)}>
          <Icon aria-hidden className="h-3.5 w-3.5" />{optionLabel}
        </button>
      ))}
    </div>
  );
}

function AccountCard({ status, account, error }: { status: string; account: AccountUsage | null; error: string }) {
  if (status === "error") return <div className={styles.accountCard}>{error}</div>;
  if (!account) return <div className={styles.accountCard}>{status === "ready" ? "Add an OpenRouter API key in Preferences to see its usage." : "Loading…"}</div>;
  const used = account.limit ? Math.min(1, (account.limit - (account.remaining ?? account.limit)) / account.limit) : 0;
  const level = used > 0.9 ? "danger" : used > 0.75 ? "warning" : "ok";
  return (
    <div className={styles.accountCard}>
      <div className={styles.accountGrid}>
        <div><span>Today</span><strong>{formatCost(account.daily)}</strong></div>
        <div><span>This week</span><strong>{formatCost(account.weekly)}</strong></div>
        <div><span>This month</span><strong>{formatCost(account.monthly)}</strong></div>
      </div>
      {account.limit !== null ? (
        <div className={styles.meter}>
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>{formatCost(account.remaining ?? 0)} left of {formatCost(account.limit)}</span>
            <span>{account.reset ? `resets ${account.reset}` : ""}</span>
          </div>
          <div className={styles.meterTrack} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used * 100)} aria-label={`${Math.round(used * 100)}% of the key’s limit used`}>
            <span data-level={level} style={{ width: `${Math.max(2, used * 100)}%` }} />
          </div>
        </div>
      ) : (
        <div className="mt-2 text-[11px] text-muted-foreground">{formatCost(account.usage)} used in total · no spending limit{account.label ? ` · ${account.label}` : ""}</div>
      )}
      <div className="mt-2 text-[11px] text-muted-foreground">Days, weeks and months in UTC.</div>
    </div>
  );
}
