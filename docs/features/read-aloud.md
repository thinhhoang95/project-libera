# Read aloud

Libera reads text out loud: selections in the editors and PDFs, and AI Chat replies.

For how it is built and how to extend it, see [docs/read-aloud/implementation.md](../read-aloud/implementation.md).

## Where to find it

- **Visual editor (TipTap)**: select text, right-click, **Read Out Loud**.
- **Markdown Source editor** (textarea and CodeMirror): select text, right-click, **Read Out Loud**.
- **LaTeX editor**: select text, right-click, **Read Out Loud**. In `.tex` files the LaTeX is cleaned first: comments, citations, references, labels and markup commands are left out, math is said as "equation", and lines wrapped in the source are read as one paragraph.
- **Code and text files** (the CodeMirror code editor): right-click now opens a menu with **Read Out Loud**, Cut, Copy and Paste. The text is read as written, one line at a time.
- **PDFs**: select text; the selection toolbar has a speaker button (**Read out loud**) beside Copy and Quote and cite. The selection is read as clean text, the way it is copied.
- **AI Chat and Agent**: each finished reply has a speaker button beside Copy; while that reply is being read it becomes a stop button. The chat's ⋯ menu has **Auto Read**, which reads every reply aloud when the model finishes. A reply that was stopped or failed is not read. Auto Read is remembered on this computer.

While something is being read, a small bar at the bottom of the window shows its progress, with **Pause** and **Stop**. Starting to read something else stops what was playing. If reading fails (no API key, the model folder is missing, the provider refuses), the bar says why.

Markdown is turned into speakable text first: headings, emphasis, list bullets, tables, link URLs, footnote marks and Pandoc citations are dropped, links keep their text, images their description, code blocks are said as "code omitted" and math as "equation".

## Engines

Preferences → **Read Aloud**:

- **Read with**: OpenRouter (the default, since it needs only the API key) or this computer.
- **OpenRouter text-to-speech model**: any model listed with speech output; the field suggests them. The default `hexgrad/kokoro-82m` is the same Kokoro model as on this computer, at well under a dollar per million characters. Others, such as `openai/gpt-4o-mini-tts` or `google/gemini-3.8-flash-lite-tts`, are more expressive and cost more.
- **OpenRouter voice**: suggestions come from the chosen model's voice list. Empty uses the provider's default, where it has one.
- **Kokoro model folder**: checked as soon as it is chosen; the line under it says what is missing, or how many voices the model has.
- **Voice** (Kokoro): a list grouped by accent and gender (American English · female, British English · male, …), with `af_heart` as the default.
- **Speed**: 0.75×–2×. Kokoro on this computer always follows it; on OpenRouter only some providers do.

Only the chosen engine's settings are shown. Changes apply without restarting. When reading fails for a setup reason, the bar at the bottom has a **Read Aloud settings** button that opens this section. A web deployment sets `LIBERA_TTS_ENGINE`, `LIBERA_TTS_OPENROUTER_MODEL`, `LIBERA_TTS_OPENROUTER_VOICE`, `LIBERA_TTS_MODEL_DIR`, `LIBERA_TTS_VOICE` and `LIBERA_TTS_SPEED` instead.

### Kokoro 82M on this computer

[Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0) runs on the CPU through sherpa-onnx, the same runtime as voice memo transcription. Nothing leaves the computer. Like the EmbeddingGemma and Parakeet weights, the model stays outside Libera:

1. Download a Kokoro release from sherpa-onnx's [tts-models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models) release: `kokoro-multi-lang-v1_0.tar.bz2` (53 voices, 8 languages, about 340 MB), `kokoro-int8-multi-lang-v1_0.tar.bz2` (8-bit, smaller and faster), or `kokoro-en-v0_19.tar.bz2` (English only, 11 voices).
2. Extract it and choose the folder in Preferences. It must hold:

   ```
   <folder>/model.onnx (or model.int8.onnx), voices.bin, tokens.txt, espeak-ng-data/
   ```

   The lexicons (`lexicon-us-en.txt`, `lexicon-gb-en.txt`, `lexicon-zh.txt`) of the multi-language releases are used when present: British voices read with the British one.

Voices are named by accent and gender: the first letter is a (American), b (British), e (Spanish), f (French), h (Hindi), i (Italian), j (Japanese), p (Brazilian Portuguese) or z (Chinese), the second f or m. `af_heart` is the default. The release is recognized from the number of voices in `voices.bin`; for a release Libera does not know (such as v1.1, with 103 voices), give the voice as its speaker number.

## How it works

1. **Clean and split** (`src/lib/tts/text.ts`). The browser turns the source (Markdown, LaTeX or plain text) into speakable text and splits it into passages of whole sentences, about 320 characters each and never across paragraphs. The first passage is kept short so speech starts quickly.
2. **Synthesize** (`/api/tts`). Each passage is sent on its own. With Kokoro, a worker process (`electron/tts-worker.mjs`, like the transcription worker) loads the model once and returns WAV; it exits two minutes after its last passage, returning its memory. With OpenRouter, the passage goes to `/api/v1/audio/speech` and comes back as MP3; busy providers are retried.
3. **Play** (`src/lib/tts/player.ts`). The window plays one passage while preparing the next two. Stopping cancels what is still being prepared.

## Checks

`node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/read-aloud.test.ts`

Covers preferences, Markdown, LaTeX and plain-text cleanup, splitting into passages, Kokoro voice names and speaker numbers, checking and resolving the model folder, the OpenRouter request, and keeping each speech model's voices in the model listing. Synthesis itself (Kokoro or OpenRouter) is not exercised by the tests.
