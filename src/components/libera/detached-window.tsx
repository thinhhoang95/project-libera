"use client";

import { createContext, useCallback, useEffect, useRef, useState } from "react";

/**
 * The document a component's overlays (dialogs) belong in. A panel portalled
 * into a detached window provides that window's document, so its dialogs open
 * there instead of behind it in the main window.
 */
export const PortalDocumentContext = createContext<Document | null>(null);

/** Classes that need the main window's native backdrop; a pop-out has none. */
const isGlassClass = (name: string) => name.startsWith("libera-glass");

function mirrorRootAttributes(source: HTMLElement, target: HTMLElement) {
  for (const { name } of [...target.attributes]) if (!source.hasAttribute(name)) target.removeAttribute(name);
  for (const { name, value } of source.attributes) {
    target.setAttribute(name, name === "class" ? value.split(/\s+/).filter((item) => item && !isGlassClass(item)).join(" ") : value);
  }
}

function isStyleNode(node: Node): node is HTMLStyleElement | HTMLLinkElement {
  return node.nodeName === "STYLE" || (node.nodeName === "LINK" && (node as HTMLLinkElement).rel === "stylesheet");
}

function cloneStyleNode(node: HTMLStyleElement | HTMLLinkElement, target: Document) {
  const clone = target.importNode(node, true) as HTMLStyleElement | HTMLLinkElement;
  // Resolved against the main window: the pop-out is about:blank.
  if (clone.nodeName === "LINK") (clone as HTMLLinkElement).href = (node as HTMLLinkElement).href;
  return clone;
}

/**
 * Prepares an empty same-origin pop-out to host a portal: the main window's
 * stylesheets and root classes (theme, platform), kept in step while it is open.
 * Returns the portal container and a cleanup for the observers.
 */
function preparePopout(child: Window, title: string): { container: HTMLElement; dispose: () => void } {
  const source = window.document;
  const target = child.document;
  target.title = title;
  const base = target.createElement("base");
  base.href = window.location.origin + "/";
  target.head.append(base);

  // Copies of the main window's styles; new ones (lazy-loaded chunks, dev updates) follow.
  const copies = new Map<Node, Node>();
  const copy = (node: Node) => {
    if (!isStyleNode(node) || copies.has(node)) return;
    const clone = cloneStyleNode(node, target);
    copies.set(node, clone);
    target.head.append(clone);
  };
  source.head.querySelectorAll("style, link[rel='stylesheet']").forEach(copy);
  const headObserver = new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach(copy);
      record.removedNodes.forEach((node) => { copies.get(node)?.parentNode?.removeChild(copies.get(node)!); copies.delete(node); });
      // Inline style text that changed in place (dev updates).
      if (record.type === "characterData" || (record.type === "childList" && record.target.nodeName === "STYLE")) {
        const style = record.target.nodeName === "STYLE" ? record.target : record.target.parentNode;
        const clone = style && copies.get(style);
        if (clone && style) clone.textContent = style.textContent;
      }
    }
  });
  headObserver.observe(source.head, { childList: true, subtree: true, characterData: true });

  mirrorRootAttributes(source.documentElement, target.documentElement);
  mirrorRootAttributes(source.body, target.body);
  const rootObserver = new MutationObserver(() => {
    mirrorRootAttributes(source.documentElement, target.documentElement);
    mirrorRootAttributes(source.body, target.body);
  });
  rootObserver.observe(source.documentElement, { attributes: true });
  rootObserver.observe(source.body, { attributes: true });

  const frame = target.createElement("style");
  frame.textContent = `html, body { height: 100%; margin: 0; overflow: hidden; background: var(--background); }
#libera-detached-root { display: flex; height: 100%; min-height: 0; }
#libera-detached-root > * { flex: 1 1 auto; min-width: 0; border-left: 0; }
#libera-detached-root .libera-window-drag-region { -webkit-app-region: no-drag; app-region: no-drag; }`;
  target.head.append(frame);

  const container = target.createElement("div");
  container.id = "libera-detached-root";
  container.className = "libera-detached-window";
  target.body.replaceChildren(container);
  return { container, dispose: () => { headObserver.disconnect(); rootObserver.disconnect(); } };
}

/**
 * A same-origin pop-out window that hosts part of the main window's React tree
 * through a portal. The component stays mounted in the main window, so its
 * state, requests and editor bridges carry on unchanged while it is shown
 * elsewhere. `container` is set while the window is open.
 */
export function useDetachedWindow({ name, title, width, height, onClosed }: { name: string; title: string; width: number; height: number; onClosed: () => void }) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const childRef = useRef<Window | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const onClosedRef = useRef(onClosed);
  useEffect(() => { onClosedRef.current = onClosed; });

  const teardown = useCallback(() => {
    const cleanup = cleanupRef.current;
    cleanupRef.current = null;
    childRef.current = null;
    cleanup?.();
    setContainer(null);
  }, []);

  const close = useCallback(() => {
    const child = childRef.current;
    teardown();
    if (child && !child.closed) child.close();
  }, [teardown]);

  const focus = useCallback(() => { childRef.current?.focus(); }, []);

  const open = useCallback(() => {
    if (childRef.current && !childRef.current.closed) { childRef.current.focus(); return true; }
    const child = window.open("", name, `popup,width=${width},height=${height}`);
    if (!child) return false;
    let prepared: ReturnType<typeof preparePopout>;
    try { prepared = preparePopout(child, title); }
    catch { child.close(); return false; }
    childRef.current = child;
    let finished = false;
    const closed = () => {
      if (finished || childRef.current !== child) return;
      finished = true;
      teardown();
      onClosedRef.current();
    };
    child.addEventListener("pagehide", closed);
    // pagehide can be missed when the window is destroyed natively.
    const poll = window.setInterval(() => { if (child.closed) closed(); }, 500);
    const closeWithMain = () => { if (!child.closed) child.close(); };
    window.addEventListener("pagehide", closeWithMain);
    cleanupRef.current = () => {
      finished = true;
      window.clearInterval(poll);
      child.removeEventListener("pagehide", closed);
      window.removeEventListener("pagehide", closeWithMain);
      prepared.dispose();
    };
    setContainer(prepared.container);
    child.focus();
    return true;
  }, [height, name, teardown, title, width]);

  useEffect(() => () => close(), [close]);

  return { container, open, close, focus };
}
