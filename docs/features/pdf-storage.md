# PDF annotations and extracted text

PDF annotations, and the PDF's review comment threads (key `comments`; see
[Review Mode](../review-mode.md#review-comments-on-pdfs)), are stored by complete
relative file path in each notebook's `.libera/annotations/pdf/by-path/` directory. Same-named PDFs in different
folders have independent notes. File and folder renames, moves, copies, archive,
and deletion update their corresponding sidecars.

Old flat annotation files migrate when exactly one PDF can own them. Migration
keeps recovery copies ending in `.migrated-<id>`. When several PDFs have the same
name, the old sidecar is preserved as `.ambiguous-<id>` for manual recovery; the
app does not assign those notes to a guessed owner.

Extracted text is a disposable version 3 cache in `.libera/pdf-text/`. Its SHA-256
identity covers every byte of the PDF, so moving, copying, or syncing unchanged
PDFs does not require extraction again. Cached page entries and their count are
validated. Annotation changes do not invalidate extracted text. A valid local
version 2 cache upgrades without extraction; a version 2 cache from another
computer requires one extraction because it contains no portable content hash.

Concurrent requests on one server share extraction. Cache writes publish complete
JSON atomically; inability to save a cache does not prevent using extracted text.
PDF changes, deletion, and movement during extraction abort the old read. Library
refresh removes orphan text caches for externally deleted PDFs, while missing
linked folders keep their state for when the drive/folder returns.

## OneDrive and other folder sync

Sync the complete Libera Master directory, including hidden `.libera` folders,
and download the PDF files before opening them. Normal notebooks carry both
annotations and reusable extracted text to another computer.

Linked folders contain one small `.libera-folder.json` identity marker. Their
annotations and caches still live in the Master directory, under
`.libera/directories/<folder-id>/`; both the Master directory and the linked
folder's identity marker must sync. On another computer, open the local copy of
the linked folder once. Its marker reconnects the existing annotations and cache,
even when its absolute path differs. Each computer retains its own path mapping.
Older state keyed by absolute path migrates automatically when its folder is
accessible. Read-only folders that cannot accept the identity marker remain usable
with local state, but cannot gain portable identity until the marker can be saved.

All computers should run a version supporting this layout. File synchronization
does not merge simultaneous edits to the same annotation file; such conflicts
still depend on the sync provider's conflict handling.
