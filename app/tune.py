"""Pitch correction ("autotune") and key-aware harmonies, all on this PC with free tools.

How it works
1. prepare(): if the recording is singing + guitar together, Demucs separates the voice from the rest.
   Praat measures the sung pitch every 10 ms, librosa measures the guitar's tuning (a guitar tuned 20 cents
   flat must not be "corrected" against A = 440), and the key is estimated from the guitar's chords plus the
   sung notes. Everything is cached in workspace/tmp/tune/<file id>/.
2. curves(): for each moment it finds the note you were aiming for (the pitch averaged over ~0.18 s, so
   vibrato doesn't confuse it), snaps that to the nearest note of the key (with hysteresis, so it doesn't
   flicker between two notes), and moves the voice there. Strength = how far; Style = Natural (keeps your
   vibrato and glides gently) ... Robotic (instant snap, flat notes).
3. Praat's PSOLA re-synthesis changes only the pitch: the voice keeps its own timbre (no chipmunk effect).
4. Harmonies are worked out note by note in the key (a "third above" is 3 or 4 semitones depending on the
   note), built from the fully corrected voice, each with its own slight human drift.

The preview in the browser plays exactly the files made here, so preview = saved result.
"""
import hashlib, json, math, os, threading, time

import numpy as np
import soundfile as sf

from . import ops
from .media import TMP, MediaError, get, path_of, run

SR = ops.SR
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
SCALES = {
    "major": ("Major", [0, 2, 4, 5, 7, 9, 11]),
    "minor": ("Minor", [0, 2, 3, 5, 7, 8, 10]),
    "harmonic_minor": ("Harmonic minor", [0, 2, 3, 5, 7, 8, 11]),
    "dorian": ("Dorian (like raag Kafi)", [0, 2, 3, 5, 7, 9, 10]),
    "mixolydian": ("Mixolydian (like raag Khamaj)", [0, 2, 4, 5, 7, 9, 10]),
    "phrygian": ("Phrygian (like raag Bhairavi)", [0, 1, 3, 5, 7, 8, 10]),
    "chromatic": ("All 12 notes (nearest semitone)", list(range(12))),
}
# harmony voices: (label, scale steps, octaves). Steps are counted in the key, so they stay in tune.
VOICES = {
    "tuned": ("Your voice, tuned", 0, 0),
    "double": ("Double (tuned, humanised)", 0, 0),
    "h3up": ("3rd above", 2, 0), "h4up": ("4th above", 3, 0), "h5up": ("5th above", 4, 0), "h6up": ("6th above", 5, 0),
    "h8up": ("Octave above", 0, 1),
    "h3dn": ("3rd below", -2, 0), "h4dn": ("4th below", -3, 0), "h5dn": ("5th below", -4, 0), "h6dn": ("6th below", -5, 0),
    "h8dn": ("Octave below", 0, -1),
}
_KS_MAJ = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_KS_MIN = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
_locks, _locks_guard = {}, threading.Lock()
_manips = {}        # file id -> Praat Manipulation of the vocal (kept in memory: re-synthesis is then ~0.1 s)


def _lock(fid):
    with _locks_guard:
        return _locks.setdefault(fid, threading.Lock())


def _dir(fid):
    d = os.path.join(TMP, "tune", fid)
    os.makedirs(d, exist_ok=True)
    return d


