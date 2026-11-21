# Audio Studio: handoff for a new Claude session (21 Nov 2026)

## Who and why
- The owner (Tushan) is not technical. He prefers plain explanations and one clear recommendation.
- He plays guitar and sings, and wants this to become his personal music tool.
- Free tools only. No paid services or subscriptions.
- The app is private and offline, and runs only on his Windows 11 PC.
- It is NOT part of his furniture website (`c:\wamp64\www\newpriyatamafurniture`). Never mix the two, and never upload this app anywhere.

## Where things are
| Path | What |
|---|---|
| `C:\Users\asus\audio-studio\` | The project (its own git repo, local only) |
| `app\server.py` | FastAPI web API. Listens on 127.0.0.1:8765 only; a middleware refuses other Host/Origin headers |
| `app\ops.py` | All the tools: edit, effects, analyse, best part, video, beat reel, voice |
| `app\media.py` | Library (`workspace\index.json`) and a safe ffmpeg runner (argument lists, never a shell) |
| `static\index.html`, `app.js`, `app.css` | The single-page UI (dark theme). No build step |
| `static\vendor\` | wavesurfer.js 7.8.6 + regions plugin, downloaded so it works offline |
| `.venv\` | Python 3.12 virtual env (fastapi, uvicorn, python-multipart, imageio-ffmpeg 0.5.1, numpy, soundfile, librosa, kokoro-onnx, demucs 4.1.0 + torch CPU). See `requirements.txt` |
| `workspace\` | Created on first run: `files\` (every file, named `<id>.<ext>`), `tmp\`, `index.json`. Git-ignored |
| `Start Audio Studio.bat` | Starts the server and opens http://127.0.0.1:8765 |
| `C:\Users\asus\npf-voice\` | NOT created by this project: the existing Kokoro voice model (`kokoro-v1.0.int8.onnx`, `voices-v1.0.bin`), read from here (env `STUDIO_KOKORO_DIR` overrides) |

Run manually: `.venv\Scripts\python.exe -m uvicorn app.server:app --host 127.0.0.1 --port 8765`

## What v1 does (all tested end to end)
- **Library:** upload or drag-drop audio, video and images (max 2 GB each).
  - **Mic recording:** `getUserMedia` with echoCancellation, noiseSuppression and autoGainControl OFF; WebM/Opus upload converted to WAV; level meter.
  - Ticking files (checkbox order is kept) feeds Join and Beat reel.
  - Non-destructive: every tool registers a new file with `op` and `parent`.
- **Edit:** waveform region select → trim (also for video), cut out, fades, volume (with limiter), loop, join with crossfade (`acrossfade` chain), export (MP3, M4A, OGG, FLAC, WAV, MP4), extract audio from video. Audio work files are 44.1 kHz stereo WAV.
- **Effects:** chain in `ops.effects()`.
  - **Clean-up:** `afftdn` noise reduction; 50/100/150 Hz `bandreject` for Indian mains hum; highpass; `deesser`.
  - **EQ:** bass, 1 kHz, 3.2 kHz presence, treble.
  - **Dynamics:** `acompressor` (thresholds converted dB→linear by `_lin`, because old ffmpeg doesn't take dB there).
  - **Character:** lo-fi (`acrusher`), radio, pitch (`asetrate` + `aresample` + `atempo` chain), speed (`atempo` chain), echo (`aecho`), width (`extrastereo`), silence removal.
  - **Reverb:** convolution via `afir` with a numpy-generated impulse response cached in `tmp\ir-<room>.wav`, dry/wet through `asplit` + `amix`.
  - **Loudness:** `loudnorm` (-14 / -16 / -23), otherwise `alimiter`.
  - **Presets** in `PRESETS`: vocal, guitar, cleanup, lofi, radio, bass, hall.
- **Analyse:** librosa `beat_track` (BPM); key from chroma_cqt correlated with Krumhansl profiles; LUFS and peak from ffmpeg `ebur128`. On a generated A-minor 120 BPM test song it gave A minor / 117.5 BPM.
- **Best part:** RMS + onset-strength window score, start snapped to a beat, with fades.
- **Video:**
  - **Music under video:** optional ducking via `sidechaincompress` keyed on the video's own audio; video stream copied.
  - **Beat reel:** builds a steady beat grid from the median beat interval + first beat phase, so quiet intros still get cuts. Each shot is rendered to 1080-wide 9:16 / 4:5 / 1:1 / 16:9 (scale+crop, 30 fps, libx264); photos get a slow `zoompan` from a single frame. Shots are joined with the concat demuxer, then the music is added with a fade.
- **Voice:** Kokoro-onnx, 8 English voices (`VOICES`); optional music bed ducked under the voice, loudness -14.

## Added in v2 (21 Nov 2026, all tested)
- **Tuner** (header button, modal `#tuner` in index.html, bottom of app.js): mic → AnalyserNode (4096) → YIN
  with parabolic interpolation on the *raw* difference curve (sign matters: `(a-c)/(2(a-2b+c))`), median of
  the last 7 readings. Synthetic test: under 0.1 cent on steady notes from 73 to 660 Hz. Shows the chromatic
  note + needle, plus advice for the nearest string of the chosen tuning (6 tunings, A = 415–466).
