import type { NextConfig } from "next";
import { relative } from "node:path";

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
    ],
  },
};

export default nextConfig;
