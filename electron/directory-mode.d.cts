export type DirectoryModeState = { version: 1; current: string | null; recent: string[] };

export const MAX_RECENT_DIRECTORIES: number;
export function contextStateRoot(adminRoot: string, contextRoot: unknown): string | null;
export function directoryModeStatePath(adminRoot: string): string;
export function directoryStateRoot(adminRoot: string, directoryPath: string): string;
export function normalizeDirectoryModeState(value: unknown): DirectoryModeState;
export function normalizeDirectoryPath(value: unknown): string;
export function readDirectoryModeState(adminRoot: string): DirectoryModeState;
export function withRecentDirectory(recent: string[], directoryPath: string): string[];
export function writeDirectoryModeState(adminRoot: string, state: DirectoryModeState): DirectoryModeState;
