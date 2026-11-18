"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Minus, Square, X } from "lucide-react";

export function WindowControls() {
  const t = useTranslations("windowControls");
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      // macOS draws its own native traffic-light buttons, so only show the
      // custom controls on platforms that don't (Windows / Linux).
      const isMac = window.liberaPlatform?.platform === "darwin";

      setAvailable(Boolean(window.liberaWindow) && !isMac);
    }, 0);

    return () => window.clearTimeout(timeout);
  }, []);

  if (!available) {
    return null;
  }

  return (
    <div className="libera-window-controls libera-window-no-drag flex shrink-0 items-center gap-1 pl-2">
      <button
        aria-label={t("minimizeWindow")}
        className="libera-window-control-button"
        title={t("minimize")}
        type="button"
        onClick={() => void window.liberaWindow?.minimize()}
      >
        <Minus aria-hidden className="h-4 w-4" />
      </button>
      <button
        aria-label={t("maximizeWindow")}
        className="libera-window-control-button"
        title={t("maximize")}
        type="button"
        onClick={() => void window.liberaWindow?.toggleMaximize()}
      >
        <Square aria-hidden className="h-3.5 w-3.5" />
      </button>
      <button
        aria-label={t("closeWindow")}
        className="libera-window-control-button libera-window-control-button-close"
        title={t("close")}
        type="button"
        onClick={() => void window.liberaWindow?.close()}
      >
        <X aria-hidden className="h-4 w-4" />
      </button>
    </div>
  );
}
