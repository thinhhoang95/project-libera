# Read aloud: implementation notes

How read aloud (text-to-speech) is built, where each piece lives, and how to extend it. The user guide is [docs/features/read-aloud.md](../features/read-aloud.md).

Status: implemented on `collaboration` (October 2026). Typecheck, lint and `scripts/editor/read-aloud.test.ts` pass. Not yet checked by hand: audio from Kokoro on this computer and from OpenRouter, the menus in the running app, and the Preferences section. See [Open items](#open-items).

## Overview

```
 editor / PDF / chat ──speakMarkdown(text, { format, sourceId, label })──▶ src/lib/tts/player.ts
                                                                            │  speechText()   → clean text      (src/lib/tts/text.ts)
                                                                            │  speechChunks() → passages ≤ ~320 chars
                                                                            │  POST /api/tts per passage, 2 prepared ahead
                                                                            ▼
                                                     src/app/api/tts/route.ts ── getTtsPreferences() (config file `tts`, or LIBERA_TTS_*)
                                                        │ engine "local"                         │ engine "openrouter"
                                                        ▼                                         ▼
                                  src/lib/tts/kokoro.ts (resolve folder, voice → sid)   src/lib/tts/openrouter-tts.ts
                                  src/lib/tts/worker-client.ts ── fork ──▶              POST openrouter.ai/api/v1/audio/speech
                                  electron/tts-worker.mjs (sherpa-onnx OfflineTts)       (MP3, retried on 429/5xx)
                                        ▼ WAV                                                 ▼ MP3
                                                     audio bytes ─▶ HTMLAudioElement in the window ─▶ ReadAloudBar
```

The pieces follow the voice memo transcription design (`src/lib/transcription`, `electron/transcription-worker.mjs`, `electron/transcription-preferences.cjs`). When in doubt, copy what transcription does.

## File map

| Area | File | What it does |
| --- | --- | --- |
| Preferences | `electron/tts-preferences.cjs` (+ `.d.cts`) | Defaults, `normalizeTtsPreferences`, `ttsPreferencesFromEnvironment`, and `inspectKokoroFolder` (missing files, voice count, 8-bit) for the live folder check. Shared by Electron main and the Next server. |
| | `electron/main.cjs` | Saves/loads `config.tts` (`getConfigStatus`, `validateSetupInput`, `setup:save`, backup import), the `tts-model` folder picker in `selectSearchWeights`, `setup:check-tts-model` (preload `liberaSetup.checkTtsModel`), the `speech` model listing in `setup:list-openrouter-models`, and `LIBERA_TTS_WORKER_PATH`. |
| | `electron/preferences-io.cjs` | `tts` is in `PREFERENCE_KEYS`, so it is exported and imported with the backup. |
| | `electron/openrouter-models.cjs` | `OPENROUTER_SPEECH_MODELS_URL` (`?output_modalities=speech`); keeps each model's `supported_voices` as `voices`. |
| | `electron/setup.html` | Preferences → **Read Aloud** section (`data-section="read-aloud"`, nav button, `ttsInputs`): engine and speed, then `#tts-local-fields` (folder with a live check via `checkTtsModel`, grouped voice `<select>` built from `KOKORO_VOICES`/`KOKORO_ACCENTS`, `setLocalVoice` keeps unknown saved voices) or `#tts-openrouter-fields` (model combobox with `speech: true`, voice input with the model's voices as a datalist). |
| Server | `src/lib/tts/settings.ts` | `getTtsPreferences()` (re-reads the config file when it changes), `ttsWorkerPath()`, `ttsThreads()`. |
| | `src/lib/tts/kokoro.ts` | `resolveKokoroModel(dir, voice)`: checks the folder, picks `model.int8.onnx` over `model.onnx`, counts voices from `voices.bin`, maps the voice name to a speaker id, picks the lexicons and espeak language. |
| | `src/lib/tts/worker-client.ts` | `getTtsWorker().synthesize(files, text, sid, speed, signal)`. Forks the worker on first use, cancels on abort, exits after 2 idle minutes. |
| | `src/lib/tts/openrouter-tts.ts` | `speakWithOpenRouter()` and `speechRequestBody()`. |
| | `src/app/api/tts/route.ts` | `GET` reports `{ engine, ready, problem }`; `POST { text }` returns `audio/wav` or `audio/mpeg`. Requires sign-in. |
| Worker | `electron/tts-worker.mjs` | Loads `sherpa-onnx-node` `OfflineTts` with a `kokoro` config, caches one instance per model and thread count, returns 16-bit PCM WAV. |
| Shared | `src/lib/tts/text.ts` | `speechTextFromMarkdown`, `speechTextFromLatex`, `speechTextFromPlain`, `speechText(source, format)`, `speechChunks`, `MAX_TTS_REQUEST_CHARS`. Pure, runs in the browser and on the server. |
| Browser | `src/lib/tts/player.ts` | The one playback per window: `speakMarkdown`, `toggleSpeech`, `stopSpeech`, `toggleSpeechPause`, `subscribeSpeech`/`getSpeechState`. |
| | `src/components/libera/read-aloud.tsx` | `useSpeech()` hook and `ReadAloudBar` (mounted in `libera-app.tsx` and `file-window-page.tsx`). Errors that mention Preferences get a **Read Aloud settings** button that calls `liberaPreferences.open("read-aloud")`. |
| Entry points | `tiptap-editor-actions.tsx` | Visual editor context menu, first item when text is selected. |
| | `markdown-source/markdown-source-context-menu.tsx` + `markdown-codemirror-editor.tsx` | CodeMirror Markdown Source menu (`onReadAloud` prop). |
| | `markdown-editor.tsx` | Textarea Markdown Source menu. |
| | `latex/latex-ai-menu.tsx` | LaTeX editor menu; `format: "latex"` for `.tex/.sty/.cls/.ltx`, else `"plain"`. |
| | `code-editor.tsx` | New `CodeEditorMenu` (Read Out Loud, Cut, Copy, Paste) for every other CodeMirror file; `format: "plain"`. |
| | `pdf-viewer.tsx` | `readSelectionAloud()` and the speaker button in `.pdf-selection-menu`. |
| | `document-chat-panel.tsx` | Per-reply button (`sourceId: "chat:<message id>"`), **Auto Read** (`libera.chatAutoRead` in localStorage), auto read after `send()` completes. |
| Tests | `scripts/editor/read-aloud.test.ts` | Preferences, text cleanup, chunking, Kokoro voices and folder, OpenRouter body, model listing voices, `/api/tts` errors. |
| | `scripts/lib/tts-preferences.test.cjs` | The Preferences page in jsdom: own section, grouped voice picker, engine-specific fields, folder check, saved payload, unknown saved voices kept; `inspectKokoroFolder`. |
| Docs | `docs/features/read-aloud.md`, README "Read aloud" | User guide. |

## Contracts

### Preferences (`config.tts`)

```ts
{
  engine: "local" | "openrouter";   // default "openrouter"
  openRouterModel: string;          // default "hexgrad/kokoro-82m"
  openRouterVoice: string;          // default "af_heart"; "" sends no voice
  modelDirectory: string;           // absolute path, "" when not chosen
  localVoice: string;               // Kokoro name ("af_heart") or a speaker number ("12")
  speed: number;                    // 0.5–2, rounded to 0.01
}
```

Environment equivalents: `LIBERA_TTS_ENGINE`, `LIBERA_TTS_OPENROUTER_MODEL`, `LIBERA_TTS_OPENROUTER_VOICE`, `LIBERA_TTS_MODEL_DIR`, `LIBERA_TTS_VOICE`, `LIBERA_TTS_SPEED`. They are used only when `LIBERA_CONFIG_PATH` is unset or the config has no `tts` key.

Adding a preference: add it to `DEFAULT_TTS_PREFERENCES`, `normalizeTtsPreferences`, `ttsPreferencesFromEnvironment` and the `.d.cts` type; add the field to the Read Aloud section of `setup.html` (markup in `#tts-local-fields`, `#tts-openrouter-fields` or above them, `ttsInputs`, the `loadState` block and the save payload). Preferences can be opened at the section with `liberaPreferences.open("read-aloud")` or `?section=read-aloud`. `main.cjs` passes the whole object through `normalizeTtsPreferences`, so it needs no change.

### `/api/tts`

- `POST` body `{ text: string }`, trimmed, 1 to `MAX_TTS_REQUEST_CHARS` (1200) characters. Responses: 200 audio, 400 no text, 413 too long, 401 signed out, 502 `{ error }` with a message meant for the user, 499 when the browser aborted.
- `GET` returns `{ engine, ready, problem }`. Nothing calls it yet; it is there for a future "set up read aloud" prompt.
- The route never splits text. Splitting is the browser's job, so the server stays stateless and each request is short.

### Worker protocol (`electron/tts-worker.mjs`)

```
→ { id, type: "configure", config: { threads } }
→ { id, type: "synthesize", model: { model, voices, tokens, dataDir, lexicon, lang }, text, sid, speed }
← { id, ok: true, result: Uint8Array /* WAV */ }  |  { id, ok: false, error }
→ { type: "cancel", target: id }
```

`lexicon` is a comma-separated list, as sherpa-onnx expects. The worker uses `generateAsync` when available, so a cancel stops between sentences, and falls back to `generate`.

### Player (`src/lib/tts/player.ts`)

```ts
speakMarkdown(text, { sourceId?, label?, format?: "markdown" | "latex" | "plain" })
toggleSpeech(text, { sourceId, label?, format? })  // stops if that sourceId is the one playing
stopSpeech(); toggleSpeechPause(); dismissSpeechError()
useSpeech() → { status: "idle" | "loading" | "playing" | "paused", sourceId, label, index, total, error }
```

State is a module-level store per window (each Electron window and file window has its own). `sourceId` is how a button knows it is the one playing; use a stable, namespaced id (`chat:<id>`, `pdf:<path>`).

## Kokoro details

- **Releases.** sherpa-onnx `tts-models`: `kokoro-multi-lang-v1_0` (53 voices), `kokoro-int8-multi-lang-v1_0`, `kokoro-en-v0_19` (11 voices), `kokoro-multi-lang-v1_1` and its int8 variant (103 voices).
- **Which release.** `voices.bin` holds 510 × 256 float32 per voice (522,240 bytes), so its size gives the voice count, and the count picks the name table in `kokoro.ts` (`VOICES_V1_0`, `VOICES_V0_19`). Unknown counts (v1.1) accept speaker numbers only.
- **Voice names.** v1.0 order comes from the sherpa-onnx docs and is the same as OpenRouter's `hexgrad/kokoro-82m` voice list, except that OpenRouter also offers `em_santa`, which the sherpa export does not include.
- **Lexicons and language.** When `lexicon-us-en.txt` exists (v1.x), the lexicon is `lexicon-us-en.txt` (or `lexicon-gb-en.txt` for `b*` voices) plus `lexicon-zh.txt`. `lang` is set from the voice's first letter for Spanish, French, Hindi, Italian and Portuguese (`kokoroLanguage`). These codes are a best guess at espeak-ng names and have not been listened to.
- **Not used yet.** sherpa-onnx's `ruleFsts` (`date-zh.fst`, `number-zh.fst`, `phone-zh.fst`) and the `dict/` folder for Chinese text normalization.
- **Resources.** The model is about 310 MB (int8 is smaller). The worker runs at priority 5 with up to 4 threads (`ttsThreads`). `maxNumSentences: 1`.
- **Packaging.** No change was needed: `electron/prepare-dist.cjs` already copies `sherpa-onnx-node` and the platform addon for transcription (`copySpeechRuntime`), and `electron/` is shipped whole. If transcription ever stops using sherpa-onnx, keep that copy for TTS.

## OpenRouter details

- Endpoint `POST https://openrouter.ai/api/v1/audio/speech`, OpenAI-compatible: `{ model, input, voice?, response_format: "mp3", speed? }`. It returns raw audio, or JSON on error. `speed` is sent only when it is not 1; providers that do not support it ignore it.
- Voice lists come from `GET /api/v1/models?output_modalities=speech` (`supported_voices`), cached for a day in `openrouter-speech-models-cache.json` in the user-data folder.
- The default is `hexgrad/kokoro-82m`: $0.62 per million characters when chosen (October 2026), the cheapest speech model listed, with the same voice names as the local model.
- Not used yet: `instructions` (tone directions for gpt-4o-mini-tts, Gemini TTS and Fish Audio), `provider` data-policy options, and `pcm` output.

## How to extend

### Add Read aloud somewhere new

1. Get the text (Markdown, LaTeX or plain) and call `speakMarkdown(text, { label, format })` from `@/lib/tts/player`. Use the `Volume2` icon from lucide-react and the label **Read Out Loud** in menus, so all menus match.
2. For a button that should turn into Stop, give it a `sourceId`, call `toggleSpeech`, and read `useSpeech()` to compare `sourceId` and `status`.
3. The bar is already mounted in the main window and file windows. A new top-level window needs `<ReadAloudBar />`.

Likely next places: the rendered Markdown preview and slides, the Review chat panel (`ReviewChatPanel` in `markdown-review-ui.tsx`, which replaces the chat panel during Agentic review and has no read button), voice memo transcript passages, reference cards, and a command palette or keyboard shortcut.

### Add a source format

Add a cleaner to `src/lib/tts/text.ts`, a value to `SpeechFormat`, a branch to `speechText`, and tests to `read-aloud.test.ts`. Keep cleaners pure, with no DOM, so they run on the server too.

### Add an engine

1. Add the engine name to `TTS_ENGINES` and its fields to the preferences (see above).
2. Add a client next to `openrouter-tts.ts` that returns `{ audio: Uint8Array, contentType }`.
3. Branch on it in `src/app/api/tts/route.ts` (and in `GET` for readiness).
4. Add the option to `#tts-engine` and its fields to `updateTtsFields()` in `setup.html`.

The browser plays whatever the browser can decode (WAV, MP3, OGG, AAC), so the player needs no change.

### Add a downloader for Kokoro

Transcription has a resumable, SHA-256-checked downloader (`getSpeechModelDownloader` in `src/lib/transcription/models.ts`, `/api/transcripts/setup`). A Kokoro equivalent would pin a Hugging Face mirror of the sherpa export, since the GitHub release is a `.tar.bz2` that would need extracting. Then add a "Download Kokoro" prompt that uses `GET /api/tts`'s `ready`/`problem`.

## Open items

Known gaps and ideas, roughly in order of value:

- **Manual checks still to do:** Kokoro audio on macOS and Windows (int8 and full precision, v0.19 and v1.0), OpenRouter audio with the default model and one other (voice suggestions, error messages for a bad key and no credits), the menus in each editor, the PDF toolbar width, and Auto Read with Chat and Agent.
- **Language codes** for non-English Kokoro voices (`kokoroLanguage`) need listening to; Chinese and Japanese would benefit from `ruleFsts` and `dict/`.
- **v1.1 voice names** (103 speakers) are not mapped; add the table from sherpa-onnx PR #1942 to `kokoro.ts` and `KOKORO_VOICES` in `setup.html`.
- **Auto Read waits for the whole reply.** Reading while the reply streams would mean feeding `speechChunks` incrementally from the stream and holding back an unfinished last sentence.
- **No progress highlighting.** The player knows which passage is playing (`index`), but nothing maps it back to the source text.
- **No caching.** Reading the same reply twice synthesizes it twice. An in-memory cache keyed by engine, model, voice, speed and text in the route (or in the player) would make replays instant and save OpenRouter cost.
- **One playback per window.** Starting speech in a file window does not stop speech in the main window.
- **Packaging:** `prepare-dist` copies sherpa-onnx only for this platform's build. Check a packaged build runs the TTS worker (the transcription worker proves the runtime, not this file).
- **Voice preview.** Preferences cannot play a sample voice yet: the page is not served by the Next server, so it would need an IPC call that synthesizes through it.
- **Pre-existing test failures** unrelated to read aloud, seen while testing: four in `scripts/lib/session-shutdown.test.cjs` (`collabHost is not defined`), `document-chat-panel.test.ts` (file mentions after remount, line 349) and two tests in `markdown-codemirror-editor.test.ts` (Cmd/Ctrl+B and wildcard find).

## Checks

```bash
node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/read-aloud.test.ts
node --test scripts/lib/tts-preferences.test.cjs
```

Related suites that touch the same files: `document-chat-panel.test.ts`, `markdown-codemirror-editor.test.ts`, `markdown.test.ts`, `references-pdfcite-viewer.test.ts`, and `scripts/lib/{preferences-io,openrouter-models}.test.cjs`.
