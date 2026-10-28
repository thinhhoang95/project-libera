# Voice memos

Recordings live in notebooks like any other file: upload or drop `.m4a`, `.mp3`, `.wav`, `.aac`, `.ogg`, `.opus`, `.flac` or `.webm` files into a notebook. Opening one shows its waveform and its transcript, timestamped, with who said what, which you can correct by typing in it. The player's controls, transcribing, speakers and exports are in the **Voice Memo** tab of the left panel's rail, which appears (and opens) while a voice memo is the active tab, like the Spending tab for the Spending page.

To record a meeting straight into a notebook, with a live transcript and a live recap, see [Recording meetings](meeting-recorder.md).

## The player

The page keeps a play/pause button beside the waveform, so playing never needs the rail; **Controls** in the toolbar shows the Voice Memo tab when the left panel is on another tab or collapsed.

- **Transport** (Voice Memo tab). Play/pause (Space or K), back and forward 15 s, previous and next recording in the folder (`[` and `]`), stop, a position slider, playback speed (0.75×–2×, `<` and `>`), volume and mute (M), and Audio Boost (up to 400%, for quiet recordings). ← and → step 5 s, J and L 10 s; Shift+← and Shift+→ go to the previous or next passage of the transcript.
- **Waveform.** Click or drag to seek; hover shows the time. A colored lane under it shows which speaker talks when; transcript search matches show as ticks above it. The waveform is decoded once and cached beside the recording.
- **Now speaking.** Under the title, the passage being played, with its speaker.
- Where playback was, the speed, the volume, Audio Boost and Follow playback are remembered per tab. Recordings stream in ranges, so an hour-long memo starts at once and seeks anywhere.

## The transcript

The transcript fills the page under the waveform, as a document.

- **Correct it in place.** Click any line and type. Enter breaks the line in two (at the end of a line, it starts a new one; the time is shared in proportion to the text), Backspace at the start of a line joins it to the one before, Delete at the end joins the next one, and the arrows cross between lines. Escape puts the line back as it was. The corrections are kept in memory while you type and written **once, when the editing ends**: when you click outside the transcript, switch tabs, close the tab or the window. A line left empty is dropped. Speaker talk times stay as measured; passage and word counts follow the text. In a shared notebook, the corrections are shared with the transcript.
- **Follow playback** (a switch in the Voice Memo tab). The passage being played is highlighted and kept in view; scroll away and a **Back to now playing** button brings it back. Click a timestamp to play from there.
- **Find in transcript** (⌘/Ctrl+F or `/`). Case- and accent-insensitive, with *n of m*, Enter / Shift+Enter or ↑ ↓ to step through matches. `speaker:Name` limits it to one speaker, by the start of their name, their number or a quoted name: `budget speaker:Vy`, `speaker:2`, `speaker:"Speaker 3" deadline`. Several `speaker:` filters show any of them; `speaker:Vy` alone steps through everything Vy said. Typing `speaker:` suggests the names.
- **Speakers** (Voice Memo tab). Each speaker is a chip with a color and their share of the talking. Click a chip to show only what they said; the pencil renames them ("Speaker 2" → "Vy"). Names are kept with the transcript and are searchable.
- **Quote in AI Chat.** Hover a line for its quote button, or select any part of the transcript and press ⌘/Ctrl+Shift+L (or the **Quote in chat** button over the selection). The lines go to AI Chat as a selection with their times and speakers ("[3:05] Vy: …"), and the transcript joins the conversation as context once.
- **Link to a moment.** A line's link button copies `[Lab meeting · 3:05](Memos/Lab%20meeting.m4a#t=185)`. Paste it in any note: opening it plays the recording from there. The @ link picker in notes offers the recording's current position too, and AI answers can cite moments the same way.
- **⋯ menu**, beside the Voice Memo tab's title. Copy as Markdown or plain text (with the corrections being made); **Open as a new note** (an unsaved Markdown tab, saved where you choose); **Save as a note beside the recording**; save to this computer as Markdown, plain text, SRT or WebVTT subtitles (a Save dialog in the desktop app); transcribe again; speech settings (desktop app); delete the transcript. A transcript saved as a note is a note like any other, and Global Search finds it as one too.
- The Voice Memo tab's **Transcript** section shows the engine, language, word and passage counts, overlapping speech (from pyannote), and whether the transcript is shared.

## Transcribing