def info(fid):
    try:
        with open(os.path.join(_dir(fid), "info.json"), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


# ── 1. analysis ──
def prepare(fid, together, progress=lambda p: None, stage=lambda s: None):
    """Separates (if needed) and analyses a recording. Cached; returns the analysis summary."""
    it = ops.need(get(fid), "audio", "video")
    if not it["has_audio"]:
        raise MediaError("This video has no sound.")
    together = bool(together)
    with _lock(fid):
        old = info(fid)
        if old and old.get("together") == together and old.get("version") == 3:
            return old
        d = _dir(fid)
        for f in os.listdir(d):
            os.remove(os.path.join(d, f))
        _manips.pop(fid, None)
        if together:
            src, sr = ops.separate(it, lambda p: progress(p * 0.85), stage)
            voc = src["vocals"].mean(axis=1)
            back = sum(v for k, v in src.items() if k != "vocals")
            sf.write(os.path.join(d, "vocals.wav"), voc.astype(np.float32), sr)
            sf.write(os.path.join(d, "backing.wav"), back.astype(np.float32), sr)
        else:
            progress(0.1)
            run(["-i", path_of(it), "-vn", "-ar", str(SR), "-ac", "1", "-c:a", "pcm_f32le", os.path.join(d, "vocals.wav")])
        progress(0.88)
        t, f0 = _contour(fid)
        tuning = _tuning(d, t, f0)
        keys = _keys(d, f0, tuning)
        res = {"version": 3, "together": together, "duration": round(len(t) and float(t[-1]) or 0, 2),
               "tuning_cents": round(tuning * 100, 1), "guitar_a": round(440 * 2 ** (tuning / 12), 1),
               "keys": keys, "sung_seconds": round(len(f0) * 0.01, 1)}
        with open(os.path.join(d, "info.json"), "w", encoding="utf-8") as fh:
            json.dump(res, fh)
        progress(1.0)
        return res


def _manip(fid):
    import parselmouth
    from parselmouth.praat import call
    m = _manips.get(fid)
    if m is None:
        snd = parselmouth.Sound(os.path.join(_dir(fid), "vocals.wav"))
        m = call(snd, "To Manipulation", 0.01, 70, 1000)
        _manips[fid] = m
        while len(_manips) > 3:
            _manips.pop(next(iter(_manips)))
    return m


def _contour(fid):
    """Pitch points (time s, Hz) of the vocal, from the same Praat analysis PSOLA uses (cached)."""
    from parselmouth.praat import call
    p = os.path.join(_dir(fid), "contour.npy")
    if os.path.isfile(p):
        a = np.load(p)
        return a[0], a[1]
    tier = call(_manip(fid), "Extract pitch tier")
    n = int(call(tier, "Get number of points"))
    t = np.array([call(tier, "Get time from index", i + 1) for i in range(n)])
    f = np.array([call(tier, "Get value at index", i + 1) for i in range(n)])
    np.save(p, np.vstack([t, f]))
    return t, f


def _tuning(d, t, f0):
    """Reference tuning in semitones relative to A = 440: from the guitar if there is one, else 0."""
    back = os.path.join(d, "backing.wav")
    if not os.path.isfile(back):
        return 0.0
    import librosa
    y, sr = sf.read(back, dtype="float32", always_2d=True)
    y = librosa.resample(y.mean(axis=1), orig_sr=sr, target_sr=22050)
    return float(librosa.estimate_tuning(y=y, sr=22050, bins_per_octave=60))


def _keys(d, f0, tuning):
    """Top 3 key guesses. With a guitar, its chords decide: the sung notes are the thing being corrected, so
    letting them vote would let off-pitch singing pick the wrong key. Voice only: the sung notes decide."""
    hist = np.zeros(12)
    v = f0[f0 > 0]
    if len(v):
        m = np.round(69 + 12 * np.log2(v / 440) - tuning).astype(int)
        hist = np.bincount(m % 12, minlength=12).astype(float)
    vectors = [hist / (hist.sum() + 1e-9)]
    back = os.path.join(d, "backing.wav")
    if os.path.isfile(back):
        import librosa
        y, sr = sf.read(back, dtype="float32", always_2d=True)
        y = librosa.resample(y.mean(axis=1), orig_sr=sr, target_sr=22050)
        c = librosa.feature.chroma_cqt(y=y, sr=22050, tuning=tuning).mean(axis=1)
        vectors = [c / (c.sum() + 1e-9)]
    scores = []
    for k in range(12):
        for prof, sc in ((_KS_MAJ, "major"), (_KS_MIN, "minor")):
            r = sum(np.corrcoef(np.roll(prof, k), vec)[0, 1] for vec in vectors if vec.any()) / len(vectors)
            scores.append((float(r), NAMES[k], sc))
    scores.sort(reverse=True)
    return [{"key": k, "scale": sc, "label": "%s %s" % (k.replace("#", "♯"), sc), "score": round(r, 3)} for r, k, sc in scores[:3]]


# ── 2. correction curves ──
def _params(p):
    key = p.get("key") if p.get("key") in NAMES else "C"
    scale = p.get("scale") if p.get("scale") in SCALES else "major"
    return {"key": key, "scale": scale, "strength": ops.num(p.get("strength"), 0, 100, 100) / 100.0,
            "style": ops.num(p.get("style"), 0, 100, 25) / 100.0, "ref": ops.num(p.get("ref"), -60, 60, 0) / 100.0}


def _scale_notes(key, scale):
    root = NAMES.index(key)
    pcs = sorted((root + s) % 12 for s in SCALES[scale][1])
    return np.array([o * 12 + pc for o in range(0, 11) for pc in pcs], dtype=float)


def _runs(t):
    """Index ranges of continuous voiced stretches (a gap over 50 ms starts a new phrase)."""
    if not len(t):
        return []
    cut = np.where(np.diff(t) > 0.05)[0] + 1
    edges = [0] + list(cut) + [len(t)]
    return [(a, b) for a, b in zip(edges, edges[1:]) if b > a]


def _smooth(x, n):
    if len(x) < 3 or n < 2:
        return x.copy()
    n = min(n, len(x))
    pad = np.pad(x, (n // 2, n - 1 - n // 2), mode="edge")
    return np.convolve(pad, np.ones(n) / n, mode="valid")


def _onepole(x, t, tau):
    if tau <= 0.002 or len(x) < 2:
        return x.copy()
    y = np.empty_like(x)
    y[0] = x[0]
    for i in range(1, len(x)):
        a = 1 - math.exp(-(t[i] - t[i - 1]) / tau)
        y[i] = y[i - 1] + a * (x[i] - y[i - 1])
    return y


def _median(x, n):
    if len(x) < 3 or n < 2:
        return x.copy()
    h = n // 2
    pad = np.pad(x, (h, h), mode="edge")
    return np.array([np.median(pad[i:i + n]) for i in range(len(x))])


def _segments(t, sung, notes):
    """Splits the singing into notes: [(start, end, target note, sung centre)] as index ranges.
    A new note starts when the (lightly smoothed) pitch settles nearer another scale note; notes shorter
    than 60 ms are merged into a neighbour; each note's centre is the median of its middle part, so a scoop
    into the note or a fall at its end doesn't pull the centre."""
    out = []
    for a, b in _runs(t):
        sm = _median(sung[a:b], 7)
        lab, prev = np.empty(len(sm)), None
        for i, c in enumerate(sm):
            cand = notes[np.argmin(np.abs(notes - c))]
            if prev is not None and cand != prev and abs(c - prev) < 0.65:   # hysteresis: vibrato isn't a new note
                cand = prev
            lab[i] = prev = cand
        segs, i = [], 0
        while i < len(lab):
            j = i
            while j < len(lab) and lab[j] == lab[i]:
                j += 1
            segs.append([i, j])
            i = j
        k = 0
        while len(segs) > 1 and k < len(segs):              # merge blips into the closer neighbour
            i, j = segs[k]
            if t[a + j - 1] - t[a + i] >= 0.06:
                k += 1
                continue
            mid = np.median(sung[a + i:a + j])
            left = np.median(sung[a + segs[k - 1][0]:a + segs[k - 1][1]]) if k > 0 else None
            right = np.median(sung[a + segs[k + 1][0]:a + segs[k + 1][1]]) if k + 1 < len(segs) else None
            if right is None or (left is not None and abs(mid - left) <= abs(mid - right)):
                segs[k - 1][1] = j
            else:
                segs[k + 1][0] = i
            segs.pop(k)
        for i, j in segs:
            core = sung[a + i + (j - i) // 5:a + j - (j - i) // 5] if j - i >= 5 else sung[a + i:a + j]
            centre = float(np.median(core))
            out.append((a + i, a + j, float(notes[np.argmin(np.abs(notes - centre))]), centre))
    return out


def _ramp(x, t, seconds):
    """Centred moving average along each phrase: note-to-note changes become smooth, symmetric glides."""
    n = int(round(seconds / 0.01))
    if n < 2:
        return x.copy()
    y = x.copy()
    for a, b in _runs(t):
        y[a:b] = _smooth(x[a:b], n)
    return y


def curves(fid, p):
    """The sung pitch, the target note and the corrected pitch (MIDI numbers relative to the reference tuning)
    at every pitch point. Unvoiced moments are simply not points: PSOLA leaves them untouched.
    Natural: every note is moved as a whole onto its target, so vibrato, scoops and slides stay yours.
    Robotic: the pitch is pulled onto flat target notes with instant changes."""
    q = _params(p)
    t, f0 = _contour(fid)
    sung = 69 + 12 * np.log2(np.maximum(f0, 1) / 440) - q["ref"]
    notes = _scale_notes(q["key"], q["scale"])
    target = sung.copy()
    offset = np.zeros_like(sung)
    for i, j, tg, centre in _segments(t, sung, notes):
        target[i:j] = tg
        offset[i:j] = tg - centre
    st, k = q["style"], q["strength"]
    glide = 0.06 * (1 - st) + 0.01 * st                       # 60 ms glides (natural) ... 10 ms (robotic)
    natural = sung + k * _ramp(offset, t, glide)
    robotic = sung + k * (_ramp(target, t, glide) - sung)
    fixed = (1 - st) * natural + st * robotic
    return t, sung, target, fixed, q


def _in_tune(t, x, target, segs, cents=15):
    """Share of sung time whose note (median of the note's middle part) is within `cents` of its target."""
    ok = tot = 0.0
    for i, j, tg, _ in segs:
        core = x[i + (j - i) // 5:j - (j - i) // 5] if j - i >= 5 else x[i:j]
        dur = t[j - 1] - t[i] + 0.01
        tot += dur
        ok += dur if abs(np.median(core) - tg) * 100 <= cents else 0
    return round(ok / tot * 100) if tot else 0


def summary(fid, p):
    """Graph data (every 2nd point) and how much of the singing is in tune before / after."""
    t, sung, target, fixed, q = curves(fid, p)
    segs = _segments(t, sung, _scale_notes(q["key"], q["scale"]))
    k = slice(None, None, 2)
    return {"t": np.round(t[k], 3).tolist(), "sung": np.round(sung[k], 2).tolist(), "fixed": np.round(fixed[k], 2).tolist(),
            "target": target[k].tolist(), "before": _in_tune(t, sung, target, segs), "after": _in_tune(t, fixed, target, segs),
            "notes": [int(n) for n in _scale_notes(q["key"], q["scale"])], "ref": q["ref"]}


# ── 3. re-synthesis ──
def _resynth(fid, t, midi_abs, out):
    """PSOLA with a new pitch curve (absolute MIDI numbers at the contour's times)."""
    import parselmouth
    from parselmouth.praat import call
    m = _manip(fid)
    end = sf.info(os.path.join(_dir(fid), "vocals.wav")).duration
    tier = call("Create PitchTier", "new", 0, end)
    hz = 440 * 2 ** ((midi_abs - 69) / 12)
    for ti, h in zip(t, hz):
        call(tier, "Add point", float(ti), float(h))
    call([m, tier], "Replace pitch tier")
    snd = call(m, "Get resynthesis (overlap-add)")
    y = snd.values[0].astype(np.float32)
    sf.write(out, y, int(snd.sampling_frequency), subtype="PCM_16")


def _humanise(t, seed, cents):
    rng = np.random.default_rng(seed)
    drift = sum(rng.uniform(.5, 1) * np.sin(2 * np.pi * rng.uniform(.07, .45) * t + rng.uniform(0, 6.3)) for _ in range(3)) / 2.2
    return drift * cents / 100.0


def _prune(d, keep=24):
    files = sorted((os.path.getmtime(os.path.join(d, f)), f) for f in os.listdir(d) if f.startswith("r-"))
    for _, f in files[:-keep]:
        try: os.remove(os.path.join(d, f))
        except OSError: pass


def voice(fid, p, kind="tuned", seed=0):
    """A mono 44.1 kHz WAV of one voice: the tuned lead, a humanised double, or an in-key harmony."""
    if kind not in VOICES:
        raise MediaError("Unknown voice.")
    if not info(fid):
        raise MediaError("Analyse the singing first (Tune tab).")
    q = _params(p)
    seed = int(ops.num(seed, 0, 9999, 0))
    d = _dir(fid)
    tag = hashlib.sha1(json.dumps([q, kind, seed if kind != "tuned" else 0]).encode()).hexdigest()[:16]
    out = os.path.join(d, "r-%s.wav" % tag)
    if os.path.isfile(out):
        os.utime(out)
        return out
    with _lock(fid):
        t, sung, target, fixed, q = curves(fid, p)
        if kind == "tuned":
            pitch = fixed
        else:
            # harmonies always start from the fully corrected voice, in the chosen style
            _, _, target, full, _ = curves(fid, dict(p, strength=100))
            steps, octs = VOICES[kind][1], VOICES[kind][2]
            notes = _scale_notes(q["key"], q["scale"])
            idx = np.searchsorted(notes, target)
            harm = notes[np.clip(idx + steps, 0, len(notes) - 1)] + 12 * octs
            interval = np.empty_like(harm)
            for a, b in _runs(t):                       # glide 25 ms between harmony notes: no clicks
                interval[a:b] = _onepole(harm[a:b] - target[a:b], t[a:b], 0.025)
            pitch = full + interval + _humanise(t, seed * 131 + (steps + 20) * 7 + (octs + 3) * 53, 6 if kind == "double" else 4)
        part = out + ".part.wav"
        _resynth(fid, t, pitch + q["ref"], part)
        os.replace(part, out)
        _prune(d)
    return out


def raw_vocal(fid):
    return os.path.join(_dir(fid), "vocals.wav") if info(fid) else None


def backing(fid):
    b = os.path.join(_dir(fid), "backing.wav")
    return b if info(fid) and os.path.isfile(b) else None


def mix(fid, p):
    """Tuned voice + the guitar/backing (stereo WAV); just the tuned voice if there is no backing."""
    v = voice(fid, p, "tuned")
    b = backing(fid)
    d = _dir(fid)
    out = os.path.join(d, "r-mix-%s.wav" % os.path.basename(v)[2:-4])
    if os.path.isfile(out):
        os.utime(out)
        return out
    y, sr = sf.read(v, dtype="float32")
    st = np.stack([y, y], axis=1)
    if b:
        g, gsr = sf.read(b, dtype="float32", always_2d=True)
        if gsr != sr:
            raise MediaError("Unexpected sample rate in the backing track.")
        n = max(len(st), len(g))
        st = np.pad(st, ((0, n - len(st)), (0, 0))) + np.pad(g, ((0, n - len(g)), (0, 0)))
    peak = float(np.abs(st).max()) if st.size else 0
    if peak > 0.99:
        st *= 0.99 / peak
    part = out + ".part.wav"
    sf.write(part, st, sr, subtype="PCM_16")
    os.replace(part, out)
    return out


# ── 4. saving ──
def save(fid, p):
    """Adds the tuned result to the library: the tuned song (MP4 for a video) and the tuned voice alone."""
    from .media import new_path, register
    it = ops.need(get(fid), "audio", "video")
    inf = info(fid)
    if not inf:
        raise MediaError("Analyse the singing first.")
    q = _params(p)
    label = "tuned %s %s" % (q["key"], SCALES[q["scale"]][0].split(" (")[0].lower())
    out = []
    m = mix(fid, p)
    if it["kind"] == "video":
        nid, dst = new_path("mp4")
        run(["-i", path_of(it), "-i", m, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
             "-shortest", "-movflags", "+faststart", dst])
        out.append(register(nid, "mp4", ops._name(it, label), "tune", it["id"]))
    else:
        nid, dst = new_path("wav")
        run(["-i", m] + ops.WAV + [dst])
        out.append(register(nid, "wav", ops._name(it, label), "tune", it["id"]))
    if inf.get("together"):
        nid, dst = new_path("wav")
        run(["-i", voice(fid, p, "tuned")] + ops.WAV + [dst])
        out.append(register(nid, "wav", ops._name(it, "vocal only, " + label), "tune", it["id"]))
    return out
