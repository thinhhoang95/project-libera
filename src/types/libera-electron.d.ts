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
    liberaExport?: {
      exportMarkdownPdf: (
        input: LiberaMarkdownPdfExportInput,
      ) => Promise<LiberaMarkdownPdfExportResult>;
    };
    liberaMarkdownPdfExport?: {
      render: (input: LiberaMarkdownPdfRenderInput) => Promise<void>;
    };
  }
}

export {};
