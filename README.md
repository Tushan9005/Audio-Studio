# Audio Studio

A private music, voice and video-sound workshop that runs only on this PC (http://127.0.0.1:8765).
Free tools only: Python, FastAPI, ffmpeg (imageio-ffmpeg), librosa, Kokoro voice (offline), Demucs (song splitting), wavesurfer.js.

**Start:** double-click `Start Audio Studio.bat`. Close the black window to stop.

## What it does
- **Library:** add sound, video and photo files (button or drag & drop) or **record** from the mic
  (the browser's voice processing is switched off, so guitar and singing are captured as they are).
  Every tool makes a new copy; originals are never changed. Files live in `workspace/`.
- **Edit:** select on the waveform → keep / remove the part; fades; volume; loop; join ticked files
  with crossfade; save as MP3 / M4A / OGG / FLAC / WAV / MP4; take the sound out of a video.
- **Tuner** (button at the top right): guitar tuner using the mic, all in the browser. Standard, Drop D,
  E♭, D, DADGAD and Open G tunings; A = 440 can be changed.
- **Practice:** slow a song down to 50–75% (the pitch stays the same) live while playing along; A–B loop
  (drag on the waveform or "Set A / Set B here") with an optional pause before each repeat;
  "Save a practice copy" makes a slowed file (only the A–B part, if selected) for the phone.
  **Split song:** vocals only, guitar only, karaoke (no vocals), backing without guitar, drums, bass
  (Demucs htdemucs_6s on the CPU, roughly half the song's length; model cached in
  `%USERPROFILE%\.cache\huggingface`, loaded offline after the first download).
- **Effects:** gentle tracked-noise reduction (no noise gate, so guitar decay is preserved), 50 Hz hum
  removal, low cut, de-esser, tone/boxiness EQ, compression,
  natural stereo convolution reverb with pre-delay, brightness and room size, echo, stereo width,
  pitch shift (keeps speed), speed (keeps pitch),
  lo-fi, old radio, pause removal, loudness for Instagram/YouTube (-14 LUFS). Presets: vocal polish,
  warm acoustic guitar, phone-recording clean-up, lo-fi, radio, bass boost, big hall, plus one-click
  Natural / Intimate / Spacious processing for a phone-recorded singing-and-acoustic-guitar cover.
  **Live preview** routes playback through matching browser EQ, compression, echo, stereo-width and
  convolution-reverb controls, updating while the song plays without creating files. Denoising, de-essing,
  pitch shifting and final loudness are applied only by the final high-quality render.
  The cover processing works directly on phone video too: the picture is copied unchanged and the
  polished soundtrack is placed back into a new MP4.
- **Video:** music under a video (keeps or ducks the video's own voice), beat reel (cuts ticked
  clips/photos on the beat into 9:16 / 4:5 / 1:1 / 16:9), best 15/30/60 s of a song.
- **Voice:** English voiceover with the free Kokoro voice (model files read from `C:\Users\asus\npf-voice`,
  change with the STUDIO_KOKORO_DIR environment variable), optionally mixed with ducked music.
- **Analyse:** tempo (BPM), key estimate, loudness (LUFS) and peak.

## Safety
Listens on 127.0.0.1 only and refuses requests from other web pages (Host/Origin check).
ffmpeg is always run with an argument list, never a shell. Uploads up to 2 GB per file.

## Code
`app/server.py` (web API), `app/ops.py` (all tools), `app/media.py` (library + ffmpeg runner),
`static/` (the page; wavesurfer is vendored in `static/vendor/`).