- **Practice tab:** `ws.setPlaybackRate(rate, true)` (browser keeps the pitch), 50–125%; A–B is the waveform
  region. Play now really stops at the region end, or loops with an optional pause (`regionEnd()` in app.js,
  driven by `timeupdate`). This also fixed v1's "Play plays the selection", which never stopped.
  "Save a practice copy" = `ops.practice_copy` (atrim + atempo chain).
- **Split song:** `ops.split` with Demucs `htdemucs_6s` (drums, bass, other, vocals, guitar, piano), CPU,
  ~0.5× song length (40 s song ≈ 9–25 s, 30 s ≈ 15 s cold). Outputs chosen from `STEMS` (sums of sources).
  Runs as a background thread: `POST /api/split` → job id, `GET /api/jobs/{id}` → progress (counted from
  apply_model's callback). One split at a time (`_split_lock`). Model weights are in
  `%USERPROFILE%\.cache\huggingface\hub\models--adefossez--HTDemucs-6s`; when that folder exists
  `HF_HUB_OFFLINE=1` is set, so it never goes online again.
- **Fixed v1 bugs:** voiceover + background music, and music under video with "lower music when someone
  speaks", both failed on ffmpeg 4.2 ("No channel layout for input 1" in sidechaincompress). Both inputs now
  get an explicit `aformat=sample_fmts=dbl:sample_rates=44100:channel_layouts=stereo`.

## Known limits / gotchas
- The bundled ffmpeg is **4.2.2**: no `rubberband`, no `xfade`; `amix` has no `normalize` option, so it's compensated with `volume=2`.
- Long jobs run in a threadpool (`run_in_threadpool`). There's no progress bar, just a spinner.
- Elements use the `hidden` attribute; app.css has `[hidden]{display:none!important}`. Keep it.
- The microphone has never been tested with the owner's real mic and guitar.
- Kokoro is English only (Bengali TTS would need another free model).
- Stem quality was checked only with synthetic music + the Kokoro voice (the voice went to "Vocals", the kick
  stayed in "Karaoke"). Not yet tried on a real song; the guitar stem of htdemucs_6s is the weakest of the six.
- The tuner was tested with Chrome's fake mic (a 108.5 Hz tone read as "A, 24 cents low", which is correct), not his guitar yet.

## Added for acoustic-cover polishing (21 Nov 2026)
- The Effects tab now starts with one-click Natural, Intimate and Spacious presets specifically for a
  single phone recording containing singing and acoustic guitar. Natural is the recommended starting point.
- Reverb: a stereo impulse with band-limited diffusion, early reflections, adjustable pre-delay and
  brightness; silence is padded through the convolver so the final reverb tail isn't cut off.
  **Reverb gain (fixed after review):** `afir`'s `dry=` is its *input* gain, so `afir=dry=0` made every saved
  reverb silent. Before that, v1's default `gtype=peak` normalisation already made reverb ~55 dB too quiet
  (inaudible). Now: impulse scaled to unit energy per channel + `afir=gtype=none`, so wet ≈ dry level and
  "Reverb 14%" is a real 14% wet mix (click test: Intimate tail -31 dB, Natural -25, Spacious -20, no clipping).
  The browser preview impulse (`makePreviewImpulse`) uses the same unit-energy scaling so preview = saved
  file. Cached impulses are `tmp\ir-v3-*.wav` (v2 files were scaled the old way). Always measure the
  tail in the gaps after clicks when changing reverb code; listening to the preview alone is not enough.
- Review follow-ups: the reverb impulse has no 0 ms spike any more (only early reflections from 13 ms), so it
  never adds a delayed copy of the dry sound; cached impulses are `tmp\ir-v4-*.wav`. Hum notches are Q 30
  (hum still -56 to -87 dB; low G 98 Hz loses 2.3 dB instead of 10.4 with the old Q 8). "Clean up a phone
  recording" has hum removal again and no reverb. Preview compressor uses the server's make-up (1 + 0.6·c)
  and knee 2.83 dB; the preview still has no loudnorm, so saved files with a Loudness setting differ in level.
- Added a 280 Hz boxiness/mud control. Cover presets use gentle EQ/compression and -14 LUFS mastering.
- Noise reduction now tracks a conservative -50 dB steady noise floor rather than using the previous aggressive
  fixed -30 dB floor. Cover presets keep it off and never use a noise gate, protecting quiet guitar sustain.
- Effects can be applied directly to a phone video. The video stream is copied unchanged, the soundtrack is
  polished, and a new MP4 is registered as `effects_video`; temporary extracted/processed audio is removed.
- The Effects tab has a browser-side **Live preview** powered by the Web Audio API. EQ, hum filters,
  compression, reverb, echo, stereo width and character filters update while WaveSurfer is playing; changing
  a slider or preset rebuilds the preview graph without saving a file. Noise reduction, de-essing, pitch and
  final loudness remain render-only and the UI says so. Previewing never changes the original or registers a
  new workspace file.
- The Effects UI uses a sticky production command bar, so Natural/Intimate/Spacious, Live preview and Apply
  effects remain visible while the effect cards scroll. Secondary presets and reset sit in a compact options
  bar; the responsive layout changes from three cards to two and then one without burying the primary actions.

## How to test changes
1. Start the server in the background.
2. Make test media with the bundled ffmpeg (`aevalsrc` tones, `testsrc2` video, `testsrc` image).
3. Upload with `curl -F files=@...` to `/api/upload`.
4. Call `POST /api/do/<action>` with JSON. Actions: trim, cut, fade, volume, loop, join, export, extract, effects, best, video_music, beat_reel, voice, analyse.
5. Check the UI with headless Chrome.
6. Delete `workspace\` afterwards so the owner starts clean.
7. Commit locally only.

## Next: ideas the owner was offered (1, 3 and 5 are DONE in v2; next recommended: 2, 4, 9)
1. ~~Guitar tuner~~ (done)
2. Metronome / click track with count-in for recording
3. ~~Practice mode~~ (done)
4. Transpose a song to suit his voice (pitch shift; Analyse gives the key)
5. ~~Stem separation with Demucs~~ (done)
6. Multitrack: record guitar, then sing over it with playback, then mix
7. Punch-in re-recording of one line
8. Chord display while a song plays (estimate)
9. Live pitch meter for singing practice
10. Cover-video helper: sync a phone video of him playing with the studio recording → Reel

## UI refresh + drag trimmer (21 Nov 2026)
- Look: "home studio at night" (full design guide: `.interface-design/system.md`; read it before touching `static/`). Warm walnut surfaces with one amber accent; tokens are on `:root` in
  static/app.css (`--room/--desk/--rack/--inset`, `--wire*` hairlines, `--ink..--ink-4`, `--glow*`). Fonts are
  Segoe UI Variable (Windows 11) with Cascadia Mono/Consolas for time counters. No web fonts, so it stays offline.
  Depth = tonal surfaces + hairline borders (no drop shadows on cards).
- Trimmer: every file with sound gets a full-length region on `ready` (`resetFrame()`). Its two handles are the
  trim adjusters. They are styled through wavesurfer's shadow-DOM parts (`#wave ::part(region-handle-left)` etc.),
  and the region dims everything outside it with a huge box-shadow. The region body has `pointer-events:none`,
  so click-to-seek and drag-to-select still work on top of it. A frame that still covers the whole file means
  "nothing selected" (`isFull()` / `selected()`): Play plays everything, and Trim asks you to drag first.
  Counters update live on `region-update`. Nudge ±0.1 s, "At playhead", and keys `[` / `]` set start/end.
  The old From/To inputs are kept under "Type exact times" (opened automatically for videos without sound).
- `fmt()` now rounds before formatting (9.96 s used to show as "0:010.0").

## Vocal layers live preview (21 Nov 2026)
- Vocal layers has the same command bar as Effects: Hear original · Live preview · Render vocal mix. Arrangements load as soon
  they are picked (no Load button); editing a layer switches the dropdown to "Custom", and only then does picking
  another arrangement ask before replacing. A 404 from /api/layer_stem means the server is older than the page (restart it).
- How it works: `GET /api/layer_stem/{fid}?shift=` → `ops.layer_stem` makes one layer's mono, pitch-shifted voice
  with `_layer_chain()`, the **same** function the render uses (cached as `tmp\layer-<id>-<shift>.wav`, files older
  than a day are tidied). The browser (`LP` in app.js) decodes the stems and plays them with AudioBufferSourceNodes,
  locked to the muted wavesurfer media element (restart on play/seeked, re-sync if drift > 150 ms). Level (dB→gain),
  equal-power StereoPanner, DelayNode offset, mute and solo update live. A pitch change fetches a new stem.
- `_layer_chain()` pins `sample_fmts=flt` around asetrate/atempo. Without it, ffmpeg picked atempo's format from the
  output (mono s16 stem vs stereo mix) and the two splice differently. Verified: preview vs render agree to 16-bit
  rounding for 0, ±12, +3, +4, +7 and the full arrangements (doubles −41 dB because adelay rounds to whole ms).
  The render also lags 219 samples behind its input because of alimiter's 5 ms look-ahead (same for every layer,
  inaudible).
- The layers preview forces 100 % speed, and starting either preview (Effects or Layers) stops the other.
