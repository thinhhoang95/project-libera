import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingExcludes: {
    "/*": [
      "./.electron-build/**/*",
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
