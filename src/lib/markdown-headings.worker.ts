import { markdownHeadingOffsets } from "./markdown-review";
import type { HeadingIndexRequest, HeadingIndexResponse } from "./markdown-heading-index";

self.onmessage = (event: MessageEvent<HeadingIndexRequest>) => {
  const { id, markdown } = event.data;
  const response: HeadingIndexResponse = { id, offsets: markdownHeadingOffsets(markdown) };
  self.postMessage(response);
};
