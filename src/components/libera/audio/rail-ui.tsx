"use client";

import type { ReactNode } from "react";
import styles from "./rail-ui.module.css";

export { styles as railStyles };

/** A contextual rail panel: its heading, and its sections in a scroll. */
export function RailPanel({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.panel}>
      <div className="libera-notebook-heading flex items-center justify-between px-3 pb-2 pt-4">
        <h2 className="min-w-0 truncate text-sm font-semibold">{title}</h2>
        {actions ? <div className="flex items-center">{actions}</div> : null}
      </div>
      <div className={styles.scroll}>{children}</div>
    </div>
  );
}

export function RailSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h3 className={styles.sectionTitle}>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {aside}
      </h3>
      {children}
    </section>
  );
}

export function RailSwitch({ checked, disabled, label, hint, onChange }: { checked: boolean; disabled?: boolean; label: string; hint?: string; onChange: (value: boolean) => void }) {
  return (
    <label className={`flex min-h-8 w-full items-center gap-2.5 rounded-[9px] px-2.5 text-[12.5px] ${disabled ? "opacity-50" : "cursor-pointer hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)]"}`} title={hint}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={`relative inline-flex h-4 w-7 shrink-0 rounded-full transition ${checked ? "bg-primary" : "bg-muted-foreground/30"}`}
        onClick={() => onChange(!checked)}
      >
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-[left] ${checked ? "left-[14px]" : "left-0.5"}`} />
      </button>
    </label>
  );
}

export const railIconButton = "libera-sidebar-icon-button inline-flex h-[29px] w-[29px] items-center justify-center rounded-lg disabled:opacity-50";
