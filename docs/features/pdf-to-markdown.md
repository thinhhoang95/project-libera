# PDF to Markdown

Read PDF pages, scanned books and images into Markdown on this computer, with no cloud service, or convert whole PDFs faster with an OpenRouter model. Line breaks, columns, page numbers, running headers and words split across lines or pages are cleaned up, and tables, formulas, lists, code and figures come out as Markdown.

## Using it

- **Snip as Markdown.** In a Markdown note, click the text-scan button next to the snipping tool, in either the visual or the source editor. Drag a rectangle over a PDF or image tab, as with the ordinary snip. A card shows progress with **Cancel**, and the Markdown lands where the cursor was. If the note changed in the meantime, the source editor appends it at the end instead. Figures inside the snip are saved as images next to the note.
- **Convert PDF to Markdown.** In a PDF tab, click the text-scan button in the toolbar, choose the pages, and start. Libera writes `<PDF name>.md` next to the PDF, or `<PDF name> (2).md` if that exists, and saves after every page. You can close the dialog, switch tabs and keep working. The button shows the progress, and **Stop** keeps what was read. The note opens when the conversion finishes. Figures are cropped from a sharp render of the page and saved as images of the note.

Expect several seconds for a small snip and one to three minutes for a full page on a laptop CPU. Pages the model could not finish are listed at the end, so you can check them against the PDF.

## Local model or OpenRouter

Preferences → AI → **Convert PDF to Markdown** → **Read pages with** chooses how Convert PDF to Markdown reads pages. Snip as Markdown always uses the local model.

- **Local model** (the default) runs granite-docling on this computer, described below. Nothing leaves the computer.
- **OpenRouter model** sends each page to the model set there, `openai/gpt-6-luna` by default, using your OpenRouter key. Choose a model that reads PDF or image input.
  - Each page goes up as its own one-page PDF, cut from the original with pdf-lib, so the model sees the text layer as well as the page. If the PDF cannot be split, the page is sent as an image instead.
  - **Pages at once** (6 by default, up to 16) pages are read at the same time. A page that fails is retried twice. If the first pages all fail, for example because of a wrong model name, the conversion stops with the model's message. Otherwise a failed page is left as a note in the file and listed at the end.
  - The model writes Markdown directly. Running headers, footers and page numbers are left out, footnotes are numbered per page (`[^12-1]`) so they stay unique, and figures come with a box that Libera crops from a sharp render of the page, as with the local model.
  - The pages are joined into one file. A paragraph or a hyphenated word cut by a page break is joined back together, past the footnotes at the bottom of the page. A table that runs onto the next page is joined too, without a repeated header.
  - **Tidy heading levels when done** (on by default) runs one last request. It sends only the list of headings with their pages, not the text, and the model makes their levels consistent across pages. It can also turn a running title that was kept by mistake into plain text. If the reply does not fit, the headings stay as they were.
  - The model, reasoning effort, pages at once and the tidy pass apply without restarting. Without the desktop app, use `LIBERA_PDF_TO_MARKDOWN_ENGINE=openrouter`, `LIBERA_AI_PDF_TO_MARKDOWN_MODEL`, `LIBERA_AI_PDF_TO_MARKDOWN_REASONING_EFFORT`, `LIBERA_PDF_TO_MARKDOWN_CONCURRENCY` and `LIBERA_PDF_TO_MARKDOWN_CLEANUP`.

## Setting up the model

The model is IBM's [granite-docling-258M](https://huggingface.co/ibm-granite/granite-docling-258M) (Apache-2.0), in its [ONNX build](https://huggingface.co/onnx-community/granite-docling-258M-ONNX). Like the EmbeddingGemma weights for Global Search, it lives in a folder you choose: Preferences → **Search** → **PDF reading model** → **Model folder**.

- The first time you use either feature, Libera offers to download the model into that folder. It downloads about 600 MB from one pinned revision, checks every weight file's size and SHA-256, and resumes an interrupted download.
- You can also fill the folder yourself, laid out like the Hugging Face repository: `config.json`, `tokenizer.json`, `tokenizer_config.json`, `preprocessor_config.json` and `processor_config.json` at the top, and `vision_encoder*`, `embed_tokens*` and `decoder_model_merged*` weights with their `.onnx_data` files in `onnx/`. For the vision encoder, Libera uses full precision if present, since the 8-bit encoder misreads text. For the other parts it prefers the 8-bit files, which read correctly and run faster.
- Choosing the `onnx/` folder itself also works.
- Without the desktop app, set `LIBERA_READING_MODEL_DIR`. A web deployment without it uses `users/admin/.libera/models/granite-docling-258M`.

## How it works

- **Prompt.** The reply is started with `<doctag>`; without it, the model sometimes writes a prose summary of the page instead of transcribing it.
- **Worker.** The Next server forks `electron/document-ocr-worker.mjs`, which runs the model through Transformers.js and ONNX Runtime on the CPU with up to four threads, at slightly lowered priority. It loads the model on first use and exits after three idle minutes. Conversions run one at a time, and cancelling stops generation at the next token.
- **Image size.** The model cuts an image into 512 px tiles plus an overview. Pages are read at a long edge of 2048 px, the scale the model was trained on; at 1536 px it misreads small print. A snip uses only as many tiles as it needs. Markdown snips from PDFs are rendered at 180 DPI, close to that scale.
- **DocTags.** The model writes DocTags, a page markup with a location for every block. `src/lib/document-ocr/doctags.ts` turns them into Markdown. It drops page headers and footers, writes headings, paragraphs, lists, code, tables (from OTSL) and formulas with your math markers, and leaves picture placeholders that the app replaces with cropped images.
- **Page joins.** A paragraph that runs across a page break is merged back together, skipping footnotes at the bottom of the page. A word hyphenated across the break is joined too.
- **Loops.** Small vision models sometimes repeat themselves, often after inventing text for a region they cannot read, such as a footnote. The worker ignores location tags and stops when the last 192 tokens repeat one cycle. It then drops the unfinished block the loop started in, and the conversion lists the page as possibly incomplete.
- **OpenRouter path.** `src/components/libera/document-ocr/pdf-markdown-jobs.ts` splits pages and runs the page queue in the browser. `/api/document-ocr/openrouter` reads one page (`src/lib/document-ocr/openrouter-pages.ts`), and `/api/document-ocr/openrouter/headings` tidies the headings. `src/lib/document-ocr/markdown-pages.ts` joins pages and applies heading levels.
- **Jobs.** A PDF conversion belongs to the app, not the tab. It loads its own copy of the document, so switching or closing tabs does not stop it.
