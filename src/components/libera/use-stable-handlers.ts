"use client";

import { useLayoutEffect, useRef, useState } from "react";

type Handlers = Record<string, (...args: never[]) => unknown>;

/**
 * Gives every function in `handlers` an identity that never changes. Each
 * wrapper forwards its arguments to the function of the latest commit and
 * returns what that function returns, so a parent that re-renders for every
 * draft can hand these to memoized children without waking them.
 *
 * The latest functions are stored in a layout effect, so a wrapper must run in
 * an event handler or an effect, never during render: it would call the
 * functions of the previous commit. Functions that are called while rendering
 * stay out of this layer. The set of keys is fixed by the first render.
 */
export function useStableHandlers<T extends Handlers>(handlers: T): T {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  const [stable] = useState(() => Object.fromEntries(Object.keys(handlers).map((key) => [
    key,
    (...args: never[]) => latest.current[key](...args),
  ])) as T);
  return stable;
}
