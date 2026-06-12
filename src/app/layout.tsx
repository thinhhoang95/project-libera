import type { Metadata } from "next";
import Script from "next/script";
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
    var theme =
      savedTheme === "dark" || savedTheme === "light"
        ? savedTheme
        : configuredTheme === "dark" || configuredTheme === "light"
          ? configuredTheme
          : window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light";

    if (savedTheme !== theme) {
      window.localStorage.setItem(storageKey, theme);
    }

    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
  } catch (error) {}
})();
`;
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const configuredTheme = getConfiguredThemePreference();

  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="flex h-full flex-col overflow-hidden font-sans">
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
