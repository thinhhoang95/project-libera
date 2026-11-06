"use client";

// Connects a PDF tab to its live document. A PDF in a notebook without live
// PDFs, or in a window without collaboration, stays on its local sidecar.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ResolvedDoc, ResolvedPdf } from "../local-api";
import { collabClient } from "../ui/client";
import { useHostEvents } from "../ui/hooks";
import { canWriteSubdoc } from "../protocol/roles";
import { getCollabStatusStore, type CollabSnapshot } from "../ui/status-store";
import { getSharedDocRegistry, type SharedDocLease, type SharedDocSession } from "../client/registry";
import type { ReplicaSnapshot } from "../client/replica";
import { SharedPdfStore } from "./store";

/** Undo history and the replica outlive a tab switch by this long. */
const RETAIN_MS = 10 * 60 * 1000;

interface OpenPdf {
  store: SharedPdfStore;
  session: SharedDocSession;
  lease: SharedDocLease;
  holders: number;
  release: ReturnType<typeof setTimeout> | null;
}

const open = new Map<string, Promise<OpenPdf>>();

function isStale(pdf: OpenPdf): boolean {
  return pdf.session.replica.getSnapshot().closed !== null || getSharedDocRegistry().session(pdf.session.docId)?.replica !== pdf.session.replica;
}

function discard(pdf: OpenPdf) {
  if (pdf.release) clearTimeout(pdf.release);
  pdf.store.destroy();
  pdf.lease.release();
}

function acquire(resolved: ResolvedPdf): Promise<OpenPdf> {
  const existing = open.get(resolved.docId);
  if (existing) {
    return existing.then((pdf) => {
      // Signing out or a host restart closes replicas; one kept for undo must not outlive that.
      if (isStale(pdf)) {
        if (open.get(resolved.docId) === existing) open.delete(resolved.docId);
        discard(pdf);
        return acquire(resolved);
      }
      pdf.holders += 1;
      if (pdf.release) clearTimeout(pdf.release);
      pdf.release = null;
      pdf.store.setContext({ accountId: resolved.accountId, ...(resolved.blobHash ? { sourceHash: resolved.blobHash } : {}) });
      return pdf;
    });
  }
  const opening = (async () => {
    // The registry only needs the ids; `kind` is for text editors, which never see this session.
    const asDoc: ResolvedDoc = { ...resolved, kind: "text" };
    const lease = getSharedDocRegistry().acquire(asDoc, `pdf:${resolved.docId}`);
    try {
      const session = await lease.ready;
      await session.replica.whenAttached();
      const store = new SharedPdfStore(
        { get annotations() { return session.replica.annotations; }, onRebuild: (listener) => session.replica.onRebuild(listener) },
        resolved.docId,
        { accountId: resolved.accountId, ...(resolved.blobHash ? { sourceHash: resolved.blobHash } : {}) },
      );
      return { store, session, lease, holders: 1, release: null } satisfies OpenPdf;
    } catch (error) {
      lease.release();
      throw error;
    }
  })();
  open.set(resolved.docId, opening);
  opening.catch(() => open.delete(resolved.docId));
  return opening;
}

function letGo(docId: string, pdf: OpenPdf) {
  pdf.holders -= 1;
  if (pdf.holders > 0) return;
  const release = setTimeout(() => {
    open.delete(docId);
    discard(pdf);
  }, RETAIN_MS);
  (release as { unref?: () => void }).unref?.();
  pdf.release = release;
}

export type SharedPdfState =
  /** Not live: the viewer keeps using the sidecar and Save. */
  | { kind: "local" }
  /** Finding out; the viewer waits, so nothing is written to the wrong place. */
  | { kind: "checking" }
  | { kind: "shared"; store: SharedPdfStore; session: SharedDocSession; resolved: ResolvedPdf };

const NO_STATUS: CollabSnapshot = { phase: "disabled", status: null };
const noStatus = () => NO_STATUS;
const noSubscribe = () => () => {};
const LOCAL: SharedPdfState = { kind: "local" };
const CHECKING: SharedPdfState = { kind: "checking" };

