# Gallery performance

The photo grid renders only rows inside the viewport plus 400 CSS pixels of overscan on either side. Grid and justified layouts calculate offsets from image dimensions. The timeline and date jumps use those offsets, including for photos that have never mounted. Preview navigation leaves the memoized grid unchanged.

Images have cached variants at 160, 320, 640, 1280 and 2048 pixels on their longest side. Fit-to-screen previews use these variants; zooming loads the original. Two adjacent previews can be fetched after navigation settles for 120 ms. Moving again or closing cancels those requests. Archive previews are not speculatively fetched or stored in the HTTP cache.

The server shares duplicate thumbnail jobs, runs at most two native image renders at once, and removes canceled jobs from the waiting queue. Mutations wait for native jobs to release their files, including when their HTTP readers were canceled. Original files stream with 64 KiB read and response buffers; cancellation closes the file.

The catalog transfers summaries in pages of 500 with a revision shared by all pages. A change during pagination restarts the read; a completed client mutation wins over an older refresh. Unchanged revisions omit photo data. Consecutive operations reuse a filesystem scan for at most one second; explicit storage reads force a fresh scan. Prompts, models and shared captions are fetched when a photo opens. The detail cache holds at most 64 photos and an estimated 2 MiB of serialized UTF-16 data. Oversized details are displayed without being cached. Archive details require archive authorization and remain only in the active viewer. Viewer-position histories retain at most 64 photos.

The compact catalog, selection and layout index still scale with the library's photo count. The server's on-disk JSON index is also read as a whole. This design bounds mounted tiles, speculative image requests, native image concurrency and detailed metadata caches; it does not promise constant total process memory. Chromium controls its own HTTP, decoded-image and GPU caches. Opening a very large original for zoom also requires memory proportional to that image.

On October 26, 2026, a development React/JSDOM check at a 1000-pixel pane width mounted 49 tiles and about 588 elements for each of 1,000, 5,000 and 10,000 photos. At 5,000 photos, mount time was about 159 ms and next-photo processing about 15 ms, compared with about 11 seconds and 2.1 seconds before virtualization. These are synthetic development measurements, not Electron frame-rate or heap/GPU measurements.

Regression coverage lives in `scripts/editor/gallery-performance.test.ts`, `gallery-loading.test.ts` and `gallery-store-performance.test.ts`, alongside the gallery's existing continuity, sharing, archive and deletion tests.
