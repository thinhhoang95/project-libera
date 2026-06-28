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
  interface Window {
    liberaPlatform?: {
      isElectron: boolean;
      platform: string;
      glass: boolean;
    };
    liberaExport?: {
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
    liberaWindow?: {
      close: () => Promise<void>;
      minimize: () => Promise<void>;
      toggleMaximize: () => Promise<void>;
      setTheme: (theme: "light" | "dark") => Promise<void>;
    };
    liberaMarkdownPdfExport?: {
      render: (input: LiberaMarkdownPdfRenderInput) => Promise<void>;
    };
  }
}

export {};
