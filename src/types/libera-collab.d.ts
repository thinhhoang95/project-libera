// window.liberaCollab, exposed by electron/preload.cjs when the collab host
// runs (LIBERA_COLLAB=1). Absent in the browser and when collaboration is off.

import type { LiberaCollabBridge } from "@/lib/collab/local-api";

declare global {
  interface Window {
    liberaCollab?: LiberaCollabBridge;
  }
}

export {};
