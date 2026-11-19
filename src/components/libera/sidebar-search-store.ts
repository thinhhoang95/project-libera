// The sidebar search box's text. It lives outside the workspace hook so typing
// wakes only the search box, not the whole shell; the workspace clears it
// through reset() (opening a result, restoring a session).
export type SidebarSearchStore = {
  get: () => string;
  set: (query: string) => void;
  reset: () => void;
  subscribe: (listener: () => void) => () => void;
};

export function createSidebarSearchStore(): SidebarSearchStore {
  let query = "";
  const listeners = new Set<() => void>();
  const set = (next: string) => {
    if (next === query) return;
    query = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => query,
    set,
    reset: () => set(""),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
