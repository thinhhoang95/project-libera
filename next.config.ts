import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { relative } from "node:path";

// Interface language: request config in src/i18n/request.ts (no locale in URLs; see docs/i18n-plan.md).
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Browser resolution selects index.dom.js, which accesses document at import
// time and crashes inside a Web Worker. The default export uses an entity
// lookup table and works in both the window and worker environments.
const entityDecoder = require.resolve("decode-named-character-reference");
// KaTeX's HTML-to-tree adapter also needs its DOM-free implementation in workers.
const htmlParser = require.resolve("hast-util-from-html-isomorphic");

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: process.cwd(),
    resolveAlias: {
      "decode-named-character-reference": `./${relative(process.cwd(), entityDecoder).replaceAll("\\", "/")}`,
      "hast-util-from-html-isomorphic": `./${relative(process.cwd(), htmlParser).replaceAll("\\", "/")}`,
    },
  },
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      "decode-named-character-reference$": entityDecoder,
      "hast-util-from-html-isomorphic$": htmlParser,
    };
    return config;
  },
  // Served to sandboxed live HTML blocks in slides (api/slide-libraries/chart).
  outputFileTracingIncludes: {
    "/api/slide-libraries/chart": ["./node_modules/chart.js/dist/chart.umd.min.js"],
  },
  outputFileTracingExcludes: {
    "/*": [
      "./.electron-build/**/*",
      "./.platform-deps/**/*",
      "./.env*",
      "./.git/**/*",
      "./.next/dev/**/*",
      "./**/._*",
      "./data/**/*",
      "./dist-electron/**/*",
      "./electron/**/*",
      "./node_modules/electron/**/*",
      "./node_modules/electron-builder/**/*",
      "./server/**/*",
    ],
  },
};

export default withNextIntl(nextConfig);
