# Global Search

Search every notebook, linked folder and the Image Gallery by meaning, by exact words, or with images. Results point to the passage, page or lines that match and open there.

Open **Search** in the left rail (⌘/Ctrl+6), or press ⌘/Ctrl+Shift+F anywhere. The page covers the editors like the Image Gallery does; open documents keep their state.

## Searching

- Type what you are looking for in your own words. Results appear as you type; Enter also saves the search under **Recent** in the left panel.
- Put words in quotes to require the exact phrase.
- Add an image to search with it: paste or drop one into the box, or use the image button (from your computer, the Image Gallery, or your notebooks). Images sit in the text as chips, so a query reads in order: “photos like [image] but at night”. A result's **Find similar images** starts such a search.
- Filter by kind: Notes, PDFs, LaTeX, Text & code, Images. With **Images** the photos show as a grid; otherwise matching photos show in a strip above the documents.
- ↑ ↓ move through the passages, Enter opens one, ⌘/Ctrl+Enter opens it to the right, Esc returns to the box (Esc in an empty box closes Search).

Each result is a file with its best passages, their location (page, section, lines) and how close they are to the query. The preview shows the passage in context: rendered Markdown with the passage marked, LaTeX and code with line numbers, the PDF page with the passage boxed, or the photo with its prompt.

Opening a result goes to the passage: Markdown selects it (in both the visual and source editors), PDFs scroll to the page and find the passage's first words, LaTeX and code select the lines, and photos open as image tabs. Results respect the active workspace and whether the archive is shown.

## How it works

