"use client";

/** The gallery's Group by, Jump to date and Filter controls, and the seeker beside the photos. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, CalendarSearch, Check, ListFilter, X } from "lucide-react";
import {
  filterCount, GALLERY_GROUPINGS, GROUPING_LABEL, indexAtOffset, ME, NO_FILTER, parseDay, toDay, UNKNOWN_CONTRIBUTOR,
  type GalleryFilter, type GalleryGrouping,
} from "@/lib/gallery-timeline";

const toolbarButton = "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm hover:bg-muted disabled:opacity-50";
const dateInput = "h-9 w-full rounded-lg border border-input bg-card px-2 text-sm outline-none focus:ring-2 focus:ring-ring";
const menuItem = "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted";

function Popover({ anchor, label, onClose, children, width = 256 }: { anchor: HTMLElement; label: string; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position] = useState(() => {
    const rect = anchor.getBoundingClientRect();
    return { left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: rect.bottom + 4 };
  });
  useEffect(() => {
    function close(event: PointerEvent) { if (!ref.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) onClose(); }
    function escape(event: KeyboardEvent) { if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); onClose(); } }
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape, true);
    ref.current?.querySelector<HTMLElement>("[data-autofocus], button, input")?.focus();
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape, true); };
  }, [anchor, onClose]);
  return createPortal(<div ref={ref} role="dialog" aria-label={label} data-libera-overlay
    className="fixed z-50 max-h-[70vh] overflow-auto rounded-xl border border-border bg-card p-1 text-foreground shadow-lg" style={{ ...position, width }}>
    {children}
  </div>, document.body);
}

/** Group by: Auto (sections start where the dates jump), Day, Week, Month or Year. */
export function GroupingButton({ grouping, onChange }: { grouping: GalleryGrouping; onChange: (grouping: GalleryGrouping) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  return <>
    <button className={toolbarButton} aria-haspopup="menu" aria-expanded={Boolean(anchor)} aria-label={`Group by: ${GROUPING_LABEL[grouping]}`} title="Group photos by date"
      onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}><CalendarDays className="h-4 w-4" /><span className="max-sm:hidden">{GROUPING_LABEL[grouping]}</span></button>
    {anchor && <Popover anchor={anchor} label="Group by" onClose={close} width={224}>
      <p className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">Group by</p>
      <div role="menu" aria-label="Group by">
        {GALLERY_GROUPINGS.map((option) => <button key={option} role="menuitemradio" aria-checked={grouping === option} className={menuItem}
          {...(grouping === option ? { "data-autofocus": true } : {})}
          onClick={() => { onChange(option); close(); }}>
          <Check className={`h-4 w-4 ${grouping === option ? "" : "invisible"}`} />
          <span className="flex-1">{GROUPING_LABEL[option]}</span>
          {option === "auto" && <span className="text-xs text-muted-foreground">by gaps in time</span>}
        </button>)}
      </div>
    </Popover>}
  </>;
}

