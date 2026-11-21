# Audio Studio

A private music, voice and video-sound workshop that runs only on this PC (http://127.0.0.1:8765).
Free tools only: Python, FastAPI, ffmpeg (imageio-ffmpeg), librosa, Kokoro voice (offline), wavesurfer.js.

**Start:** double-click `Start Audio Studio.bat`. Close the black window to stop.

## What it does
- **Library:** add sound, video and photo files (button or drag & drop) or **record** from the mic
  (the browser's voice processing is switched off, so guitar and singing are captured as they are).
  Every tool makes a new copy; originals are never changed. Files live in `workspace/`.
- **Edit:** select on the waveform → keep / remove the part; fades; volume; loop; join ticked files
  with crossfade; save as MP3 / M4A / OGG / FLAC / WAV / MP4; take the sound out of a video.
- **Effects:** noise reduction, 50 Hz hum removal, low cut, de-esser, 4-band EQ, compression,
  convolution reverb with room size, echo, stereo width, pitch shift (keeps speed), speed (keeps pitch),
  lo-fi, old radio, pause removal, loudness for Instagram/YouTube (-14 LUFS). Presets: vocal polish,
  warm acoustic guitar, phone-recording clean-up, lo-fi, radio, bass boost, big hall.
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
