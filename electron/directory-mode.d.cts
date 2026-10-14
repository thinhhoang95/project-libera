export type LinkedFolderState = { name: string; path: string; id?: string; locations?: Record<string, string>; unresolved?: boolean };
export type DirectoryModeState = { version: 2; folders: LinkedFolderState[]; recent: string[] };

export const MAX_RECENT_DIRECTORIES: number;
export function baseFolderName(directoryPath: string): string;
export function contextStateRoot(adminRoot: string, contextRoot: unknown): string | null;
export function directoryModeStatePath(adminRoot: string): string;
export function directoryStateRoot(adminRoot: string, directoryPath: string, folderId?: string): string;
export function findLinkedFolder(state: DirectoryModeState, name: string): LinkedFolderState | null;
export function libraryNotebookNames(adminRoot: string): string[];
export function normalizeDirectoryModeState(value: unknown): DirectoryModeState;
export function normalizeDirectoryPath(value: unknown): string;
export function readDirectoryModeState(adminRoot: string): DirectoryModeState;
export function uniqueFolderName(preferredName: string, takenNames: Iterable<string>): string;
export function withRecentDirectory(recent: string[], directoryPath: string): string[];
export function writeDirectoryModeState(adminRoot: string, state: DirectoryModeState): DirectoryModeState;

export function directoryMachineKey(): string;
export function ensureDirectoryIdentity(adminRoot: string, directoryPath: string, previousId?: string): string | null;
export function legacyDirectoryStateRoot(adminRoot: string, directoryPath: string): string;