The Voice Memo tab offers **Transcribe** for a recording without a transcript (the page's **Transcribe…** button opens it). Choose where it runs and, if you know it, how many people speak (it is otherwise detected). Transcription continues in the background: switch tabs or open other recordings meanwhile. One recording is transcribed at a time; others wait in line.

- **On this computer** — NVIDIA [Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (CC-BY-4.0), 25 European languages with punctuation and capitalization, in sherpa-onnx's 8-bit export. Nothing leaves the computer.
- **OpenRouter** — any OpenRouter speech-to-text model, `openai/whisper-large-v3` by default (Preferences → Speech lists them). The audio is sent in pieces of up to four minutes as 16 kHz WAV. Word or segment timestamps are used when the provider returns them; otherwise the text is spread over its piece.

Speakers are told apart on this computer with either engine, by [pyannote segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0) (MIT) and the 3D-Speaker CAM++ speaker embedding (Apache-2.0), clustered across the whole recording.

## How it works

1. **Decode.** A worker process (`electron/transcription-worker.mjs`, like the search and PDF reading workers) decodes the recording to 16 kHz mono with ffmpeg; without ffmpeg, macOS's built-in `afconvert`; without either, WAV only. It also measures loudness every 50 ms.
2. **Diarize.** pyannote finds who speaks when over the whole recording, through sherpa-onnx. The turns are kept, with the number of speakers, the seconds of speech and of overlapping speech.
3. **Chunk.** Speech is split into pieces of at most 28 s for Parakeet (or 4 minutes for OpenRouter), packed across short pauses and cut at the quietest moment near each limit, so no word is split between pieces and pieces need no overlap. Without diarization the whole recording is chunked the same way.
4. **Recognize.** Each piece is transcribed and its word timestamps are shifted to the recording's timeline, so the pieces simply follow one another.
5. **Align.** Each word takes the speaker whose turn overlaps it most. Words are grouped into passages at speaker changes, pauses longer than 1.5 s, and sentence ends once a passage runs past 25 s. Speakers are numbered in the order they first speak.

Recognition and diarization are independent: a recording without pyannote models is still transcribed, without speakers.

## Storage and search

A transcript is a sidecar, not a notebook file (for shared notebooks, see below): `.libera/transcripts/by-path/<folders>/<name>.json` in its notebook (in a linked folder, in its state folder), next to the cached waveform in `.libera/audio-peaks/`. Both follow the recording when it is moved, renamed, copied, archived or deleted. A transcript records the recording's size, and is shown as out of date when the recording changes.

Global Search indexes a recording through its transcript and never reads the audio, so nothing is indexed twice and no audio is decoded while indexing. `speaker:Name` in Global Search (`budget speaker:Vy`) shows only voice memo passages where that speaker talks. Passages hold about 250 tokens of consecutive lines, each led by its speaker, so searching a speaker's name finds what they said. Results show under **Voice memos**, with the time and speakers; the preview plays the passage, and **Open** plays the recording from the line that matched. Transcribing, transcribing again and renaming a speaker reindex the recording. A recording without a transcript is found by its name.

## With AI Chat

While a voice memo is open, AI Chat includes its transcript as context, like the Markdown draft or PDF text of other tabs: it is read when the message is sent, once per conversation ("already included" afterwards), and the context bar can remove it. Starters offer a summary, decisions and action items, and open questions. Quotes from the transcript panel arrive as selections. AI Chat's @ attachments and the agent's Read tool read recordings as their transcripts (Agentic Review's @ references are Markdown files only). The agent's Grep searches transcripts too, line by line with times and speakers, so `Vy:.*budget` finds what Vy said about the budget; recordings without a transcript are reported as skipped, and their audio is never searched.

## Dictation

AI Chat, the Agent and Agentic Review have a microphone in their prompt box, and so do the Write with AI and AI Rewrite prompts in the Markdown and LaTeX editors and their context menus (Escape there stops a dictation before it closes the prompt). Click it, speak, and click it again (or **Done**): the words are typed at the caret. Dictation uses the engine chosen in Preferences → Speech → Dictation (by default the voice memo engine: Parakeet on this computer, or OpenRouter), without telling speakers apart, and keeps nothing. The window records 16 kHz mono itself, so no ffmpeg is needed; a dictation stops on its own after five minutes. **Cancel** (×) discards it. The desktop app asks for microphone access the first time (macOS: System Settings → Privacy & Security → Microphone).

## In shared notebooks

Recordings in a shared notebook sync like other binaries: as blobs in the notebook's manifest. Recordings larger than a control request (11 MB) are staged in the notebook's `.libera/collab/incoming/` folder for the collab host, which reads and removes them; the server's blob limit (100 MB by default) applies.

`.libera` stays on each computer, so a shared recording's transcript is a **companion file** beside it, `<name>.transcript` (for `memo.m4a`, `memo.m4a.transcript`), shared as a blob. Every member sees the same transcript and speaker names, and a transcript a collaborator makes, renames or corrects arrives in an open viewer by itself (the Voice Memo tab says **Shared**). Libera lists only the file types it opens, so the companion shows neither in the tree nor in search; Global Search reindexes the recording when its companion changes.

- Renaming, moving or deleting a recording through Libera renames, moves or deletes its companion in the same notebook; renaming a folder carries everything in it. Copying a recording into a shared notebook shares its transcript as the copy's companion; copying one out keeps it as a sidecar.
- When a collaborator renames or deletes a recording, the host's tree events move or remove this computer's sidecars (the cached waveform, and a transcript not yet shared).
- A member whose role cannot change files (or whose collaboration service is not running) still transcribes: the transcript is kept on their computer only, and is shared the next time a change to it can be.
- Renaming a recording in Finder or Explorer leaves its companion under the old name; rename it the same way, or transcribe again.

## Setting up

Preferences → **Speech** (its own section, next to Search and Read Aloud):

- **Models**
  - **Speech models folder** — like the EmbeddingGemma weights, the models stay outside your notes; voice memos and dictation share them. Empty uses `models/speech` in Libera's application data (next to the search index; `users/admin/.libera/models/speech` for a web deployment); choose another folder to keep them elsewhere. The first time you transcribe, the Voice Memo tab offers to download them there: Parakeet (about 670 MB) and the two speaker models (34 MB), pinned revisions checked by size and SHA-256, resumable. With OpenRouter only the speaker models are needed. Or put the files there yourself:

    ```
    <folder>/parakeet-tdt-0.6b-v3/encoder.int8.onnx, decoder.int8.onnx, joiner.int8.onnx, tokens.txt
    <folder>/pyannote-segmentation-3.0/model.onnx
    <folder>/speaker-embedding/<any sherpa-onnx speaker embedding>.onnx
    ```

    Full-precision files (`encoder.onnx`, …) work too; the 8-bit ones are preferred when both are present.
  - **ffmpeg** — found automatically when installed (Homebrew, MacPorts, winget, Scoop, Chocolatey, or on the PATH); choose it here otherwise. Dictation does not need it.
- **Voice memos** — **Transcribe with** this computer or OpenRouter, the **OpenRouter speech-to-text model**, the **Language** (an ISO code such as `en`; empty detects it), **Tell speakers apart**, and the default **Number of speakers**.
- **Dictation** — **Dictate with** the same engine as voice memos (the default), this computer, or OpenRouter; its own OpenRouter model and language, which are empty to follow the voice memo settings. A fast model suits short prompts even when memos use a more accurate one.

Dictation is speech to text, so there is no voice to choose; the voices for reading text out loud are in Preferences → Read Aloud.

Changes apply without restarting. A web deployment sets `LIBERA_TRANSCRIPTION_ENGINE`, `LIBERA_TRANSCRIPTION_OPENROUTER_MODEL`, `LIBERA_TRANSCRIPTION_LANGUAGE`, `LIBERA_TRANSCRIPTION_MODEL_DIR`, `LIBERA_TRANSCRIPTION_DIARIZATION`, `LIBERA_TRANSCRIPTION_SPEAKERS`, `LIBERA_FFMPEG_PATH`, `LIBERA_DICTATION_ENGINE`, `LIBERA_DICTATION_OPENROUTER_MODEL` and `LIBERA_DICTATION_LANGUAGE` instead.

## Notes

- A recording is decoded into memory once while it is transcribed: about 230 MB per hour of audio.
- The worker runs at lower priority with up to four threads and exits two minutes after its last job, returning its memory.
- Diarization works best with a known number of speakers and little crosstalk; overlapping speech is attributed to whoever dominates each word.

## Checks

`node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/voice-memos.test.ts`
`node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/transcript-edits.test.ts`
`node --require ./scripts/editor/setup.cjs --import tsx --test scripts/collab/voice-memos-shared.test.ts`
`node --test scripts/lib/speech-preferences.test.cjs`

Covers file types, speech regions, chunking at quiet moments and packing, token and segment timing, speaker attribution (overlap, nearest turn, long turns), passage grouping (speaker changes, pauses, sentence ends, CJK and punctuation), speaker numbering and coverage, OpenRouter responses with words, segments or text only, passages and exports, sidecars through moves, copies, folder renames and deletion, stale detection, range requests, preferences, and the worker decoding a WAV, measuring loudness, slicing WAV pieces and drawing peaks. It also covers `speaker:` in the transcript panel and in Global Search, the text, WebVTT and AI-context exports, and links to moments (`#t=`). `global-search-cache.test.ts` covers indexing a recording through its transcript. `voice-memos-shared.test.ts` covers companion transcripts in shared notebooks: sharing, renames, deletions, collaborators' changes, members who cannot write, copies in, and staged large uploads.
