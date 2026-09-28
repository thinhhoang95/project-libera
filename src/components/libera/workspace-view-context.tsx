"use client";

import { createContext, useContext } from "react";
import type { WorkspaceView } from "@/lib/workspaces";

export const WorkspaceViewContext = createContext<{
  view: WorkspaceView | undefined;
  updateView: (change: (view: WorkspaceView) => WorkspaceView) => Promise<void>;
} | null>(null);

export function useWorkspaceView() {
  return useContext(WorkspaceViewContext);
}
