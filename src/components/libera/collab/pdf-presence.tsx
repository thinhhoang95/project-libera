"use client";

// Collaborators on a live PDF: their pointers and strokes in progress on each
// page, and where everyone is reading on a rail beside the pages. A layer per
// page subscribes for itself, so a moving pointer never re-renders the page.

import { memo, useSyncExternalStore } from "react";
import type { PdfAnnotation, PdfAnnotationRect } from "@/lib/types";
import type { PdfGhost, PdfPresenceSnapshot, PdfPresenceStore, PdfRemoteUser } from "@/lib/collab/pdf/presence";

const EMPTY: PdfPresenceSnapshot = { users: [], ghosts: [] };
const noSubscribe = () => () => {};
const noSnapshot = () => EMPTY;

function usePresence(store: PdfPresenceStore | null): PdfPresenceSnapshot {
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getSnapshot ?? noSnapshot, noSnapshot);
}

function markBounds(mark: PdfAnnotation): PdfAnnotationRect[] {
  if (mark.type === "highlight") return mark.rects;
  if (mark.type === "text") return [mark.rect];
  if (mark.type === "ink" || mark.type === "shape") {
    const points = mark.type === "ink" ? mark.points : [mark.from, mark.to];
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return [{ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }];
  }
  return [];
}

function GhostShape({ ghost, width, height, zoom }: { ghost: PdfGhost; width: number; height: number; zoom: number }) {
  const stroke = ghost.strokeWidth * zoom;
  const px = ghost.points.map((point) => ({ x: point.x * width, y: point.y * height }));
  const common = { fill: "none", stroke: ghost.color, strokeWidth: stroke, strokeLinecap: "round", strokeLinejoin: "round", opacity: 0.75 } as const;
  if (ghost.kind === "ink" || px.length < 2) return <polyline {...common} points={px.map((point) => `${point.x},${point.y}`).join(" ")} />;
  const [from, to] = px;
  if (ghost.shape === "rectangle") return <rect {...common} x={Math.min(from.x, to.x)} y={Math.min(from.y, to.y)} width={Math.abs(to.x - from.x)} height={Math.abs(to.y - from.y)} />;
  if (ghost.shape === "ellipse") return <ellipse {...common} cx={(from.x + to.x) / 2} cy={(from.y + to.y) / 2} rx={Math.abs(to.x - from.x) / 2} ry={Math.abs(to.y - from.y) / 2} />;
  return <line {...common} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
}

export interface PdfPresenceLayerProps {
  store: PdfPresenceStore;
  pageNumber: number;
  width: number;
  height: number;
  zoom: number;
  /** This page's marks in surface coordinates, to outline what others have selected. */
  marks: readonly PdfAnnotation[];
}

export const PdfPresenceLayer = memo(function PdfPresenceLayer({ store, pageNumber, width, height, zoom, marks }: PdfPresenceLayerProps) {
  const { users, ghosts } = usePresence(store);
  const pageGhosts = ghosts.filter((ghost) => ghost.page === pageNumber);
  const pointers = users.filter((user) => user.presence?.pointer?.page === pageNumber);
  const selections = users.flatMap((user) => (user.presence?.selection ?? []).flatMap((id) => {
    const mark = marks.find((candidate) => candidate.id === id);
    return mark ? markBounds(mark).map((rect, index) => ({ key: `${user.clientId}:${id}:${index}`, rect, color: user.color })) : [];
  }));
  if (!pageGhosts.length && !pointers.length && !selections.length) return null;
  return (
    <div className="pdf-presence-layer" aria-hidden>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {selections.map(({ key, rect, color }) => (
          <rect key={key} x={rect.x * width - 2} y={rect.y * height - 2} width={rect.width * width + 4} height={rect.height * height + 4} rx={3} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray="4 3" />
        ))}
        {pageGhosts.map((ghost) => <GhostShape key={`${ghost.clientId}:${ghost.id}`} ghost={ghost} width={width} height={height} zoom={zoom} />)}
      </svg>
      {pointers.map((user) => (
        <span key={user.clientId} className="pdf-presence-pointer" style={{ left: (user.presence?.pointer?.x ?? 0) * width, top: (user.presence?.pointer?.y ?? 0) * height, color: user.color }}>
          <svg width="14" height="16" viewBox="0 0 14 16"><path d="M1 1l11 7-5 1-2 5z" fill="currentColor" stroke="#fff" strokeWidth="1" /></svg>
          <span className="pdf-presence-name" style={{ background: user.color }}>{user.name}</span>
        </span>
      ))}
    </div>
  );
});

export interface PdfPresenceRailProps {
  store: PdfPresenceStore;
  pageCount: number;
  followingClientId: number | null;
  onFollow: (clientId: number) => void;
}

function railStyle(user: PdfRemoteUser, pageCount: number) {
  const presence = user.presence;
  if (!presence || pageCount < 1) return null;
  const top = Math.min(1, Math.max(0, (presence.page - 1 + presence.top) / pageCount));
  const bottom = Math.min(1, Math.max(top, (presence.page - 1 + presence.bottom) / pageCount));
  return { top: `${top * 100}%`, height: `max(6px, ${(bottom - top) * 100}%)`, background: user.color };
}

/** Where each collaborator is reading, beside the scrollbar. Clicking one follows them. */
export function PdfPresenceRail({ store, pageCount, followingClientId, onFollow }: PdfPresenceRailProps) {
  const { users } = usePresence(store);
  const placed = users.filter((user) => user.presence);
  if (!placed.length) return null;
  return (
    <div className="pdf-presence-rail" data-pdf-annotation-ui>
      {placed.map((user) => (
        <button
          key={user.clientId}
          type="button"
          aria-label={`${user.name}, page ${user.presence?.page}${followingClientId === user.clientId ? ", following" : ""}`}
          aria-pressed={followingClientId === user.clientId}
          className="pdf-presence-rail-mark"
          style={railStyle(user, pageCount) ?? undefined}
          title={`${user.name}: page ${user.presence?.page}`}
          onClick={() => onFollow(user.clientId)}
        />
      ))}
    </div>
  );
}
