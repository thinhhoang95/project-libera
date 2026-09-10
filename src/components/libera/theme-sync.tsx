"use client";

import { useEffect } from "react";
import { isThemePreference, THEME_STORAGE_KEY, type ThemePreference } from "@/lib/theme";

export function applyThemePreference(preference: ThemePreference) {
  const dark = preference === "dark" ||
    (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {}
  void window.liberaWindow?.setTheme(preference);
  window.dispatchEvent(new Event("libera:theme-changed"));
}

export function ThemeSync() {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const currentPreference = () => {
      const value = document.documentElement.dataset.themePreference;
      return isThemePreference(value) ? value : "system";
    };
    applyThemePreference(currentPreference());
    const onSystemChange = () => {
      if (currentPreference() === "system") applyThemePreference("system");
    };
    const unsubscribe = window.liberaWindow?.onThemeChanged(applyThemePreference);
    media.addEventListener("change", onSystemChange);
    return () => {
      unsubscribe?.();
      media.removeEventListener("change", onSystemChange);
    };
  }, []);
  return null;
}
