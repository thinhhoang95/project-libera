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
