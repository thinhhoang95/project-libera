# Recording meetings

Record a meeting, a lecture or a thought straight into a notebook. While you record, Libera can transcribe on this computer with Parakeet and keep a **Live Recap**: a short list of bullet points that an AI model amends as the meeting goes on. When you stop, the recording becomes a voice memo in the notebook, with its transcript and a recap note beside it.

## Starting a recording

- **New → Audio recording** on a notebook's cover.
- **New audio recording** in a notebook's ⋯ menu in the sidebar, or **Add Audio Recording** in a folder's menu, to record into that folder.

The recording opens in a tab of its own, beside your notes, and records right away. A window records one meeting at a time; the menu entries are hidden or greyed out while one is running. The desktop app asks for microphone access the first time (macOS: System Settings → Privacy & Security → Microphone).

## The recording tab

The tab is laid out like a voice memo: the page shows what is being recorded, and the **Recording** tab of the left panel's rail, which appears and opens with it, holds the recorder's controls (**Controls** in the toolbar brings it back).

- **Title.** Click the name ("Recording 2026-10-19 14.30" by default) to rename it; it becomes the file name, and the tab follows it. Under it, the last thing said, once live transcription is on.
- **Live waveform and clock.** The waveform scrolls through the last twenty seconds or so; the clock counts recorded audio, so pauses do not add to it.
- **Pause / Resume** (Space; a button beside the waveform and in the Recording tab). The microphone is muted while paused, and what was recorded so far is saved first. If the microphone is unplugged, the recording pauses with a message; **Resume** opens the microphone again.
- **Stop & save** (Recording tab) saves the recording into the notebook (see [Saving](#saving)).
- **Delete the recording** (Recording tab) throws it away after asking, and closes the tab.
- The **Live transcribe** and **Live recap** switches, **Update the recap now** and the speech model download are in the Recording tab too.
- **Live recap** and **Transcript** share the page, side by side when it is wide enough (see [Live Recap](#live-recap)).

## Correcting while you record

Both the recap and the live transcript are editable while you record: click a point or a line and type. Enter breaks it in two or starts a new one, Backspace at the start joins it to the one before, Delete at the end joins the next, and Escape puts it back. **Add a point** under the recap adds one of your own. New passages keep arriving below the ones you changed.

Changes are kept in memory while you type and sent **once, when the editing ends** (you click outside the recap or the transcript, switch tabs, or the window closes); **Stop & save** sends any still pending first. Transcript corrections are kept beside the recording's pieces (`edits.json`), so they survive a crash too. The saved transcript is then the live one as you left it, rather than the words regrouped. A recap point you wrote or changed is yours: the model is told so (it sees it marked `*`), and any change it proposes to it is dropped. If a change cannot be sent, the Recording tab says so and the change is kept and sent again the next time the editing ends.

The recording goes on while you work in other tabs, or after you close its tab: a small bar at the bottom left shows the clock, with Pause/Resume, Stop and **Show**, which brings the tab back. The tab can be split beside a note like any other, to take notes during the meeting.

The microphone records 16 kHz mono with echo cancellation, noise suppression and automatic gain, the format Parakeet listens to.

## Live transcribe

The **Live transcribe** switch transcribes the meeting as you record it, on this computer, with NVIDIA [Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (CC-BY-4.0): 25 European languages, with punctuation. Nothing leaves the computer. The **Transcript** panel shows each phrase with its time a few seconds after it is spoken, and stays at the newest line unless you scroll up; **Latest** goes back down.

- It needs the Parakeet model, the same one voice memos use. Without it, the switch is off and greyed out, and the recorder offers **Download speech models** (about 705 MB with the speaker models, downloaded once into the speech models folder from Preferences → Speech). The switch can be turned on once the download finishes, even mid-recording.
- Turning it on partway through transcribes what was already recorded too, then catches up. "Catching up: *n* pieces to transcribe…" shows while it does.
- Live transcription does not tell speakers apart. After saving, **Transcribe again** in the voice memo's ⋯ menu makes a transcript with who said what.

Parakeet is an offline model: it hears a whole piece of audio at once rather than a continuous stream. The recorder cuts the audio into short pieces at natural pauses and Parakeet transcribes each one as it arrives, the way sherpa-onnx's "simulated streaming" works (see [How it works](#how-it-works)).

## Live Recap

The **Live recap** switch keeps a bullet-point summary on the recording tab: topics, decisions, numbers, open questions and action items, with the time each point came up.

The recap is **amended, never rewritten**, so what you have read stays where it was. Each update shows the model the bullets so far, each with its number, and only the part of the transcript it has not read yet. The model answers with at most four changes, each either:

- **add** a bullet at the end, for something new; or
- **update** one existing bullet by its number, when the meeting adds to it or corrects it.

The model never deletes or reorders bullets, and a bullet that repeats one already there is dropped (you can do both yourself; see [Correcting while you record](#correcting-while-you-record)). Bullets added or changed by the latest update are highlighted for a few seconds.

- It updates once about 90 new words have been transcribed and at least 40 seconds have passed since the last update. **Update the recap now** brings it up to date.
- It needs live transcription, and an OpenRouter API key (Preferences → AI). It uses the AI model chosen for **Formatting** in Preferences → AI, at low reasoning effort. Only the transcript text is sent, never the audio.
- If an update fails (no network, for example), the error shows under the bullets and the next update tries again with everything not yet read.

Both switches are remembered for the next recording.

## Saving

**Stop** sends the last few seconds, waits for Parakeet to transcribe them, and lets the recap read the rest of the transcript. Then it saves into the notebook (or folder):

- **The recording**, as AAC in an `.m4a` file (64 kbps, about 29 MB an hour) when ffmpeg or macOS's `afconvert` is available, otherwise as WAV (about 115 MB an hour). A name already taken gets `-1`, `-2`, ….
- **Its transcript**, when live transcription was on (with your corrections): the voice memo's transcript, with search, quoting into AI Chat, exports and links to moments like any other (see [Voice memos](voice-memos.md)).
- **A recap note**, `<name> recap.md`, when the recap has bullets (yours included). Each bullet links to the moment it was first heard (`Weekly sync.m4a#t=754`), so clicking a time plays the recording from there.

The recording tab turns into the saved voice memo, in place, and the recap note opens beside it. If saving fails (the notebook was removed, for example), the recording stays open, paused, with the error, and nothing is lost: **Stop & save** tries again.

## If Libera closes while recording

While you record, the audio is saved to disk every few seconds, outside your notes. A crash of the window or the app, a power cut or a forced quit loses at most the last few seconds.

The next time Libera opens, a card lists the recordings that were not finished, with their length and notebook. A recording tab that was still open when the window reloaded shows the same choices itself:

- **Save** saves it as if you had pressed Stop & save, with the transcript and recap made so far.
- **Record on** opens it again, paused, so you can carry on recording after what is already there. Parakeet keeps transcribing what was saved even while no window holds the recording, so the transcript is up to date when you come back.
- **Delete** throws it away after asking.
- **×** hides the card until Libera opens again.

If Libera's server cannot be reached while recording, the recorder keeps the audio in the window and keeps sending it, trying again up to every 10 seconds; a notice shows how much is waiting. That audio is lost if the window is closed before it is sent.

## How it works

1. **Capture.** An AudioWorklet in the window copies the microphone's 16 kHz samples, so recording stays smooth while the app is busy.
2. **Chunk.** Once a piece is 5 seconds long, it ends at the next quarter second of quiet: quieter than 1.6 times the 20th percentile of the piece's loudness, measured every 8 ms. A piece that reaches 18 seconds without a pause is cut at its quietest quarter second in the last 4 seconds. Pieces therefore hold whole phrases, which Parakeet transcribes best, and a crash loses little. Pausing or stopping ends the current piece.
3. **Save.** Each piece goes to the server as a 16-bit WAV with its number and its position in samples. The server writes it atomically as `chunk-000123.wav` and records it in `session.json`. A piece sent twice (after a lost reply) is kept once.
4. **Transcribe.** When live transcription is on, the server hands each new piece, oldest first, to the transcription worker (`electron/transcription-worker.mjs`, shared with voice memos). It shifts the word timestamps by the piece's position and appends them to `words.jsonl`. A line cut short by a crash is ignored and that piece is transcribed again.
5. **Recap.** After each transcribed piece, the server checks whether the recap is due and asks the model (see [Live Recap](#live-recap)). The prompt shows the bullets with their numbers, the last 250 words already read (for context only) and at most 1,800 new words with their times. The reply is JSON (`{"operations": [{"op": "add", "text": …}, {"op": "update", "id": 3, "text": …}]}`); anything malformed, an unknown bullet number or a delete is ignored. The bullets and how many words the recap has read go to `recap.json`.
6. **Show.** The recorder asks the server every 2 seconds for new transcript passages and, only when it changed, the recap.
7. **Finish.** The pieces are joined in order into one WAV (a missing piece becomes silence), compressed, and written into the notebook through the same path as uploads, so shared notebooks receive it as a blob and the transcript as a companion file. Then the folder of pieces is removed.

Recordings in progress live in Libera's data folder, in `recordings/<id>/` next to `users/` (`data/libera/recordings` when running from the project). They are never inside a notebook, so a synced notes folder does not upload half-finished recordings.

The recorder talks to these routes:

| Route | Does |
| --- | --- |
| `GET /api/recordings` | Recordings left unfinished |
| `POST /api/recordings` | Start a recording (`notebook`, `parentPath`, `name`, `liveTranscribe`, `liveRecap`) |
| `GET /api/recordings/:id?after=&recap=` | Progress, new transcript passages, the recap when it changed (with the whole transcript, `after=0`, also the transcript corrections) |
| `PATCH /api/recordings/:id` | Rename, switch live transcription or the recap, keep corrections (`transcriptEdits`, `recapEdits`) |
| `DELETE /api/recordings/:id` | Throw the recording away |
| `PUT /api/recordings/:id/chunks/:index?start=` | Save a piece (16 kHz mono 16-bit WAV) |
| `POST /api/recordings/:id/recap` | Bring the recap up to date now |
| `POST /api/recordings/:id/finish` | Save into the notebook |

## Notes

- Live transcription runs the transcription worker at lower priority with up to four threads, like voice memos. On a slow computer it may fall behind during a long meeting; it catches up, and Stop waits for it to finish.
- The recap is written in the language of the transcript.
- The live transcript groups words into passages within each piece (at pauses over 1.2 s); the saved transcript groups them across the whole recording (at pauses over 1.5 s), unless you corrected the live transcript, which is then kept as you left it.

## Checks

`node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/recording.test.ts`
`node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/transcript-edits.test.ts`

Covers reading the model's replies (code fences, unknown bullets, deletes, malformed JSON), applying changes without removing or reordering bullets and without duplicates, the prompt (bullet numbers, context, only unread transcript), the recap note's links to moments, and a recording that survives a simulated crash: pieces saved twice, a malformed piece refused, the recording listed as unfinished after the server forgets it, the next piece number and position, and saving it as one file with its pieces removed.
