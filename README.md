# Audio Studio

A private music, voice and video-sound workshop that runs only on this PC (http://127.0.0.1:8765).
Free tools only: Python, FastAPI, ffmpeg (imageio-ffmpeg), librosa, Kokoro voice (offline), Demucs (song splitting), Praat via praat-parselmouth (pitch correction), wavesurfer.js.

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
- **Tune (pitch correction / autotune):** for a recording of singing + guitar together, the voice is first
  separated from the guitar (Demucs), then each sung note is moved onto the nearest note of the key (Praat PSOLA,
  keeps the voice's character). The key is detected from the guitar; the voice is tuned to the guitar's *own*
  tuning. Natural (keeps vibrato) ↔ Robotic, strength, 7 scales incl. raag-like modes, live preview, pitch graph,
  "notes in tune" before → after. Saves the tuned song (MP4 for a video) and the tuned voice alone.
- **Vocal layers:** in-key harmonies made from the tuned voice (3rd/4th/5th/6th/octave above or below, humanised
  doubles) plus the separated guitar; arrangements (sweet third, sixth-below duet, pop stack, choir, gospel,
  ethereal octaves) load on selection; live preview = the exact files the render mixes.
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
- **Import & find chords:** paste a public Instagram, Facebook or YouTube video link. The app downloads only
  its audio into the private local library (much faster than fetching and converting the video), estimates the guitar chords on a beat-aligned timeline, and lets you
  click any chord to play from that moment. During playback, a live follow-along display shows the current chord,
  next chord and time remaining until the change. Chord controls can reduce names to basic major/minor shapes,
  transpose every chord, or find the easiest open-chord key with a capo recommendation. Results include an
  automatic original-vs-capo recommendation and confidence level. Optional accurate analysis uses Demucs to
  isolate the guitar from vocals before detecting chords (slower), then cross-checks the result against the full
  mix and reports agreement. Chords remain computer estimates; unusual
  voicings or a quiet guitar can affect them. The live tracker includes current/next chord diagrams; timeline
  chords can be corrected and those corrections persist in the browser. “Loop hardest change” selects the most
  demanding transition as an A–B practice loop. Detected sections, Roman-numeral and Nashville views, pentatonic
  scale guidance, and a printable/PDF chord sheet support learning and sharing.
- **Practice coach:** four-beat count-in, tempo-aware metronome, and optional microphone chord matching while the
  backing track plays. It saves recent per-song practice duration and chord accuracy in the browser. Use headphones
  to prevent the backing track from being mistaken for the guitar. Only download content you have permission to use.

## Safety
Listens on 127.0.0.1 only and refuses requests from other web pages (Host/Origin check).
ffmpeg is always run with an argument list, never a shell. Uploads up to 2 GB per file.

## Development credits
Audio Studio has been developed collaboratively with assistance from Codex and Claude.

## Code
`app/server.py` (web API), `app/ops.py` (all tools), `app/media.py` (library + ffmpeg runner),
`static/` (the page; wavesurfer is vendored in `static/vendor/`).