/** Jump to date: a day, or one of the years and months the photos span. */
export function JumpToDateButton({ times, onJump }: { times: number[]; onJump: (day: string) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [day, setDay] = useState("");
  const close = useCallback(() => setAnchor(null), []);
  const { min, max, years } = useMemo(() => {
    if (!times.length) return { min: "", max: "", years: [] as Array<{ year: number; months: number[] }> };
    const byYear = new Map<number, Set<number>>();
    let low = Infinity;
    let high = -Infinity;
    for (const time of times) {
      low = Math.min(low, time);
      high = Math.max(high, time);
      const date = new Date(time);
      const months = byYear.get(date.getFullYear()) ?? new Set<number>();
      months.add(date.getMonth());
      byYear.set(date.getFullYear(), months);
    }
    return {
      min: toDay(new Date(low)), max: toDay(new Date(high)),
      years: [...byYear].sort((first, second) => second[0] - first[0]).map(([year, months]) => ({ year, months: [...months].sort((first, second) => first - second) })),
    };
  }, [times]);
  function jump(target: string) {
    if (parseDay(target) === null) return;
    onJump(target);
    close();
  }
  return <>
    <button className={toolbarButton} aria-haspopup="dialog" aria-expanded={Boolean(anchor)} aria-label="Jump to date…" title="Jump to a date" disabled={!times.length}
      onClick={(event) => { setDay((current) => current || max); setAnchor(anchor ? null : event.currentTarget); }}><CalendarSearch className="h-4 w-4" /><span className="max-sm:hidden">Jump to</span></button>
    {anchor && <Popover anchor={anchor} label="Jump to date" onClose={close} width={272}>
      <form className="flex items-end gap-2 p-2" onSubmit={(event) => { event.preventDefault(); jump(day); }}>
        <label className="flex-1 text-xs font-medium text-muted-foreground">Date
          <input type="date" data-autofocus className={`${dateInput} mt-1`} value={day} min={min} max={max} onChange={(event) => setDay(event.target.value)} />
        </label>
        <button type="submit" className="h-9 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50" disabled={parseDay(day) === null}>Go</button>
      </form>
      <div className="border-t border-border px-2 pb-2 pt-1.5">
        {years.map(({ year, months }) => <div key={year} className="mt-1.5">
          <button type="button" className="text-xs font-semibold hover:underline" onClick={() => jump(`${year}-${months.at(-1)! < 9 ? "0" : ""}${months.at(-1)! + 1}-15`)}>{year}</button>
          <div className="mt-1 flex flex-wrap gap-1">
            {months.map((month) => <button key={month} type="button" className="rounded-md bg-muted px-1.5 py-0.5 text-xs hover:bg-primary hover:text-primary-foreground"
              onClick={() => jump(`${year}-${String(month + 1).padStart(2, "0")}-15`)}>{new Date(year, month, 1).toLocaleDateString(undefined, { month: "short" })}</button>)}
          </div>
        </div>)}
      </div>
    </Popover>}
  </>;
}

export type Contributor = { id: string; name: string; count: number };

export function contributorName(id: string, names: Map<string, string>) {
  // Members' names load from the collaboration service; until then (or for
  // someone who left) a short id keeps them apart.
  return id === ME ? "You" : id === UNKNOWN_CONTRIBUTOR ? "Unknown member" : names.get(id) ?? `Member ${id.slice(-6)}`;
}

/** Filter: the photos of some contributors (yourself included), taken from one day to another. */
export function FilterButton({ filter, contributors, min, max, onChange }: {
  filter: GalleryFilter;
  /** Everyone who added photos to this view. */
  contributors: Contributor[];
  min: string;
  max: string;
  onChange: (filter: GalleryFilter) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  const count = filterCount(filter);
  const chosen = new Set(filter.contributors);
  function toggle(id: string) {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange({ ...filter, contributors: [...next] });
  }
  return <>
    <button className={`${toolbarButton} ${count ? "bg-primary/10 text-primary" : ""}`} aria-haspopup="dialog" aria-expanded={Boolean(anchor)} aria-label="Filter photos…" title="Show only some photos"
      onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}>
      <ListFilter className="h-4 w-4" /><span className="max-sm:hidden">Filter</span>
      {count > 0 && <span className="rounded-full bg-primary px-1.5 text-[11px] font-semibold leading-4 text-primary-foreground">{count}</span>}
    </button>
    {anchor && <Popover anchor={anchor} label="Filter photos" onClose={close} width={288}>
      <div className="p-2">
        <p className="text-xs font-medium text-muted-foreground">Added by</p>
        {contributors.length > 1 || filter.contributors.length ? <div className="mt-1" role="group" aria-label="Added by">
          {contributors.map((contributor) => <label key={contributor.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-sm hover:bg-muted">
            <input type="checkbox" className="h-4 w-4 accent-[var(--primary)]" checked={chosen.has(contributor.id)} onChange={() => toggle(contributor.id)} />
            <span className="flex-1 truncate">{contributor.name}</span>
            <span className="text-xs text-muted-foreground">{contributor.count}</span>
          </label>)}
          <p className="px-1.5 pt-1 text-xs text-muted-foreground">{chosen.size ? "Only the people ticked are shown." : "Everyone is shown. Tick people to show only their photos."}</p>
        </div> : <p className="mt-1 text-xs leading-relaxed text-muted-foreground">All of these photos are yours. Photos other members add to shared albums can be filtered by who added them.</p>}
      </div>
      <div className="border-t border-border p-2">
        <p className="text-xs font-medium text-muted-foreground">Taken</p>
        <div className="mt-1 grid grid-cols-2 gap-2">
          <label className="text-xs text-muted-foreground">From
            <input type="date" className={`${dateInput} mt-1`} value={filter.from} min={min} max={filter.to || max} onChange={(event) => onChange({ ...filter, from: event.target.value })} />
          </label>
          <label className="text-xs text-muted-foreground">To
            <input type="date" className={`${dateInput} mt-1`} value={filter.to} min={filter.from || min} max={max} onChange={(event) => onChange({ ...filter, to: event.target.value })} />
          </label>
        </div>
      </div>
      {count > 0 && <div className="border-t border-border p-1">
        <button type="button" className={menuItem} onClick={() => onChange(NO_FILTER)}><X className="h-4 w-4" />Clear filter</button>
      </div>}
    </Popover>}
  </>;
}

/** What the filter shows, in words, for the bar under the toolbar. */
export function describeFilter(filter: GalleryFilter, names: Map<string, string>) {
  const parts: string[] = [];
  if (filter.contributors.length) parts.push(`Added by ${filter.contributors.map((id) => contributorName(id, names)).join(", ")}`);
  const format = (day: string) => new Date(parseDay(day)!).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (filter.from && filter.to) parts.push(`${format(filter.from)} – ${format(filter.to)}`);
  else if (filter.from) parts.push(`From ${format(filter.from)}`);
  else if (filter.to) parts.push(`Until ${format(filter.to)}`);
  return parts.join(" · ");
}

type Rows = { tops: number[]; times: number[] };

const SEEKER_PADDING = 12;
const LABEL_SPACING = 18;

function seekLabel(time: number) {
  return new Date(time).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/**
 * A rail beside the photos, like a timeline: years are marked where their
 * photos start, hovering shows the month at that point, and dragging scrolls
 * through the whole gallery at once.
 */
export function TimelineSeeker({ scrollRef, rows, layoutKey }: {
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Calculated row offsets; offscreen tiles never need to be mounted. */
  rows: Rows;
  /** Changes when the photos or their layout change. */
  layoutKey: string;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ scrollTop: 0, maxScroll: 0, clientHeight: 0, rail: 0 });
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [scrolling, setScrolling] = useState(false);

  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    setMetrics({ scrollTop: scroller.scrollTop, maxScroll: Math.max(0, scroller.scrollHeight - scroller.clientHeight), clientHeight: scroller.clientHeight, rail: (railRef.current?.clientHeight ?? 0) - 2 * SEEKER_PADDING });
  }, [scrollRef]);

  useLayoutEffect(() => { measure(); }, [layoutKey, rows, measure]);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let frame = 0;
    const later = () => { window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(measure); };
    const observer = new ResizeObserver(later);
    observer.observe(scroller);
    let idle = 0;
    const scrolled = () => {
      later();
      setScrolling(true);
      window.clearTimeout(idle);
      idle = window.setTimeout(() => setScrolling(false), 900);
    };
    scroller.addEventListener("scroll", scrolled, { passive: true });
    return () => { observer.disconnect(); window.cancelAnimationFrame(frame); window.clearTimeout(idle); scroller.removeEventListener("scroll", scrolled); };
  }, [measure, scrollRef]);

  const { maxScroll, rail, scrollTop, clientHeight } = metrics;
  const toY = useCallback((offset: number) => SEEKER_PADDING + (maxScroll ? Math.min(1, offset / maxScroll) : 0) * rail, [maxScroll, rail]);
  const toOffset = (y: number) => Math.max(0, Math.min(1, (y - SEEKER_PADDING) / Math.max(1, rail))) * maxScroll;
  const timeAt = (offset: number) => {
    const index = indexAtOffset(rows.tops, offset + 1);
    return index >= 0 ? rows.times[index] : undefined;
  };

  // Each year where its photos start; labels where there is room, dots elsewhere.
  const marks = useMemo(() => {
    const result: Array<{ y: number; year: number; label: boolean }> = [];
    let previousYear: number | null = null;
    let lastLabel = -Infinity;
    rows.tops.forEach((top, index) => {
      const year = new Date(rows.times[index]).getFullYear();
      if (year === previousYear) return;
      previousYear = year;
      const y = toY(top);
      const label = y - lastLabel >= LABEL_SPACING;
      if (label) lastLabel = y;
      result.push({ y, year, label });
    });
    return result;
  }, [rows, toY]);

  if (!rows.tops.length || maxScroll < clientHeight * 0.5 || rail <= 0) return <div ref={railRef} aria-hidden className="absolute inset-y-0 right-0 w-12" />;

  function seek(event: ReactPointerEvent) {
    const y = event.clientY - railRef.current!.getBoundingClientRect().top;
    setHover(y);
    if (scrollRef.current) scrollRef.current.scrollTop = toOffset(y);
  }

  function key(event: ReactKeyboardEvent) {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const page = scroller.clientHeight * 0.9;
    const step = { ArrowDown: page / 3, ArrowUp: -page / 3, PageDown: page * 3, PageUp: -page * 3 }[event.key];
    if (step !== undefined) scroller.scrollTop += step;
    else if (event.key === "Home") scroller.scrollTop = 0;
    else if (event.key === "End") scroller.scrollTop = scroller.scrollHeight;
    else return;
    event.preventDefault();
  }

  const thumbY = toY(scrollTop);
  const current = timeAt(scrollTop);
  const hoverTime = hover === null ? undefined : timeAt(toOffset(hover));
  const bubble = (y: number, text: string, strong: boolean) => <span className={`pointer-events-none absolute right-11 -translate-y-1/2 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium shadow-md ${strong ? "bg-primary text-primary-foreground" : "bg-foreground text-background"}`} style={{ top: y }}>{text}</span>;

  return <div ref={railRef} role="slider" tabIndex={0} aria-label="Scroll through photos by date" aria-orientation="vertical"
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={maxScroll ? Math.round((scrollTop / maxScroll) * 100) : 0} aria-valuetext={current ? seekLabel(current) : undefined}
    className="group/seeker absolute inset-y-0 right-0 z-10 w-12 cursor-row-resize touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); seek(event); }}
    onPointerMove={(event) => { if (dragging) seek(event); else setHover(event.clientY - railRef.current!.getBoundingClientRect().top); }}
    onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); setDragging(false); }}
    onPointerCancel={() => setDragging(false)}
    onPointerLeave={() => { if (!dragging) setHover(null); }}
    onKeyDown={key}>
    <span aria-hidden className="absolute bottom-3 right-[5px] top-3 w-px bg-border" />
    {marks.map((mark) => mark.label
      ? <span key={mark.year} aria-hidden className="pointer-events-none absolute right-3 -translate-y-1/2 text-[10px] font-medium tabular-nums text-muted-foreground" style={{ top: mark.y }}>{mark.year}</span>
      : <span key={mark.year} aria-hidden className="pointer-events-none absolute right-3.5 h-1 w-1 -translate-y-1/2 rounded-full bg-muted-foreground/60" style={{ top: mark.y }} />)}
    {/* The part of the gallery in view, as a scroll bar would show it. */}
    <span aria-hidden className={`pointer-events-none absolute right-[3px] w-[5px] -translate-y-1/2 rounded-full transition-colors ${dragging ? "bg-primary" : "bg-muted-foreground/50 group-hover/seeker:bg-primary"}`}
      style={{ top: thumbY, height: Math.max(20, (clientHeight / (maxScroll + clientHeight)) * rail) }} />
    {hover !== null && <span aria-hidden className="pointer-events-none absolute right-0 h-px w-11 bg-primary/70" style={{ top: hover }} />}
    {hover !== null && hoverTime !== undefined ? bubble(hover, seekLabel(hoverTime), dragging)
      : (scrolling || dragging) && current !== undefined && bubble(thumbY, seekLabel(current), false)}
  </div>;
}
