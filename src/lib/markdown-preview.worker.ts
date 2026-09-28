import { prepareMarkdownPreview, type MarkdownPreviewRequest, type MarkdownPreviewResponse } from "./markdown-preview";

import { createMarkdownPreviewCache } from "./markdown-preview-patch";

const cache = createMarkdownPreviewCache();

self.onmessage = (event: MessageEvent<MarkdownPreviewRequest>) => {
  const { id, markdown, mathMarkers } = event.data;
  let response: MarkdownPreviewResponse;
  try {
    const patch = cache.patch(prepareMarkdownPreview(markdown, mathMarkers));
    response = { id, ...patch };
  } catch (cause) {
    response = { id, error: cause instanceof Error ? cause.message : "Could not prepare preview" };
  }
  self.postMessage(response);
};
