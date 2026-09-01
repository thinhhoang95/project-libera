import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: process.cwd(),
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
