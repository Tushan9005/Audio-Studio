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
| `C:\Users\asus\audio-studio\` | The project (its own git repo, local only, 2 commits so far) |
| `app\server.py` | FastAPI web API. Listens on 127.0.0.1:8765 only; a middleware refuses other Host/Origin headers |
| `app\ops.py` | All the tools: edit, effects, analyse, best part, video, beat reel, voice |
| `app\media.py` | Library (`workspace\index.json`) and a safe ffmpeg runner (argument lists, never a shell) |
| `static\index.html`, `app.js`, `app.css` | The single-page UI (dark theme). No build step |
| `static\vendor\` | wavesurfer.js 7.8.6 + regions plugin, downloaded so it works offline |
| `.venv\` | Python 3.12 virtual env (fastapi, uvicorn, python-multipart, imageio-ffmpeg 0.5.1, numpy, soundfile, librosa, kokoro-onnx). See `requirements.txt` |
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

## Known limits / gotchas
- The bundled ffmpeg is **4.2.2**: no `rubberband`, no `xfade`; `amix` has no `normalize` option, so it's compensated with `volume=2`.
- Long jobs run in a threadpool (`run_in_threadpool`). There's no progress bar, just a spinner.
- Elements use the `hidden` attribute; app.css has `[hidden]{display:none!important}`. Keep it.
- The microphone has never been tested with the owner's real mic and guitar.
- Kokoro is English only (Bengali TTS would need another free model).

## How to test changes
1. Start the server in the background.
2. Make test media with the bundled ffmpeg (`aevalsrc` tones, `testsrc2` video, `testsrc` image).
3. Upload with `curl -F files=@...` to `/api/upload`.
4. Call `POST /api/do/<action>` with JSON. Actions: trim, cut, fade, volume, loop, join, export, extract, effects, best, video_music, beat_reel, voice, analyse.
5. Check the UI with headless Chrome.
6. Delete `workspace\` afterwards so the owner starts clean.
7. Commit locally only.

## Next: ideas the owner was offered (he hasn't chosen yet; recommended first: 1, 3, 5)
1. Guitar tuner (Web Audio pitch detection, all in the browser)
2. Metronome / click track with count-in for recording
3. Practice mode: slow down 50–75% keeping pitch, A–B loop
4. Transpose a song to suit his voice (pitch shift; Analyse gives the key)
5. Stem separation with Demucs (free, CPU, a few minutes per song): karaoke / no-guitar backing tracks
6. Multitrack: record guitar, then sing over it with playback, then mix
7. Punch-in re-recording of one line
8. Chord display while a song plays (estimate)
9. Live pitch meter for singing practice
10. Cover-video helper: sync a phone video of him playing with the studio recording → Reel
