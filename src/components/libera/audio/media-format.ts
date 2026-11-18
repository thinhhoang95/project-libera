import { numberFormat } from "@/lib/i18n/format";

/** "1h 12m", "4m 05s", "38s", with the interface language's unit symbols. */
export function formatDurationIn(locale: string, seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const unit = (unitName: "hour" | "minute" | "second", value: number, pad = false) =>
    numberFormat(locale, { style: "unit", unit: unitName, unitDisplay: "narrow", ...(pad ? { minimumIntegerDigits: 2 } : {}) }).format(value);
  if (hours) return `${unit("hour", hours)} ${unit("minute", minutes, true)}`;
  if (minutes) return `${unit("minute", minutes)} ${unit("second", total % 60, true)}`;
  return unit("second", total);
}

/** A file size in GB, MB or (with `kb`) KB, decimal, with the interface language's unit symbols. */
export function formatBytesIn(locale: string, bytes: number, { gb = 1, mb = 0, kb = false }: { gb?: number; mb?: number; kb?: boolean } = {}) {
  const size = (unit: "gigabyte" | "megabyte" | "kilobyte", value: number, fraction: number) =>
    numberFormat(locale, { style: "unit", unit, unitDisplay: "short", minimumFractionDigits: fraction, maximumFractionDigits: fraction }).format(value);
  if (bytes >= 1e9) return size("gigabyte", bytes / 1e9, gb);
  if (bytes >= 1e6 || !kb) return size("megabyte", mb ? bytes / 1e6 : Math.max(1, Math.round(bytes / 1e6)), mb);
  return size("kilobyte", Math.max(1, Math.round(bytes / 1e3)), 0);
}