/** The live document of the PDF at `filePath`, if its notebook has one. */
export function useSharedPdf(filePath: string): SharedPdfState {
  const notebook = filePath.split("/")[0];
  const available = getSharedDocRegistry().available;
  // Without the desktop bridge the status is not even fetched: PDFs behave as they always have.
  const statusStore = available ? getCollabStatusStore() : null;
  const { phase, status } = useSyncExternalStore(statusStore?.subscribe ?? noSubscribe, statusStore?.getSnapshot ?? noStatus, noStatus);
  const project = status?.projects?.find((candidate) => candidate.notebook === notebook && candidate.kind !== "album");
  const wanted = available && project?.pdfLive === true && !project.revoked;
  const undecided = available && phase === "loading";
  const [state, setState] = useState<{ path: string; value: SharedPdfState }>({ path: "", value: CHECKING });
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);

  // The file reaches the manifest moments after it reaches the disk.
  useHostEvents("tree-changed", (event) => {
    if (wanted && event.notebook === notebook && state.value.kind !== "shared") setAttempt((value) => value + 1);
  });
  // Someone replaced the PDF: marks need comparing with the new version.
  useHostEvents("files-changed", (event) => {
    if (wanted && event.paths.includes(filePath)) setAttempt((value) => value + 1);
  });

  useEffect(() => {
    if (!wanted) return;
    let active = true;
    let held: OpenPdf | null = null;
    let heldId = "";
    void (async () => {
      try {
        const resolved = await collabClient.resolvePdf(filePath);
        if (!active) return;
        if (!resolved) {
          setState({ path: filePath, value: LOCAL });
          return;
        }
        const pdf = await acquire(resolved);
        if (!active) {
          letGo(resolved.docId, pdf);
          return;
        }
        held = pdf;
        heldId = resolved.docId;
        failures.current = 0;
        setState({ path: filePath, value: { kind: "shared", store: pdf.store, session: pdf.session, resolved } });
      } catch {
        if (!active) return;
        // The host may be restarting; a PDF must not fall back to local writes silently.
        failures.current += 1;
        if (failures.current < 5) setTimeout(() => { if (active) setAttempt((value) => value + 1); }, 1000);
        else setState({ path: filePath, value: LOCAL });
      }
    })();
    return () => {
      active = false;
      if (held) letGo(heldId, held);
    };
  }, [filePath, wanted, attempt]);

  if (undecided) return CHECKING;
  if (!wanted) return LOCAL;
  return state.path === filePath ? state.value : CHECKING;
}

const NO_SNAPSHOT: ReplicaSnapshot | null = null;

/** The replica's state, for the status pill and banners. */
export function useSharedPdfSnapshot(state: SharedPdfState): ReplicaSnapshot | null {
  const replica = state.kind === "shared" ? state.session.replica : null;
  return useSyncExternalStore(replica?.subscribe ?? noSubscribe, replica?.getSnapshot ?? (() => NO_SNAPSHOT), () => NO_SNAPSHOT);
}

/** Marks can be changed here right now. */
export function canAnnotateShared(state: SharedPdfState, snapshot: ReplicaSnapshot | null): boolean {
  if (state.kind !== "shared") return true;
  if (state.resolved.revoked || snapshot?.closed) return false;
  // The live role, not the one this PDF was opened with: a promotion takes
  // effect at once. "role" only says the text cannot be edited, and a PDF has none.
  const role = snapshot?.meta?.role ?? state.resolved.role;
  const reason = snapshot?.meta?.readOnlyReason;
  return canWriteSubdoc(role, "annotations") && (!reason || reason === "role");
}

export function useCanAnnotate(state: SharedPdfState, snapshot: ReplicaSnapshot | null): boolean {
  return useMemo(() => canAnnotateShared(state, snapshot), [state, snapshot]);
}
