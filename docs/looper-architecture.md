# Live Looper architecture

## Timing model

The first recording can define the cycle, or the user can lock it from BPM × beats-per-bar × bars. Sessions are capped at three minutes to keep eight uncompressed stereo tracks within a safe browser memory envelope. Once the first layer exists, that duration is immutable until **New session**. Every decoded recording is copied into a new `AudioBuffer` with exactly `round(loopSeconds × sampleRate)` samples. Positive microphone calibration offsets read later input samples, moving late input earlier; negative offsets insert silence and move it later.

Playback uses one `AudioBufferSourceNode` per layer. Every source starts against the same `AudioContext` clock and uses the same `loopEnd`. A new overdub is armed for the next calculated cycle boundary. Adding a layer during playback starts it at the current master-cycle offset, rather than starting from zero.

## Browser audio graph

```text
track AudioBufferSource → Gain (mute/solo/level) → StereoPanner → master Gain → speakers
```

There are at most eight tracks. Sources are recreated when transport starts; mixer nodes remain live so mute, solo, volume, and pan changes do not restart playback. A shared animation frame reads the master-clock phase and moves every waveform playhead.

MediaRecorder captures an unprocessed microphone stream with echo cancellation, noise suppression, and automatic gain disabled. Existing tracks continue through the Web Audio graph during overdubs. Headphones are recommended because input monitoring is intentionally disabled to prevent feedback.

## Take comping

Comp mode schedules the chosen From/To range on each loop cycle. Each pass becomes a separate full-cycle buffer with silence outside its selected range. Adding multiple takes to the mixer combines their chosen regions non-destructively; the original takes stay available until removed.

## Rendering and export

An `OfflineAudioContext` renders one exact cycle. Master rendering honors mute, solo, level, and pan. Stem rendering honors the selected track's level and pan. WAV is encoded as 44.1/48 kHz (the active context rate), stereo, 16-bit PCM in the browser. MP3 sends that WAV to `/api/looper/encode/mp3`, which uses the bundled FFmpeg at 256 kbps. The native Save As picker opens before rendering so Chrome retains the required user gesture.

## AI provider boundary

`POST /api/looper/ai-stem` accepts:

- the current master mix as WAV;
- prompt;
- exact duration;
- authoritative master BPM;
- optional key and chord hints.

The response returns a registered WAV stem, detected BPM/key/chords, and provider name. `app/looper.py` defines the provider boundary. `LocalLayerProvider` is an offline deterministic reference implementation for drum, bass, and pad layers. A MusicGen, Stable Audio, or Suno adapter replaces `PROVIDER` and implements:

```text
render(output_path, prompt, exact_duration, analysis)
```

Regardless of provider output, the browser fits the decoded result to the exact master sample count before it enters the mixer.
