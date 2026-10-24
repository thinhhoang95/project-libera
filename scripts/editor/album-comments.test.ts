import assert from "node:assert/strict";
import test from "node:test";

import { parsePhotoAnchor, photoAnchorId } from "../../src/lib/collab/album-comments";

test("photo comment anchors name the photo, and the area when there is one", () => {
  const fileId = "fil_aB-c_d-r12xYz0123456789";
  assert.equal(photoAnchorId(fileId), fileId);
  assert.deepEqual(parsePhotoAnchor(fileId), { fileId, region: null });
  const anchor = photoAnchorId(fileId, { x: 0.1, y: 0.25, width: 0.5, height: 0.9 });
  assert.equal(anchor, `${fileId}-r100-250-500-750`, "an area is clipped to the photo");
  assert.match(anchor, /^[A-Za-z0-9_-]{8,80}$/, "a valid thread anchor id");
  assert.deepEqual(parsePhotoAnchor(anchor), { fileId, region: { x: 0.1, y: 0.25, width: 0.5, height: 0.75 } });
});
