type LiberaMarkdownPdfExportInput = {
  content: string;
  documentPath: string;
  fileName: string;
  title?: string;
};

type LiberaMarkdownPdfExportResult = {
  canceled: boolean;
  filePath?: string;
};

type LiberaMarkdownPdfRenderInput = {
  content: string;
  documentPath?: string;
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
    liberaPlatform?: {
      isElectron: boolean;
      platform: string;
      glass: boolean;
    };
    liberaExport?: {
      saveMarkdownFile: (input: { content: string; fileName: string; saveId?: string }) => Promise<{ canceled: boolean; saveId?: string; fileName?: string }>;
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
