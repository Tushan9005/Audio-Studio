"""Live Looper server helpers.

The browser owns real-time playback, quantisation and mixing. This module is the
replaceable AI-layer boundary: analyse a rendered loop and ask a provider for a
stem with an exact duration. ``LocalLayerProvider`` is deterministic and works
offline; a MusicGen/Stable Audio/Suno adapter can implement the same ``render``
method later without changing the API or mixer.
"""
import math
import re

import librosa
import numpy as np
import soundfile as sf

from .media import MediaError


SR = 44100
NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def _root(chord):
    match = re.match(r"^([A-G])([#b]?)", chord or "")
    if not match:
        return 0
    name = match.group(1) + match.group(2)
    name = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}.get(name, name)
    return NOTES.index(name)


def analyse_mix(path, requested_bpm=0, requested_key="", requested_chords=""):
    y, sr = librosa.load(path, sr=22050, mono=True, duration=360)
    if not len(y):
        raise MediaError("The loop mix is silent.")
    # STFT chroma is deliberately used here: short live loops need a quick
    # interactive response, while CQT's extra resolution is valuable in the
    # app's slower full-song chord analysis.
    harmonic = librosa.effects.harmonic(y)
    chroma = librosa.feature.chroma_stft(y=harmonic, sr=sr, hop_length=512, n_fft=2048)
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr, hop_length=512)
    detected_bpm = float(np.atleast_1d(tempo)[0]) if np.size(tempo) else 0
    bpm = float(requested_bpm or detected_bpm or 90)
    if not math.isfinite(bpm) or bpm < 30 or bpm > 240:
        bpm = detected_bpm if math.isfinite(detected_bpm) and 30 <= detected_bpm <= 240 else 90
    mean = chroma.mean(axis=1)
    best = (-2, "C major")
    for root in range(12):
        for profile, mode in ((MAJOR, "major"), (MINOR, "minor")):
            score = float(np.corrcoef(np.roll(profile, root), mean)[0, 1])
            if score > best[0]: best = (score, "%s %s" % (NOTES[root], mode))
    key = requested_key.strip() or best[1]
    supplied = [part.strip() for part in re.split(r"[,|\s]+", requested_chords or "") if re.match(r"^[A-G]", part.strip())]
    if supplied:
        chords = supplied[:16]
    else:
        # One stable major/minor template per quarter of the loop. This is a
        # provider hint, not a replacement for the app's detailed chord report.
        chords = []
        frames = chroma.shape[1]
        templates = []
        labels = []
        for root in range(12):
            for suffix, tones in (("", (0, 4, 7)), ("m", (0, 3, 7))):
                template = np.full(12, .04)
                template[[(root + tone) % 12 for tone in tones]] = (1, .82, .68)
                templates.append(template / np.linalg.norm(template)); labels.append(NOTES[root] + suffix)
        templates = np.asarray(templates)
        for part in range(4):
            a, b = round(frames * part / 4), max(round(frames * (part + 1) / 4), 1)
            vector = np.median(chroma[:, a:b], axis=1); vector /= np.linalg.norm(vector) + 1e-9
            chord = labels[int(np.argmax(templates @ vector))]
            if not chords or chords[-1] != chord: chords.append(chord)
    return {"bpm": round(max(30, min(240, bpm)), 2), "key": key, "chords": chords or [key.split()[0]],
            "duration": round(len(y) / sr, 4)}


class LocalLayerProvider:
    """Offline reference provider that proves the exact-duration stem contract."""
    name = "local-placeholder"

    def render(self, output, prompt, duration, analysis):
        duration = max(.25, min(180, float(duration)))
        total = int(round(duration * SR)); audio = np.zeros((total, 2), dtype=np.float32)
        bpm = analysis["bpm"]; beat = 60.0 / bpm; text = (prompt or "").lower()
        chords = analysis.get("chords") or [analysis["key"].split()[0]]
        rng = np.random.default_rng(abs(hash((prompt, round(duration, 3), round(bpm, 2)))) % (2 ** 32))

        def add_tone(start, length, hz, gain=.18, pan=0, decay=3.0):
            a = max(0, int(start * SR)); n = min(total - a, max(0, int(length * SR)))
            if n <= 0: return
            t = np.arange(n) / SR; env = np.minimum(1, t / .008) * np.exp(-decay * t / max(.05, length))
            wave = np.sin(2 * np.pi * hz * t) * env * gain
            audio[a:a+n, 0] += wave * math.sqrt((1 - pan) / 2); audio[a:a+n, 1] += wave * math.sqrt((1 + pan) / 2)

        if any(word in text for word in ("drum", "beat", "kick", "percussion", "lo-fi", "lofi")):
            step = beat / 2
            for index, start in enumerate(np.arange(0, duration, step)):
                if index % 2 == 0:
                    a = int(start * SR); n = min(total-a, int(.18*SR)); t = np.arange(max(0, n))/SR
                    phase = 2*np.pi*(75*t - 32*t*t); kick = np.sin(phase)*np.exp(-24*t)*.65
                    audio[a:a+n] += kick[:, None]
                noise = rng.normal(0, 1, min(total-int(start*SR), int(.045*SR))).astype(np.float32)
                if len(noise): audio[int(start*SR):int(start*SR)+len(noise)] += (noise*np.exp(-55*np.arange(len(noise))/SR)*.055)[:, None]
                if index % 4 == 2:
                    a = int(start*SR); n = min(total-a, int(.12*SR)); noise = rng.normal(0, 1, max(0, n)).astype(np.float32)
                    audio[a:a+n] += (noise*np.exp(-18*np.arange(max(0,n))/SR)*.16)[:, None]
        elif any(word in text for word in ("bass", "funk", "groove")):
            step = beat / (2 if "funk" in text else 1)
            for index, start in enumerate(np.arange(0, duration, step)):
                chord = chords[int(start / duration * len(chords)) % len(chords)]
                midi = 36 + _root(chord); hz = 440 * 2 ** ((midi - 69) / 12)
                add_tone(start, step * .82, hz, .34 if index % 2 == 0 else .23, -.08, 4.6)
        else:
            chord_span = duration / max(1, len(chords))
            for index, chord in enumerate(chords):
                root = _root(chord); minor = "m" in chord and "maj" not in chord
                for voice, semitones in enumerate((0, 3 if minor else 4, 7)):
                    midi = 48 + root + semitones; hz = 440 * 2 ** ((midi - 69) / 12)
                    add_tone(index * chord_span, chord_span, hz, .095, (voice - 1) * .45, .7)
        peak = float(np.max(np.abs(audio)))
        if peak > .92: audio *= .92 / peak
        sf.write(output, audio, SR, subtype="PCM_16")


PROVIDER = LocalLayerProvider()


def generate_layer(input_path, output_path, prompt, duration, bpm=0, key="", chords=""):
    prompt = str(prompt or "add an instrument")[:240]
    analysis = analyse_mix(input_path, bpm, str(key or "")[:80], str(chords or "")[:500])
    analysis["duration"] = round(float(duration), 4)
    PROVIDER.render(output_path, prompt, duration, analysis)
    return analysis, PROVIDER.name
