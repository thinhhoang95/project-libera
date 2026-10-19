type LiberaMarkdownPdfExportInput = {
  content: string;
  documentPath: string;
  fileName: string;
  /** "slides" prints a Markdown Slides deck, one slide per page. */
  kind?: "document" | "slides";
  title?: string;
};

type LiberaMarkdownPdfExportResult = {
  canceled: boolean;
  filePath?: string;
};

type LiberaMarkdownPdfRenderInput = {
  content: string;
  documentPath?: string;
  kind?: "document" | "slides";
  title?: string;
};

type LiberaNativeMenuItem =
  | {
      submenu?: LiberaNativeMenuItem[];
      checked?: boolean;
      enabled?: boolean;
      id: string;
      label: string;
      type?: "normal" | "checkbox" | "radio";
    }
  | {
      type: "separator";
    };

type LiberaNativeMenuInput = {
  items: LiberaNativeMenuItem[];
  x?: number;
  y?: number;
};

declare global {
  type LiberaDirectoryCommand =
    | { type: "open-directory"; path: string }
    | { type: "open-file"; path: string }
    | { type: "close-directory"; name: string }
    | { type: "clear-recent" };

  type LiberaUpdaterStatus =
    | "unsupported"
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "downloaded"
    | "up-to-date"
    | "error";

  type LiberaUpdaterState = {
    status: LiberaUpdaterStatus;
    currentVersion: string;
    availableVersion?: string;
    error?: string;
    hasUnsavedDocuments?: boolean;
    manual?: boolean;
    percent?: number;
  };

  interface Window {
    liberaPersistence?: { onFlush: (listener: () => Promise<void>) => () => void };
    liberaWorkspaces?: {
      checkpoint: (body: string, root: string) => { saved: boolean; error?: string };
      remember?: (body: string, root: string) => { saved: boolean; error?: string };
      readRecovery?: (root: string) => Promise<string | null>;
    };
    liberaDirectory?: {
      chooseFolder: () => Promise<string | null>;
      chooseFile: () => Promise<string | null>;
      notifyChanged: () => Promise<void>;
      onCommand: (listener: (command: LiberaDirectoryCommand) => void) => () => void;
    };
    liberaPlatform?: {
      isElectron: boolean;
      platform: string;
      glass: boolean;
    };
    liberaExport?: {
      saveMarkdownFile: (input: { content: string; fileName: string; saveId?: string }) => Promise<{ canceled: boolean; saveId?: string; fileName?: string }>;
      /** A Save dialog for any text export (transcripts as Markdown, text or subtitles). */
      saveTextFile?: (input: { content: string; fileName: string; filterName: string; extensions: string[] }) => Promise<{ canceled: boolean; fileName?: string }>;
      exportMarkdownPdf: (
        input: LiberaMarkdownPdfExportInput,
      ) => Promise<LiberaMarkdownPdfExportResult>;
    };
    liberaMenu?: {
      popup: (input: LiberaNativeMenuInput) => Promise<string | null>;
    };
    liberaFileExplorer?: {
      revealNotebook: (notebook: string) => Promise<void>;
      revealItem: (relativePath: string) => Promise<void>;
    };
    liberaSearch?: {
      /** Show the search index file in Finder or Explorer; false when it does not exist. */
      revealIndex: (filePath: string) => Promise<boolean>;
      /** Choose an existing index file and save it in Preferences; "" when canceled. */
      useExistingIndex: () => Promise<string>;
    };
    liberaPreferences?: {
      /** Open Preferences at a section, e.g. "search". */
      open: (section?: string) => Promise<void>;
    };
    liberaClipboard?: {
      copyItemPath: (
        relativePath: string,
        mode: "relative" | "absolute",
      ) => Promise<void>;
    };
    liberaWindow?: {
      close: () => Promise<void>;
      minimize: () => Promise<void>;
      toggleMaximize: () => Promise<void>;
      setTheme: (theme: "light" | "dark" | "system") => Promise<void>;
      onThemeChanged: (listener: (theme: "light" | "dark" | "system") => void) => () => void;
    };
    liberaUpdater?: {
      getState: () => Promise<LiberaUpdaterState>;
      check: () => Promise<LiberaUpdaterState>;
      restartAndInstall: () => Promise<void>;
      setDirtyDocumentCount: (count: number) => Promise<void>;
      onStateChanged: (listener: (state: LiberaUpdaterState) => void) => () => void;
    };
    liberaMarkdownPdfExport?: {
      render: (input: LiberaMarkdownPdfRenderInput) => Promise<void>;
    };
  }
}

export {};
