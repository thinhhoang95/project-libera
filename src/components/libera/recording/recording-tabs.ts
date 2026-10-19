import type { OpenTab } from "@/components/libera/types";

/**
 * A recording in progress opens as a tab of its own, beside the notes, like a
 * voice memo. It is not a notebook file yet: the tab id and file path use a
 * reserved prefix, and the `recording` marker is what code checks before
 * treating a tab as a file on disk. Saving replaces the tab with the saved
 * voice memo; recording tabs are not restored with a workspace, since the
 * recorder offers unfinished recordings itself.
 */
export const RECORDING_TAB_PREFIX = "recording:";

export type RecordingOpenTab = OpenTab & { recording: { id: string } };

export function recordingTabId(recordingId: string) {
  return `${RECORDING_TAB_PREFIX}${recordingId}`;
}

export function isRecordingTab(tab: OpenTab | null | undefined): tab is RecordingOpenTab {
  return Boolean(tab?.recording);
}

export function createRecordingTab(recordingId: string, name: string, notebook: string): RecordingOpenTab {
  const id = recordingTabId(recordingId);
  const now = new Date().toISOString();
  return {
    id,
    recording: { id: recordingId },
    file: { kind: "file", name, path: id, notebook, fileType: "audio", createdAt: now, updatedAt: now, size: 0 },
    draft: "",
    saved: "",
    status: "clean",
  };
}
