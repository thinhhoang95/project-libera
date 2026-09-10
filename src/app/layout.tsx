import type { Metadata } from "next";
import Script from "next/script";
import { ThemeSync } from "@/components/libera/theme-sync";
import "katex/dist/katex.min.css";
import "./globals.css";
import { getConfiguredThemePreference } from "@/lib/theme-config";
import { THEME_STORAGE_KEY } from "@/lib/theme";

export const metadata: Metadata = {
  title: "Libera for Vy Tran",
  description: "A liberal notetaking app.",
};

export const dynamic = "force-dynamic";

function themeScript(configuredTheme?: string) {
  return `
(function () {
  try {
    var storageKey = ${JSON.stringify(THEME_STORAGE_KEY)};
    var configuredTheme = ${JSON.stringify(configuredTheme ?? "")};
    var savedTheme = window.localStorage.getItem(storageKey);
    var valid = function (value) { return value === "light" || value === "dark" || value === "system"; };
    var preference = valid(configuredTheme) ? configuredTheme : valid(savedTheme) ? savedTheme : "system";
    var theme = preference === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
      : preference;
    document.documentElement.dataset.themePreference = preference;
    window.localStorage.setItem(storageKey, preference);

    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
  } catch (error) {}
})();
`;
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const configuredTheme = await getConfiguredThemePreference();

  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="flex h-full flex-col overflow-hidden font-sans">
        <ThemeSync />
        {children}
        <Script
          id="libera-theme"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: themeScript(configuredTheme) }}
        />
      </body>
    </html>
  );
}