- **Model.** [EmbeddingGemma 2](https://huggingface.co/google/embeddinggemma-2) through Transformers.js and ONNX Runtime on the CPU. It runs in a separate worker process (`electron/search-worker.mjs`), which loads the model on first use and exits after five idle minutes. Nothing leaves the computer.
- **Passages.** Markdown splits at headings, LaTeX at sectioning commands (BibTeX per entry), PDFs per page, and everything then at paragraphs and sentences into passages of about 250 tokens. Each passage is embedded with its file name and section as the title (`title: … | text: …`) and the end of the previous passage as context. Queries use `task: search result | query: …`.
- **Hybrid ranking.** The vector index (cosine similarity) and a full-text index (BM25, case- and accent-insensitive) are fused by reciprocal rank. Weak vector matches are cut relative to the best match of their kind, since the model scores text against photos lower than text against text. With images in the query, only the vector index is used.
- **Index.** One SQLite file, `libera-search.sqlite`, with an FTS5 table and a [sqlite-vec](https://github.com/asg017/sqlite-vec) vector table. The desktop app keeps it on this computer, outside the Master directory, so a notes folder synced to the cloud never uploads it: in `search-index/<id>` next to Libera's config (`~/Library/Application Support/Libera by Thinh Hoang` on macOS, `%LOCALAPPDATA%\Libera by Thinh Hoang` on Windows), with one index per Master directory. Preferences can name another file; a web deployment without the desktop config keeps it in `users/admin/.libera/search`. The Search panel shows the path; in the desktop app, click it to show the file in Finder or Explorer (Preferences → Search has **Reveal** too).
- **First index.** Nothing is indexed until you ask: the Search page and panel offer **Build index**, or **Use existing index…** to pick a `libera-search.sqlite` Libera built before, for example copied from another computer with the same notes (paths in the index are relative to the library, so it carries over). Libera opens only files that are Libera indexes; any other SQLite file is refused, never changed. Once an index exists, it is kept up to date as below. SQLite is Node's own `node:sqlite`; sqlite-vec is a loadable extension, so nothing native depends on Electron's ABI.
- **Repair.** Each scan first checks that every entry still matches a file. If it doesn't, the scan looks for the file it stands for and moves the entry there, so its passages and vectors are kept. This covers an index copied from another computer where a notebook or linked folder has another name, paths that differ only in Unicode form or letter case, and gallery photos with new ids (found by path). When several files could match, the one of the same size is used. If it's still unclear, nothing is guessed. Entries that match no file are stale: they're hidden from results at once and removed when the scan ends, so a file that was really moved can still borrow their vectors.
- **Updates.** A scan compares raw file sizes, precise modification/change times and file identities, independently of annotation dates. Changed files are split again at once, and keyword fields refresh even when a photo keeps its vector. Text vectors are reused only when the full embedding prompt (including the file title and preceding context) matches; photos use a hash of the complete file. Failed reads and embeddings are retried on the next scan. Embedding runs in the background, text before photos, in small batches that pause while you search. Libera checks for changes 20 seconds after sign-in, every 10 minutes, and about every 30 seconds while Search is open. Rebuilds and index switches discard work from superseded passes.
- **Other settings.** Vectors made with another text model, vision encoder or embedding size are never thrown away silently, since embedding again can take hours. Search reports the mismatch, keeps keyword search working, and waits: switch back to those settings, or click **Re-embed with current settings**. **Rebuild** (in the Search panel) starts over from scratch.
- **PDF text** is extracted in the worker and shared with Deep Search and AI chat through the existing PDF text cache.
- **Older indexes.** The next scan revisits their files to repair earlier fingerprints and keyword fields. Model fingerprints now cover the weights, external tensor data, processor configs and image detail setting. An older model fingerprint may require **Re-embed with current settings** before semantic search resumes; keyword search continues working.

## Setting up the model

Preferences → **Search**:

- **Text model weights**: a `model_*.onnx` file. Its `.onnx_data` file must be next to it, and `config.json`, `tokenizer.json`, `tokenizer_config.json`, `processor_config.json` and `preprocessor_config.json` in its folder or the folder above (the Hugging Face layout).
- **Vision encoder weights** (optional): a `vision_encoder_*.onnx` file with its `.onnx_data`. Needed to index photos and to search with images.
- **Embedding size** (768, 512, 256 or 128), **Image detail** (soft tokens per image), **Index photos**, **Keep the index up to date in the background**, and **Index file**: the default, an existing index (**Use existing index…**), or a new file elsewhere (**New index file…**). **Reveal** shows it in Finder or Explorer.

Changes apply without restarting. `npm run search:download-model` downloads the 8-bit files to `~/Models/embeddinggemma-2-ONNX` and prints the paths to choose (`-- --dtype q4`, `-- --text-only` and `-- --dir …` are available). Without weights, Search works as keyword search.

A web deployment sets `LIBERA_SEARCH_TEXT_WEIGHTS`, `LIBERA_SEARCH_VISION_WEIGHTS`, `LIBERA_SEARCH_DIMENSIONS`, `LIBERA_SEARCH_VISION_TOKENS`, `LIBERA_SEARCH_INDEX_IMAGES`, `LIBERA_SEARCH_BACKGROUND_INDEXING` and `LIBERA_SEARCH_INDEX_FILE` instead.

### Choosing weights

Measured on an Apple M1 (8 GB) with 4 threads:

| | Text, per passage | Photo, Standard detail | Photo, High detail |
| :-- | :-- | :-- | :-- |
| 8-bit (`_quantized`) | ~200 ms | ~1.8 s | ~4.4 s |
| 4-bit (`_q4`) | ~200 ms | ~1.8 s | ~4.3 s |

On a CPU the 8-bit files are as fast as the 4-bit ones and closer to the full-precision model, so they are the better default. A search takes about 70 ms with words and about 2 s with an image (the image is encoded first).

## Notes

- A custom **Index file** should be on a local disk. In a synced folder the index would be uploaded each time it changes, and SQLite files can be damaged by sync conflicts.
- Scanned PDFs without a text layer are found by file name only.
- sqlite-vec has no Windows on Arm build; there the index cannot be opened.

## Checks

`node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/global-search.test.ts`
`node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/global-search-cache.test.ts scripts/editor/pdf-chat-route.test.ts`
`node --test scripts/lib/search-preferences.test.cjs`

Covers passage splitting for Markdown, LaTeX, BibTeX, PDF pages and code, the document and query prompts, query words and accent-insensitive highlighting, rank fusion and the similarity cut, the index (keyword and vector search, kind filters, vector reuse for unchanged and copied passages, repairing drifted paths and stale entries, resets when the model or size changes, deletions), opening hits at their location, and the Preferences section.

Cache regressions also cover preserved timestamps, edits beyond an image's first 256 KB, changed prompt context, failed-read retries, PDF changes during extraction, annotation timestamps, model dependencies, delayed vector writes, transactional resets, rebuilds, and index files switched or replaced while open.
