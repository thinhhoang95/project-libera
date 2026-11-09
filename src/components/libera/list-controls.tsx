"use client";

// Shared controls for the long lists in the side panels (comments,
// suggestions, reviews) and the version histories: a filter icon button that
// opens a small menu (the native Electron menu in the desktop app), and paging that shows the first 20 items with a
// "Show more" button loading 40 more at a time.

import { Check, ListFilter } from "lucide-react";
import { useRef, useState } from "react";
import { nativeMenuPointBelow, popupNativeMenu, type NativeMenuEntry } from "./native-menu";
import { ToolbarMenu } from "./toolbar-menu";

/** Items shown before the first "Show more". */
export const LIST_FIRST_PAGE = 20;
/** Items each "Show more" adds. */
export const LIST_MORE_PAGE = 40;

/**
 * The first page of `items`, growing by LIST_MORE_PAGE on `showMore`. A new
 * `resetKey` (a changed filter or search) starts over at the first page.
 * `pinIndex` keeps that item rendered (a selected card, the card beside the
 * editor's viewport) even when it lies past the current page.
 */
export function usePagedList<T>(items: readonly T[], resetKey: string, pinIndex = -1) {
  const [state, setState] = useState({ key: resetKey, limit: LIST_FIRST_PAGE });
  let limit = state.limit;
  if (state.key !== resetKey) {
    limit = LIST_FIRST_PAGE;
    setState({ key: resetKey, limit });
  }
  const shown = Math.max(limit, pinIndex + 1);
  return {
    visible: items.slice(0, shown),
    remaining: Math.max(0, items.length - shown),
    showMore: () => setState({ key: resetKey, limit: shown + LIST_MORE_PAGE }),
  };
}

export function ShowMoreButton({ remaining, onClick, className = "" }: { remaining: number; onClick: () => void; className?: string }) {
  if (remaining <= 0) return null;
  const next = Math.min(LIST_MORE_PAGE, remaining);
  return <button type="button" className={`review-button libera-show-more w-full ${className}`} title={`${remaining} not shown`} onClick={onClick}>
    Show more ({next} more)
  </button>;
}

export interface ListFilterOption { value: string; label: string; count?: number }
export interface ListFilterGroup {
  /** Shown above the options when the menu has more than one group. */
  label: string;
  value: string;
  /** The unfiltered choice: any other marks the button as filtering. */
  defaultValue: string;
  options: readonly ListFilterOption[];
  onChange: (value: string) => void;
}

/** The filters as a native menu: a disabled heading per group (when there are several), then its radio choices. */
function nativeFilterMenu(groups: readonly ListFilterGroup[]): NativeMenuEntry[] {
  return groups.flatMap((group, index) => {
    const entries: NativeMenuEntry[] = [];
    if (index > 0) entries.push({ type: "separator" });
    if (groups.length > 1) entries.push({ id: `${index}:heading`, label: group.label, enabled: false });
    for (const option of group.options) {
      const checked = option.value === group.value;
      entries.push({
        id: `${index}:${option.value}`,
        label: option.count === undefined ? option.label : `${option.label} (${option.count})`,
        type: "radio",
        checked,
        onSelect: () => { if (!checked) group.onChange(option.value); },
      });
    }
    return entries;
  });
}

const menuItem = "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] hover:bg-muted focus:bg-muted focus:outline-none";

/** An icon button opening a menu of filters (status, author…), each a set of radio choices. */
export function ListFilterButton({ label, groups, className = "" }: { label: string; groups: readonly ListFilterGroup[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const [nativeOpen, setNativeOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const active = groups.filter((group) => group.value !== group.defaultValue);
  const summary = active.map((group) => group.options.find((option) => option.value === group.value)?.label).filter(Boolean).join(" · ");
  return <>
    <button
      ref={anchor}
      type="button"
      className={`libera-sidebar-icon-button libera-list-filter relative inline-flex h-[29px] w-[29px] shrink-0 items-center justify-center rounded-lg ${className}`}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open || nativeOpen}
      data-active={active.length > 0 || undefined}
      title={summary ? `${label}: ${summary}` : label}
      onClick={async () => {
        const button = anchor.current;
        if (open || !button || !window.liberaMenu) { setOpen((value) => !value); return; }
        // Desktop app: the OS menu, resolving once closed (after running the choice).
        setNativeOpen(true);
        const shown = await popupNativeMenu(nativeFilterMenu(groups), nativeMenuPointBelow(button));
        setNativeOpen(false);
        if (!shown) setOpen(true);
      }}
    >
      <ListFilter aria-hidden size={14} />
      {active.length > 0 ? <span aria-hidden className="libera-list-filter-dot absolute right-1 top-1 h-1.5 w-1.5 rounded-full" /> : null}
    </button>
    {open ? <ToolbarMenu anchorRef={anchor} label={label} width={208} onClose={() => setOpen(false)}>
      {groups.map((group, index) => <div key={group.label} role="group" aria-label={group.label}>
        {index > 0 ? <div className="my-1 h-px bg-border" /> : null}
        {groups.length > 1 ? <p className="px-2.5 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</p> : null}
        {group.options.map((option) => {
          const checked = option.value === group.value;
          return <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={checked}
            data-autofocus={checked && index === 0 ? true : undefined}
            className={menuItem}
            onClick={() => { setOpen(false); anchor.current?.focus(); if (!checked) group.onChange(option.value); }}
          >
            <span className="flex w-4 justify-center">{checked ? <Check aria-hidden className="h-3.5 w-3.5" /> : null}</span>
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.count !== undefined ? <span className="text-[11px] tabular-nums text-muted-foreground">{option.count}</span> : null}
          </button>;
        })}
      </div>)}
    </ToolbarMenu> : null}
  </>;
}
