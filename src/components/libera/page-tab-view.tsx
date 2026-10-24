"use client";

import { SpendingView } from "@/components/libera/spending/spending-view";
import type { PageKind } from "@/components/libera/page-tabs";

/** The content of an app page's tab (page-tabs.ts). */
export function PageTabView({ kind }: { kind: PageKind }) {
  switch (kind) {
    case "spending": return <SpendingView />;
  }
}
