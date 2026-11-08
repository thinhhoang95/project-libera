"use client";

import { apiRequest } from "@/components/libera/api-client";
import { DEFAULT_MARKDOWN_PASTE_OPTIONS, parseMarkdownPasteOptions, type MarkdownPasteOptions } from "@/lib/latex/markdown-paste/options";

/** The Paste Markdown as LaTeX settings, loaded once per window and shared by every LaTeX editor. */

const ENDPOINT = "/api/preferences/latex-paste";
let options: MarkdownPasteOptions = DEFAULT_MARKDOWN_PASTE_OPTIONS;
let loading: Promise<MarkdownPasteOptions> | null = null;
/** Saves run one after another, so a slower earlier response never brings back older settings. */
let saving: Promise<unknown> = Promise.resolve();
let revision = 0;

export function getMarkdownPasteOptions() {
  return options;
}

export function loadMarkdownPasteOptions() {
  loading ??= apiRequest<MarkdownPasteOptions>(ENDPOINT)
    // Changes made before the load finished win over what the server had.
    .then((response) => { if (!revision) options = parseMarkdownPasteOptions(response); return options; })
    // A later call retries; pastes use the defaults meanwhile.
    .catch(() => { loading = null; return options; });
  return loading;
}

/** Remember settings: this window uses them at once; the server stores them in order, and a failed save is retried with the next one. */
export function saveMarkdownPasteOptions(next: MarkdownPasteOptions) {
  options = parseMarkdownPasteOptions(next);
  const mine = ++revision;
  saving = saving.then(async () => {
    if (mine !== revision) return; // a newer save will send newer settings
    try {
      await apiRequest<MarkdownPasteOptions>(ENDPOINT, { method: "PUT", body: JSON.stringify(options) });
    } catch { /* kept in this window; the next save sends them again */ }
  });
  return saving;
}
