// js-yaml ships no types; slide charts use only `load` (src/lib/slide-charts.ts).
declare module "js-yaml" {
  export function load(source: string, options?: Record<string, unknown>): unknown;
}
