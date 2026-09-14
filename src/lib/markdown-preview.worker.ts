import { createMarkdownPreviewPatch, prepareMarkdownPreview, type MarkdownPreviewRequest, type MarkdownPreviewResponse } from "./markdown-preview";

let previous: string[] = [];

self.onmessage = (event: MessageEvent<MarkdownPreviewRequest>) => {
  const { id, markdown, mathMarkers } = event.data;
  let response: MarkdownPreviewResponse;
  try {
    const patch = createMarkdownPreviewPatch(prepareMarkdownPreview(markdown, mathMarkers), previous);
    previous = patch.signatures;
    response = { id, children: patch.children };
  } catch (cause) {
    response = { id, error: cause instanceof Error ? cause.message : "Could not prepare preview" };
  }
  self.postMessage(response);
};
