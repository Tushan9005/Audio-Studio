"""Everything the studio can do. Each function takes plain values from the page (already checked
with num()/pick()), runs ffmpeg or Python, registers the result in the library and returns it.

Audio results are saved as WAV (lossless) while you work; "Export" makes MP3 / M4A / OGG / FLAC.
Video results are MP4 (H.264 + AAC), which Instagram, Facebook, WhatsApp and YouTube all accept.
"""
import math, os, secrets, threading

import numpy as np
import soundfile as sf

from .media import FILES, TMP, MediaError, delete, get, new_path, path_of, register, run

SR = 44100
WAV = ["-ar", str(SR), "-ac", "2", "-c:a", "pcm_s16le"]
_WHISPER_MODELS = {}
_WHISPER_LOCK = threading.Lock()


# ── checks for values coming from the page ──
def num(v, lo, hi, default):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    if math.isnan(x) or math.isinf(x):
        return default
    return max(lo, min(hi, x))


def _lin(db):
    """dB → the plain (linear) number ffmpeg's compressors take."""
    return 10 ** (db / 20.0)


def pick(v, allowed, default):
    return v if v in allowed else default


def need(item, *kinds):
    if item["kind"] not in kinds:
        raise MediaError("Pick " + " or ".join(kinds) + " for this.")
    return item


def _name(item, suffix):
    base = os.path.splitext(item["name"])[0] if "." in item["name"][-5:] else item["name"]
    return (base + " · " + suffix)[:90]


def _tempo_chain(rate):
    """atempo only takes 0.5-2.0 per step, so bigger changes are chained."""
    parts = []
    while rate > 2.0:
        parts.append("atempo=2.0"); rate /= 2.0
    while rate < 0.5:
        parts.append("atempo=0.5"); rate /= 0.5
    parts.append("atempo=%.5f" % rate)
    return ",".join(parts)


def _audio_out(item, filters, suffix, extra_inputs=(), complex_graph=None, op=""):
    fid, out = new_path("wav")
    args = ["-i", path_of(item)]
    for x in extra_inputs:
        args += ["-i", x]
    if complex_graph:
        args += ["-filter_complex", complex_graph, "-map", "[out]"]
    elif filters:
        args += ["-vn", "-af", ",".join(filters)]
    else:
        args += ["-vn"]
    run(args + WAV + [out])
    return register(fid, "wav", _name(item, suffix), op=op or suffix, parent=item["id"])


# ═════════════ EDIT ═════════════
def _layer_shift(v):
    return round(num(v, -12, 12, 0), 2)


def _layer_chain(shift):
    """Mono + pitch shift for one vocal layer. Shared by the final render and the live-preview stems, so what
    you hear in the preview is the exact same pitch-shifted voice that ends up in the mix."""
    # The sample format is pinned (float) at every step: otherwise ffmpeg picks atempo's format from whatever
    # comes after it (mono 16-bit preview file vs stereo mix), and atempo then splices at different points,
    # so preview and render would differ.
    ratio = 2 ** (shift / 12)
    fmt = "aformat=sample_fmts=flt:sample_rates=%d:channel_layouts=mono" % SR
    chain = "aresample=%d,%s,asetpts=PTS-STARTPTS" % (SR, fmt)
    if ratio != 1:
        chain += ",asetrate=%.6f,aresample=%d,aformat=sample_fmts=flt:channel_layouts=mono,%s,%s" % (SR * ratio, SR, _tempo_chain(1 / ratio), fmt)
    return chain


LAYER_VOICES = ("fixed", "backing")   # plus every key-aware voice in tune.VOICES


def layer_stem(fid, shift=0, voice="fixed", params=None, seed=0):
    """One layer's audio as a WAV file, used by BOTH the browser's live preview and the final render, so the
    preview is exactly what gets saved. Cached in workspace/tmp.
      fixed   - the voice shifted by a fixed number of semitones (ffmpeg chain, _layer_chain)
      backing - the guitar/backing separated in the Tune tab (stereo, unchanged)
      tuned, double, h3up ... - pitch-corrected voice / key-aware harmonies (app/tune.py)
    Once a recording has been analysed as "singing + guitar", voices are made from the separated vocal,
    so the guitar is never pitch-shifted along with the voice."""
    import time
    from . import tune
    it = need(get(fid), "audio", "video")
    if voice == "backing":
        b = tune.backing(it["id"])
        if not b:
            raise MediaError("There is no separated guitar for this file: analyse it as singing + guitar in the Tune tab.")
        return b
    if voice in tune.VOICES:
        return tune.voice(it["id"], params or {}, voice, seed)
    s = _layer_shift(shift)
    sep = tune.raw_vocal(it["id"])
    src = sep or path_of(it)
    path = os.path.join(TMP, "layer-%s-%s%+.2f.wav" % (it["id"], "v" if sep else "", s))
    if not os.path.isfile(path):
        for old in os.listdir(TMP):   # tidy previews older than a day
            if old.startswith("layer-"):
                try:
                    if time.time() - os.path.getmtime(os.path.join(TMP, old)) > 86400:
                        os.remove(os.path.join(TMP, old))
                except OSError:
                    pass
        part = path + ".part.wav"
        run(["-i", src, "-vn", "-af", _layer_chain(s), "-ar", str(SR), "-ac", "1", "-c:a", "pcm_s16le", part])
        os.replace(part, path)
    return path


def vocal_layers(fid, layers, params=None):
    """Mixes the layers from the very same stem files the live preview plays (see layer_stem)."""
    from . import tune
    lead = need(get(fid), "audio", "video")
    if not isinstance(layers, list) or not 1 <= len(layers) <= 10:
        raise MediaError("Choose one to ten audible layers.")
    args, graph, outputs = [], [], []
    for i, layer in enumerate(layers):
        if not isinstance(layer, dict):
            raise MediaError("Invalid layer.")
        voice = layer.get("voice") or "fixed"
        if voice not in LAYER_VOICES and voice not in tune.VOICES:
            raise MediaError("Unknown layer voice.")
        src = layer.get("source") or fid
        args += ["-i", layer_stem(src, layer.get("shift"), voice, params, layer.get("seed"))]
        gain = _lin(num(layer.get("db"), -36, 6, -6))
        pan = num(layer.get("pan"), -1, 1, 0)
        delay = int(num(layer.get("delay"), 0, 5000, 0))
        if voice == "backing":   # stereo, not panned
            chain = "aformat=sample_fmts=flt:sample_rates=%d:channel_layouts=stereo,volume=%.8f,adelay=%d|%d" % (SR, gain, delay, delay)
        else:
            chain = "aformat=sample_fmts=flt:sample_rates=%d:channel_layouts=mono,volume=%.8f,pan=stereo|c0=%.8f*c0|c1=%.8f*c0,adelay=%d|%d" % (
                SR, gain, math.cos((pan + 1) * math.pi / 4), math.sin((pan + 1) * math.pi / 4), delay, delay)
        graph.append("[%d:a]%s[v%d]" % (i, chain, i))
        outputs.append("[v%d]" % i)
    graph.append("%samix=inputs=%d:duration=longest:dropout_transition=0,volume=%d,alimiter=limit=0.95:level=false[out]" % ("".join(outputs), len(layers), len(layers)))
    nid, out = new_path("wav")
    run(args + ["-filter_complex", ";".join(graph), "-map", "[out]"] + WAV + [out])
    return register(nid, "wav", _name(lead, "vocal layers"), "vocal_layers", lead["id"])


def trim(fid, start, end):
    it = need(get(fid), "audio", "video")
    d = it["duration"] or 1e9
    s = num(start, 0, d, 0); e = num(end, 0, d, d)
    if e - s < 0.05:
        raise MediaError("Select a longer part first.")
    if it["kind"] == "video":
        nid, out = new_path("mp4")
        run(["-ss", "%.3f" % s, "-i", path_of(it), "-t", "%.3f" % (e - s), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
             "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out])
        return register(nid, "mp4", _name(it, "trimmed"), "trim", it["id"])
    return _audio_out(it, ["atrim=start=%.3f:end=%.3f" % (s, e), "asetpts=PTS-STARTPTS"], "trimmed", op="trim")


def cut_out(fid, start, end):
    it = need(get(fid), "audio")
    d = it["duration"]
    s = num(start, 0, d, 0); e = num(end, 0, d, 0)
    if e - s < 0.05:
        raise MediaError("Select the part you want to remove first.")
    g = ("[0:a]atrim=end=%.3f,asetpts=PTS-STARTPTS[a];[0:a]atrim=start=%.3f,asetpts=PTS-STARTPTS[b];"
         "[a][b]concat=n=2:v=0:a=1[out]") % (s, e)
    return _audio_out(it, None, "part removed", complex_graph=g, op="cut")


def fades(fid, fin, fout):
    it = need(get(fid), "audio")
    d = it["duration"]
    fi = num(fin, 0, min(30, d), 0); fo = num(fout, 0, min(30, d), 0)
    f = []
    if fi > 0:
        f.append("afade=t=in:st=0:d=%.3f" % fi)
    if fo > 0:
        f.append("afade=t=out:st=%.3f:d=%.3f" % (max(0, d - fo), fo))
    if not f:
        raise MediaError("Set a fade-in or fade-out length.")
    return _audio_out(it, f, "faded", op="fade")


def volume(fid, db):
    it = need(get(fid), "audio")
    g = num(db, -30, 30, 0)
    return _audio_out(it, ["volume=%.2fdB" % g, "alimiter=limit=0.97"], "volume %+.0f dB" % g, op="volume")


def loop(fid, times):
    it = need(get(fid), "audio")
    n = int(num(times, 2, 50, 2))
    fid2, out = new_path("wav")
    run(["-stream_loop", str(n - 1), "-i", path_of(it), "-vn"] + WAV + [out])
    return register(fid2, "wav", _name(it, "looped ×%d" % n), "loop", it["id"])


def join(ids, crossfade):
    items = [need(get(i), "audio") for i in ids][:20]
    if len(items) < 2:
        raise MediaError("Tick at least two sound files to join.")
    cf = num(crossfade, 0, 10, 0)
    args = []
    for it in items:
        args += ["-i", path_of(it)]
    labels = ["[%d:a]aresample=%d,aformat=channel_layouts=stereo[s%d]" % (k, SR, k) for k in range(len(items))]
    g = ";".join(labels) + ";"
    if cf > 0:
        cur = "s0"
        for k in range(1, len(items)):
            nxt = "j%d" % k if k < len(items) - 1 else "out"
            g += "[%s][s%d]acrossfade=d=%.3f[%s];" % (cur, k, cf, nxt)
            cur = nxt
        g = g.rstrip(";")
    else:
        g += "".join("[s%d]" % k for k in range(len(items))) + "concat=n=%d:v=0:a=1[out]" % len(items)
    fid, out = new_path("wav")
    run(args + ["-filter_complex", g, "-map", "[out]"] + WAV + [out])
    return register(fid, "wav", ("Joined: " + " + ".join(i["name"][:20] for i in items))[:90], "join", items[0]["id"])


def export(fid, fmt, quality):
    it = need(get(fid), "audio", "video")
    fmt = pick(fmt, ("mp3", "m4a", "ogg", "flac", "wav", "mp4"), "mp3")
    q = pick(str(quality), ("128", "192", "256", "320"), "192")
    nid, out = new_path(fmt)
    if fmt == "mp4":
        need(it, "video")
        args = ["-i", path_of(it), "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", q + "k", "-movflags", "+faststart"]
    else:
        codec = {"mp3": ["-c:a", "libmp3lame", "-b:a", q + "k"], "m4a": ["-c:a", "aac", "-b:a", q + "k"],
                 "ogg": ["-c:a", "libvorbis", "-b:a", q + "k"], "flac": ["-c:a", "flac"], "wav": ["-c:a", "pcm_s16le"]}[fmt]
        args = ["-i", path_of(it), "-vn", "-ar", str(SR)] + codec
    run(args + [out])
    return register(nid, fmt, _name(it, fmt.upper()), "export", it["id"])


def extract_audio(fid):
    it = need(get(fid), "video")
    if not it["has_audio"]:
        raise MediaError("This video has no sound.")
    return _audio_out(it, [], "sound only", op="extract")


# ═════════════ EFFECTS ═════════════
# Presets. "group": cover = the Instagram acoustic-cover sounds shown first; other = the rest. "best" is shown on
# the card. Values are on the sliders' own steps so the screen shows exactly what is applied. Natural and Intimate
# keep the exact values the owner listened to and liked (earlier sliders rounded 1.45 s / 58 % / +1.5 dB etc.).
PRESETS = {
    "cover_natural": {"label": "Natural", "group": "cover", "best": "Most covers: clear words, warm guitar and a believable room.",
                      "highpass": 70, "deess": 1, "mud": -2.5, "presence": 2, "treble": 2, "comp": 2, "reverb": 14, "room": 1.5,
                      "predelay": 22, "reverb_tone": 60, "width": 0.5, "loud": "-14"},
    "cover_intimate": {"label": "Intimate", "group": "cover", "best": "Soft, close songs: as if you are singing next to the listener.",
                       "highpass": 70, "deess": 1, "mud": -2, "presence": 3, "treble": 1, "comp": 2, "reverb": 9, "room": 0.9,
                       "predelay": 18, "reverb_tone": 65, "width": 0.5, "loud": "-14"},
    "cover_spacious": {"label": "Spacious", "group": "cover", "best": "Slow songs with long held notes.",
                       "highpass": 60, "deess": 1, "mud": -2, "presence": 2, "treble": 1, "comp": 2, "reverb": 23, "room": 2.2,
                       "predelay": 35, "reverb_tone": 50, "width": 1, "loud": "-14"},
    "cover_bright": {"label": "Bright & crisp", "group": "cover", "best": "Recordings that sound muffled or boomy (a phone close to the guitar).",
                     "highpass": 80, "deess": 1, "mud": -3.5, "presence": 3.5, "treble": 3, "comp": 2, "reverb": 12, "room": 1.3,
                     "predelay": 20, "reverb_tone": 65, "width": 0.5, "loud": "-14"},
    "cover_warm": {"label": "Warm & cosy", "group": "cover", "best": "Thin or harsh recordings, and romantic evening songs.",
                   "highpass": 55, "deess": 1, "bass": 2, "mud": -1.5, "presence": 1, "treble": -1, "comp": 2, "reverb": 13, "room": 1.4,
                   "predelay": 20, "reverb_tone": 45, "width": 0.5, "loud": "-14"},
    "cover_studio": {"label": "Studio vocal", "group": "cover", "best": "When your voice should sit clearly on top of the guitar.",
                     "highpass": 80, "deess": 1, "mud": -3, "presence": 3, "treble": 1.5, "comp": 3, "reverb": 10, "room": 1.1,
                     "predelay": 30, "reverb_tone": 60, "width": 0.5, "loud": "-14"},
    "cover_punchy": {"label": "Punchy for Reels", "group": "cover", "best": "Upbeat songs: stays strong on phone speakers.",
                     "highpass": 75, "deess": 1, "bass": 1, "mud": -2, "presence": 2.5, "treble": 2, "comp": 3.5, "reverb": 8, "room": 0.9,
                     "predelay": 15, "reverb_tone": 60, "width": 0.5, "loud": "-14"},
    "cover_soft": {"label": "Soft & close", "group": "cover", "best": "Very soft singing: brings quiet words forward.",
                   "highpass": 70, "deess": 1, "mud": -1.5, "presence": 1.5, "treble": 1.5, "comp": 3.5, "reverb": 7, "room": 0.8,
                   "predelay": 15, "reverb_tone": 60, "width": 0.5, "loud": "-14"},
    "cover_unplugged": {"label": "Live unplugged", "group": "cover", "best": "Feels like a small live room session.",
                        "highpass": 60, "mud": -1.5, "presence": 1.5, "treble": 1, "comp": 1.5, "reverb": 20, "room": 1.8,
                        "predelay": 12, "reverb_tone": 50, "width": 1, "loud": "-14"},
    "cover_dreamy": {"label": "Dreamy", "group": "cover", "best": "Slow, emotional songs: soft and floating, with a gentle echo.",
                     "highpass": 70, "deess": 1, "mud": -2, "presence": 1, "treble": 1, "comp": 2, "reverb": 28, "room": 2.6,
                     "predelay": 40, "reverb_tone": 45, "echo": 12, "echo_ms": 380, "width": 1.5, "loud": "-14"},
    "cover_concert": {"label": "Concert hall", "group": "cover", "best": "Big devotional or classical-style songs.",
                      "highpass": 60, "presence": 1.5, "comp": 2, "reverb": 30, "room": 3.2, "predelay": 30, "reverb_tone": 55,
                      "width": 1, "loud": "-14"},
    "cover_rescue": {"label": "Phone recording rescue", "group": "cover", "best": "When you can hear fan noise, electric hum or an echoey room.",
                     "noise": 8, "hum": 1, "highpass": 85, "deess": 1, "mud": -3.5, "presence": 3, "treble": 2, "comp": 2.5,
                     "reverb": 8, "room": 1.0, "predelay": 15, "reverb_tone": 60, "loud": "-14"},
    "vocal": {"label": "Vocal polish", "group": "other", "best": "A voice on its own (no guitar).", "highpass": 80, "deess": 1, "comp": 3, "presence": 3, "reverb": 15, "room": 1.2, "loud": "-14"},
    "guitar": {"label": "Warm acoustic guitar", "group": "other", "best": "A guitar on its own.", "highpass": 50, "bass": 2, "mud": -1.5, "treble": 1, "comp": 2, "reverb": 16, "room": 1.5, "predelay": 16, "reverb_tone": 55, "loud": "-14"},
    "cleanup": {"label": "Clean up only", "group": "other", "best": "Speech or a rough take: just noise, hum and boom removed.", "noise": 10, "hum": 1, "highpass": 70, "mud": -2, "comp": 1, "loud": "-16"},
    "lofi": {"label": "Lo-fi", "group": "other", "best": "An old, crunchy, nostalgic effect.", "lofi": 1, "reverb": 10, "room": 1.0},
    "radio": {"label": "Old radio", "group": "other", "best": "A telephone / old-radio effect.", "radio": 1},
    "bass": {"label": "Bass boost", "group": "other", "best": "More low end for music played on big speakers.", "bass": 6, "loud": "-14"},
    "hall": {"label": "Big hall reverb", "group": "other", "best": "Only a big reverb, nothing else changed.", "reverb": 35, "room": 3.2},
}


def fx_suggest(fid):
    """Suggests a cover preset from how the recording sounds (tone balance and dynamics). Noise and hum are not
    judged: on continuous music they can't be measured reliably, so "Phone recording rescue" is a choice by ear."""
    it = need(get(fid), "audio", "video")
    if not it["has_audio"]:
        raise MediaError("This video has no sound.")
    sr = 22050
    tmp = os.path.join(TMP, "sg-%s.raw" % secrets.token_hex(4))
    try:
        run(["-i", path_of(it), "-t", "120", "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", tmp])
        y = np.fromfile(tmp, dtype=np.float32)
    finally:
        try: os.remove(tmp)
        except OSError: pass
    if len(y) < sr * 3:
        return {"key": "cover_natural", "reason": "Natural is the best starting point for most covers."}
    n = 4096
    P = np.zeros(n // 2 + 1)
    for s in range(0, len(y) - n, n):
        P += np.abs(np.fft.rfft(y[s:s + n] * np.hanning(n))) ** 2
    f = np.fft.rfftfreq(n, 1 / sr)
    band = lambda lo, hi: float(P[(f >= lo) & (f < hi)].sum())
    tot = band(80, 10000) + 1e-12
    boom, pres, air = band(150, 500) / tot, band(2000, 5000) / tot, band(5000, 10000) / tot
    clarity = band(5000, 10000) / (band(2000, 5000) + 1e-12)   # air vs presence: low = muffled
    fr = int(0.05 * sr)
    db = 20 * np.log10(np.array([np.sqrt((y[i:i + fr] ** 2).mean()) for i in range(0, len(y) - fr, fr)]) + 1e-9)
    act = db[db > db.max() - 45]
    spread = float(np.percentile(act, 95) - np.percentile(act, 10)) if len(act) > 10 else 0
    m = {"boom": round(boom, 3), "presence": round(pres, 4), "clarity": round(clarity, 3), "spread_db": round(spread, 1)}
    if boom > 0.55 and clarity < 0.2:
        return {"key": "cover_bright", "metrics": m, "reason": "Your recording sounds boomy and a little muffled, which is typical for a phone close to the guitar. Bright & crisp clears the boom and brings your words forward."}
    if boom > 0.55:
        return {"key": "cover_studio", "metrics": m, "reason": "Your recording has a lot of low, boomy sound. Studio vocal cuts it and lifts your voice above the guitar."}
    if clarity < 0.15:
        return {"key": "cover_bright", "metrics": m, "reason": "Your recording sounds a little muffled. Bright & crisp adds clarity and air."}
    if clarity > 0.8 or pres > 0.25:
        return {"key": "cover_warm", "metrics": m, "reason": "Your recording sounds bright or thin. Warm & cosy smooths it and adds body."}
    if spread > 20:
        return {"key": "cover_soft", "metrics": m, "reason": "Some parts are much quieter than others. Soft & close evens them out so quiet words aren't lost."}
    return {"key": "cover_natural", "metrics": m, "reason": "Your recording is well balanced. Natural keeps it that way and adds a believable room."}


def _impulse(seconds, path, predelay_ms=20, brightness=55):
    """Make a smooth stereo room/plate impulse.

    A short pre-delay keeps words and guitar attacks clear.  The diffuse tail is band-limited so it
    sounds like a room instead of white-noise hiss, and the two channels are decorrelated for width.
    """
    from scipy.signal import butter, sosfilt

    pre = int(SR * predelay_ms / 1000)
    n = pre + int(SR * seconds)
    rng = np.random.default_rng(7)
    tail_n = n - pre
    t = np.arange(tail_n) / SR
    env = np.exp(-6.9 * t / seconds)   # -60 dB at the end
    fade = np.minimum(1.0, t / 0.018)  # the room builds rather than bursting in
    cutoff = 2800 + (brightness / 100.0) * 8200
    sos = butter(2, [110, min(cutoff, SR * 0.46)], btype="bandpass", fs=SR, output="sos")
    noise = sosfilt(sos, rng.standard_normal((tail_n, 2)), axis=0)
    # A little cross-feed makes the tail cohesive while keeping the stereo channels different.
    noise = np.column_stack((noise[:, 0] + noise[:, 1] * .16, noise[:, 1] + noise[:, 0] * .12))
    ir = np.zeros((n, 2), dtype=np.float64)
    ir[pre:] = noise * env[:, None] * fade[:, None] * .16
    # early reflections only: a full-level 0 ms spike here would put a delayed copy of the dry sound in
    # the wet path and make the voice sound doubled/slapback instead of in a room
    for ms, gl, gr in ((13, .38, .20), (23, .18, .34), (37, .25, .15), (53, .12, .22), (79, .12, .08)):
        k = pre + int(SR * ms / 1000)
        if k < n:
            ir[k, 0] += gl; ir[min(n - 1, k + 31), 1] += gr
    ir[0] = 0
    # Unit energy per channel: the reverb comes out about as loud as the dry sound, so "Reverb 14%"
    # really is a 14% wet mix (afir runs with gtype=none, i.e. without its own volume normalisation).
    ir /= np.sqrt((ir ** 2).sum(axis=0).mean()) + 1e-9
    sf.write(path, ir.astype(np.float32), SR)


def effects(fid, p):
    """p: dict of effect settings (see the Effects tab). Order follows a studio chain:
    clean → tone → dynamics → colour → time effects → space → loudness."""
    it = need(get(fid), "audio")
    f, extra, label = [], [], []
    if num(p.get("noise"), 0, 40, 0) > 0:
        # Track a low steady noise floor instead of gating quiet passages. A conservative -50 dB
        # starting floor helps preserve guitar sustain and breaths between sung phrases.
        f.append("afftdn=nr=%.1f:nf=-50:tn=1:tr=1" % num(p["noise"], 1, 40, 10)); label.append("steady hiss reduced")
    if p.get("hum"):
        # Narrow notches (Q 30, ~3 Hz wide at 100 Hz) so the low G string (98 Hz) and A (110 Hz) keep their body
        f += ["bandreject=f=%d:width_type=q:w=30" % hz for hz in (50, 100, 150)]; label.append("hum removed")
    hp = num(p.get("highpass"), 0, 300, 0)
    if hp >= 20:
        f.append("highpass=f=%d" % hp)
    if p.get("deess"):
        f.append("deesser")
    b = num(p.get("bass"), -12, 12, 0)
    if b:
        f.append("bass=g=%.1f:f=110:w=0.7" % b); label.append("bass %+.0f" % b)
    m = num(p.get("mid"), -12, 12, 0)
    if m:
        f.append("equalizer=f=1000:width_type=o:w=1.2:g=%.1f" % m)
    mud = num(p.get("mud"), -8, 6, 0)
    if mud:
        f.append("equalizer=f=280:width_type=o:w=1.1:g=%.1f" % mud); label.append("boxiness %+.1f" % mud)
    pr = num(p.get("presence"), -12, 12, 0)
    if pr:
        f.append("equalizer=f=3200:width_type=o:w=1:g=%.1f" % pr)
    tr = num(p.get("treble"), -12, 12, 0)
    if tr:
        f.append("treble=g=%.1f:f=8000" % tr)
    c = num(p.get("comp"), 0, 5, 0)
    if c > 0:
        ratio = 1.5 + c; thr = -14 - 2 * c
        f.append("acompressor=threshold=%.5f:ratio=%.1f:attack=12:release=180:makeup=%.2f" % (_lin(thr), ratio, 1 + c * 0.6)); label.append("compressed")
    if p.get("lofi"):
        f += ["highpass=f=180", "lowpass=f=3800", "acrusher=bits=10:mode=log:aa=1:mix=0.35"]; label.append("lo-fi")
    if p.get("radio"):
        f += ["highpass=f=320", "lowpass=f=3200", "acompressor=threshold=%.5f:ratio=6:makeup=4" % _lin(-20)]; label.append("radio")
    semis = num(p.get("pitch"), -12, 12, 0)
    if semis:
        r = 2 ** (semis / 12.0)
        f += ["asetrate=%d" % round(SR * r), "aresample=%d" % SR, _tempo_chain(1 / r)]; label.append("pitch %+.0f" % semis)
    sp = num(p.get("speed"), 0.5, 2.0, 1.0)
    if abs(sp - 1) > 0.005:
        f.append(_tempo_chain(sp)); label.append("speed ×%.2f" % sp)
    ech = num(p.get("echo"), 0, 100, 0)
    if ech > 0:
        ms = int(num(p.get("echo_ms"), 60, 1500, 350))
        f.append("aecho=0.8:0.85:%d|%d:%.2f|%.2f" % (ms, ms * 2, ech / 100 * 0.6, ech / 100 * 0.3)); label.append("echo")
    if num(p.get("width"), 0, 3, 0) > 0:
        f.append("extrastereo=m=%.2f" % (1 + num(p["width"], 0, 3, 0) / 2)); label.append("wider")
    if p.get("silence"):
        f.append("silenceremove=start_periods=1:start_threshold=-50dB:stop_periods=-1:stop_duration=0.7:stop_threshold=-50dB"); label.append("pauses removed")
    rv = num(p.get("reverb"), 0, 100, 0)
    graph = None
    if rv > 0:
        room = num(p.get("room"), 0.3, 6, 1.5)
        predelay = int(num(p.get("predelay"), 0, 100, 20))
        tone = int(num(p.get("reverb_tone"), 0, 100, 55))
        ir = os.path.join(TMP, "ir-v4-%.2f-%d-%d.wav" % (room, predelay, tone))
        if not os.path.isfile(ir):
            _impulse(room, ir, predelay, tone)
        extra.append(ir)
        pre = (",".join(f) if f else "anull")
        mix = rv / 100.0
        graph = ("[0:a]%s,aformat=channel_layouts=stereo,asplit[clean][w];"
                 "[clean]apad=pad_dur=%.3f[dry];[w]apad=pad_dur=%.3f[wp];[wp][1:a]afir=gtype=none[wet];"   # afir's dry= is its INPUT gain: dry=0 silences the reverb
                 "[dry]volume=%.3f[d];[wet]volume=%.3f[r];[d][r]amix=inputs=2:duration=first,volume=2") % (pre, room, room, 1 - mix * 0.6, mix)
        label.append("reverb %d%%" % rv)
    loud = pick(str(p.get("loud", "")), ("-14", "-16", "-23"), "")
    tail = []
    if loud:
        tail.append("loudnorm=I=%s:TP=-1.5:LRA=11" % loud); label.append("loudness %s LUFS" % loud)
    else:
        tail.append("alimiter=limit=0.97")
    if graph:
        graph += "," + ",".join(tail) + "[out]"
        return _audio_out(it, None, ", ".join(label) or "effects", extra_inputs=extra, complex_graph=graph, op="effects")
    if not f and not loud:
        raise MediaError("Turn on at least one effect.")
    return _audio_out(it, f + tail, ", ".join(label) or "effects", op="effects")


def effects_video(fid, p):
    """Polish a phone video's soundtrack and put it back under the untouched picture."""
    vid = need(get(fid), "video")
    if not vid["has_audio"]:
        raise MediaError("This video has no sound to polish.")
    extracted = processed = None
    try:
        extracted = extract_audio(fid)
        processed = effects(extracted["id"], p)
        nid, out = new_path("mp4")
        run(["-i", path_of(vid), "-i", path_of(processed), "-map", "0:v:0", "-map", "1:a:0",
             "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out])
        return register(nid, "mp4", _name(vid, "polished cover"), "effects_video", vid["id"])
    finally:
        if processed:
            delete(processed["id"])
        if extracted:
            delete(extracted["id"])


# ═════════════ ANALYSE ═════════════
_KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_MAJ = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MIN = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def _load_mono(item, sr=22050, max_s=600):
    import librosa
    tmp = os.path.join(TMP, "an-%s.wav" % secrets.token_hex(4))
    try:
        run(["-i", path_of(item), "-vn", "-ac", "1", "-ar", str(sr), "-t", str(max_s), "-c:a", "pcm_s16le", tmp])
        y, _ = librosa.load(tmp, sr=sr, mono=True)
    finally:
        try: os.remove(tmp)
        except OSError: pass
    if len(y) < sr // 2:
        raise MediaError("This sound is too short to analyse.")
    return y, sr


def beats(item):
    import librosa
    y, sr = _load_mono(item)
    tempo, bt = librosa.beat.beat_track(y=y, sr=sr)
    return float(np.atleast_1d(tempo)[0]), librosa.frames_to_time(bt, sr=sr), y, sr


def sound_check(fid):
    """Heuristic recording checks, not a musical correctness score."""
    import tempfile
    it = need(get(fid), "audio", "video")
    with tempfile.TemporaryDirectory(prefix="sound-check-", dir=TMP) as folder:
        decoded = os.path.join(folder, "audio.wav")
        run(["-i", path_of(it), "-t", "120", "-vn", "-ar", "44100", "-ac", "2", "-c:a", "pcm_f32le", decoded])
        y, sr = sf.read(decoded, dtype="float32", always_2d=True)
    if not len(y):
        raise MediaError("No audio samples to analyse.")
    peak = float(np.max(np.abs(y)))
    rms = float(np.sqrt(np.mean(y.astype(np.float64) ** 2)))
    db = lambda x: round(20 * math.log10(max(x, 1e-9)), 1)
    near = float(np.mean(np.abs(y) >= .999) * 100)
    tips = []
    if peak < .0001:
        tips.append("This excerpt is effectively silent. Check the microphone, source track and mute settings.")
    else:
        if near > .01:
            tips.append("Samples reach full scale. Listen for distortion; lower recording gain and re-record if distorted. Lowering volume later cannot repair clipping.")
        elif peak > .89:
            tips.append("Little peak headroom remains. Leave roughly 1 dB of peak headroom when preparing a compressed export.")
        if db(rms) < -30:
            tips.append("Average level is low. Check recording gain first; use final loudness processing after balancing the mix. Boosting also raises noise.")
        crest = db(peak) - db(rms)
        if crest < 6:
            tips.append("Peak-to-average contrast is low. If the vocal sounds flattened, reduce compression or limiting. Sustained notes can also produce this reading.")
        elif crest > 22:
            tips.append("Peaks are much louder than the average. Listen for uneven phrases or guitar attacks; try gentle compression rather than simply increasing volume.")
        # Sum channel powers, avoiding cancellation from a mono downmix.
        n = 4096
        power = np.zeros(n // 2 + 1)
        for start in range(0, len(y) - n + 1, n):
            spectrum = np.fft.rfft(y[start:start+n] * np.hanning(n)[:, None], axis=0)
            power += np.sum(np.abs(spectrum) ** 2, axis=1)
        freq = np.fft.rfftfreq(n, 1 / sr)
        total = float(power.sum()) + 1e-20
        if power[freq < 70].sum() / total > .2:
            tips.append("Strong energy below 70 Hz: check for rumble or handling noise. Try a gentle 60–70 Hz low cut, listening carefully to the guitar's low strings.")
        if power[(freq >= 200) & (freq <= 450)].sum() / total > .5:
            tips.append("Low-mid energy dominates. If it sounds boxy, try a small 1–3 dB cut with Boxiness / mud. This may also be the natural notes of the performance.")
        left, right = y[:, 0], y[:, 1]
        if np.std(left) > 1e-5 and np.std(right) > 1e-5 and np.corrcoef(left, right)[0, 1] < -.2:
            tips.append("The channels are negatively correlated. Check playback in mono; reduce stereo widening or delayed doubles if the voice becomes hollow.")
    if not tips:
        tips.append("No obvious issues were flagged by these checks. Listen for clear words, natural guitar sustain and balanced backing voices before exporting.")
    return {"seconds": round(len(y)/sr, 1), "peak_db": db(peak), "rms_db": db(rms), "near_full_scale_percent": round(near, 4), "tips": tips}


def analyse(fid):
    import librosa
    it = need(get(fid), "audio", "video")
    tempo, bt, y, sr = beats(it)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    best, key = -2, ""
    for k in range(12):
        for prof, mode in ((_MAJ, "major"), (_MIN, "minor")):
            c = np.corrcoef(np.roll(prof, k), chroma)[0, 1]
            if c > best:
                best, key = c, "%s %s" % (_KEYS[k], mode)
    err = run(["-i", path_of(it), "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"])
    import re
    lufs = re.findall(r"I:\s+(-?\d+(?:\.\d+)?) LUFS", err)
    peak = re.findall(r"Peak:\s+(-?\d+(?:\.\d+)?) dBFS", err)
    return {"duration": it["duration"], "bpm": round(tempo, 1), "beats": len(bt), "key": key, "key_confidence": round(float(best), 2),
            "lufs": float(lufs[-1]) if lufs else None, "peak_db": float(peak[-1]) if peak else None}


def analyse_chords(fid, accurate=False, progress=lambda _x: None, stage=lambda _s: None):
    """Estimate beat-aligned major/minor guitar chords from a mixed recording.

    This is deliberately an estimate: vocals and other instruments can share the
    same pitch classes. HPSS emphasizes sustained harmony before template matching.
    """
    import librosa
    it = need(get(fid), "audio", "video")
    method = "full mix"
    if accurate:
        stage("Separating the guitar from vocals")
        sources, source_sr = separate(it, lambda value: progress(value * .65), stage)
        guitar = sources.get("guitar")
        if guitar is None or not guitar.size or float(np.sqrt(np.mean(guitar ** 2))) < 1e-5:
            raise MediaError("The accurate analysis could not isolate a clear guitar. Try Fast analysis on the full mix.")
        y = guitar.mean(axis=1).astype(np.float32)
        y = librosa.resample(y, orig_sr=source_sr, target_sr=22050)
        sr, method = 22050, "isolated guitar"
        progress(.68)
    else:
        stage("Listening for harmony")
        y, sr = _load_mono(it, max_s=1200)
        progress(.2)
    harmonic, _ = librosa.effects.hpss(y, margin=(1.0, 3.0))
    hop = 512
    tuning = float(librosa.estimate_tuning(y=harmonic, sr=sr))
    if not np.isfinite(tuning):
        tuning = 0.0
    chroma = librosa.feature.chroma_cqt(y=harmonic, sr=sr, hop_length=hop, tuning=tuning)
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=hop)
    tempo = float(np.atleast_1d(tempo)[0])
    duration = len(y) / sr
    progress(.82 if accurate else .62)
    stage("Matching chord shapes")

    # Start/end boundaries on beats. Fall back to half-second windows for sparse audio.
    boundaries = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop)
    boundaries = np.unique(np.clip(np.concatenate(([0.0], boundaries, [duration])), 0, duration))
    if len(boundaries) < 4:
        boundaries = np.arange(0, duration + .5, .5)
        boundaries[-1] = duration

    templates, labels = [], []
    for root in range(12):
        for quality, tones, weights in (("", (0, 4, 7), (1.0, .82, .68)), ("m", (0, 3, 7), (1.0, .82, .68))):
            v = np.full(12, .04)
            for tone, weight in zip(tones, weights):
                v[(root + tone) % 12] = weight
            templates.append(v / np.linalg.norm(v))
            labels.append(_KEYS[root] + quality)
    templates = np.asarray(templates)
    raw = []
    for start, end in zip(boundaries[:-1], boundaries[1:]):
        a = max(0, int(start * sr / hop)); b = min(chroma.shape[1], max(a + 1, int(end * sr / hop)))
        vector = np.median(chroma[:, a:b], axis=1)
        energy = float(np.mean(rms[a:min(b, len(rms))])) if a < len(rms) else 0
        norm = np.linalg.norm(vector)
        scores = templates @ (vector / norm) if norm > 1e-8 else np.zeros(len(labels))
        order = np.argsort(scores)
        best_i, next_i = int(order[-1]), int(order[-2])
        confidence = max(0.0, min(1.0, (float(scores[best_i]) - float(scores[next_i])) * 4.0 + .22))
        chord = labels[best_i] if energy > .003 and float(scores[best_i]) > .58 else "N.C."
        raw.append({"start": float(start), "end": float(end), "chord": chord, "confidence": confidence})

    # Remove isolated one-beat flips, then combine consecutive beats into readable regions.
    for i in range(1, len(raw) - 1):
        if raw[i-1]["chord"] == raw[i+1]["chord"] != raw[i]["chord"] and raw[i]["confidence"] < .48:
            raw[i]["chord"] = raw[i-1]["chord"]
    segments = []
    for row in raw:
        if segments and segments[-1]["chord"] == row["chord"]:
            old_d = segments[-1]["end"] - segments[-1]["start"]
            new_d = row["end"] - row["start"]
            segments[-1]["confidence"] = (segments[-1]["confidence"] * old_d + row["confidence"] * new_d) / max(.001, old_d + new_d)
            segments[-1]["end"] = row["end"]
        else:
            segments.append(dict(row))
    for row in segments:
        row["start"] = round(row["start"], 2); row["end"] = round(row["end"], 2)
        row["confidence"] = round(row["confidence"], 2)

    durations = {}
    confidence_seconds = 0.0
    sounding_seconds = 0.0
    for row in segments:
        if row["chord"] != "N.C.":
            seconds = row["end"] - row["start"]
            durations[row["chord"]] = durations.get(row["chord"], 0) + seconds
            confidence_seconds += row["confidence"] * seconds
            sounding_seconds += seconds
    common = [name for name, _seconds in sorted(durations.items(), key=lambda pair: pair[1], reverse=True)[:8]]
    key_chroma = chroma.mean(axis=1)
    best, key = -2, ""
    for root in range(12):
        for profile, mode in ((_MAJ, "major"), (_MIN, "minor")):
            correlation = np.corrcoef(np.roll(profile, root), key_chroma)[0, 1]
            if correlation > best:
                best, key = correlation, "%s %s" % (_KEYS[root], mode)
    progress(1.0)
    # Structural boundaries from large chroma changes, kept far enough apart to
    # produce useful practice sections rather than a marker at every chord.
    section_points = [0.0]
    if len(beat_frames) >= 24:
        beat_chroma = librosa.util.sync(chroma, beat_frames, aggregate=np.median)
        novelty = np.linalg.norm(np.diff(beat_chroma, axis=1), axis=0)
        wanted = max(1, min(7, int(round(duration / 32.0)) - 1))
        chosen = []
        for candidate in np.argsort(novelty)[::-1]:
            if candidate < 12 or candidate > len(beat_frames) - 12:
                continue
            if all(abs(int(candidate) - old) >= 16 for old in chosen):
                chosen.append(int(candidate))
                if len(chosen) >= wanted:
                    break
        section_points += sorted(float(librosa.frames_to_time(beat_frames[p], sr=sr, hop_length=hop)) for p in chosen)
    section_points.append(duration)
    sections, section_vectors, section_names = [], [], []
    for number, (start, end) in enumerate(zip(section_points[:-1], section_points[1:])):
        a = max(0, int(start * sr / hop)); b = min(chroma.shape[1], max(a + 1, int(end * sr / hop)))
        vector = chroma[:, a:b].mean(axis=1); vector /= np.linalg.norm(vector) + 1e-9
        repeat = next((i for i, old in enumerate(section_vectors) if float(np.dot(vector, old)) > .965), None)
        if repeat is None:
            letter = sum(1 for name in section_names if name.startswith("Section "))
            label = "Intro" if number == 0 and end <= 18 else "Section %s" % chr(65 + letter)
            section_vectors.append(vector); section_names.append(label)
        else:
            label = section_names[repeat]
        sections.append({"start": round(start, 2), "end": round(end, 2), "label": label})

    # Average onset positions within a 4/4 bar. Audio alone cannot reliably
    # distinguish downstrokes from upstrokes, so report rhythm hits honestly.
    rhythm = None
    if len(beat_frames) >= 12 and tempo > 0:
        onset_env = librosa.onset.onset_strength(y=harmonic, sr=sr, hop_length=hop)
        onset_frames = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr, hop_length=hop, backtrack=True)
        slots = np.zeros(8); counts = np.zeros(8)
        for frame in onset_frames:
            pos = int(np.searchsorted(beat_frames, frame) - 1)
            if pos < 0 or pos + 1 >= len(beat_frames):
                continue
            span = max(1, beat_frames[pos + 1] - beat_frames[pos])
            half = 1 if (frame - beat_frames[pos]) / span >= .5 else 0
            slot = (pos % 4) * 2 + half
            slots[slot] += float(onset_env[min(int(frame), len(onset_env) - 1)]); counts[slot] += 1
        strength = slots / np.maximum(1, counts)
        if strength.max() > 0:
            threshold = max(float(np.percentile(strength[strength > 0], 35)), float(strength.max()) * .28)
            rhythm = " ".join("X" if value >= threshold else "-" for value in strength)

    report = {"duration": round(duration, 2), "bpm": round(tempo, 1), "key": key,
              "common_chords": common, "segments": segments, "sections": sections, "method": method,
              "overall_confidence": round(confidence_seconds / max(.001, sounding_seconds), 2),
              "tuning_cents": round(tuning * 100, 1), "rhythm_pattern": rhythm}
    if accurate:
        # Cross-check the isolated-guitar result against an independent full-mix
        # pass. Agreement is a more honest reliability signal than template
        # confidence alone.
        mix_report = analyse_chords(fid, False, lambda _value: None, lambda _message: None)
        agreed = total = 0.0
        disagreements = []
        mix_segments = mix_report["segments"]
        for row in segments:
            if row["chord"] == "N.C.":
                continue
            midpoint = (row["start"] + row["end"]) / 2
            other = next((candidate for candidate in mix_segments if candidate["start"] <= midpoint < candidate["end"]), None)
            seconds = row["end"] - row["start"]
            total += seconds
            if other and other["chord"] == row["chord"]:
                agreed += seconds
            elif other:
                disagreements.append({"start": row["start"], "isolated": row["chord"], "full_mix": other["chord"]})
        report["cross_check_agreement"] = round(agreed / max(.001, total), 2)
        report["mix_key"] = mix_report["key"]
        report["disagreements"] = disagreements[:40]
    return report


def transcribe_lyrics(fid, progress=lambda _x: None, stage=lambda _s: None):
    """Offline word-timestamp transcription using faster-whisper (model cached after first use)."""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        raise MediaError("Offline lyrics need faster-whisper. Reinstall requirements, then restart Audio Studio.")
    item = need(get(fid), "audio", "video")
    decoded = os.path.join(TMP, "lyrics-%s.wav" % secrets.token_hex(4))
    try:
        stage("Preparing speech audio")
        run(["-i", path_of(item), "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", decoded])
        progress(.08); stage("Transcribing lyrics locally")
        with _WHISPER_LOCK:
            model = _WHISPER_MODELS.get("base")
            if model is None:
                model = _WHISPER_MODELS["base"] = WhisperModel("base", device="cpu", compute_type="int8")
        stream, info = model.transcribe(decoded, beam_size=5, vad_filter=True, word_timestamps=True)
        rows = []
        for number, segment in enumerate(stream):
            rows.append({"start": round(segment.start, 2), "end": round(segment.end, 2), "text": segment.text.strip(),
                         "words": [{"start": round(word.start, 2), "end": round(word.end, 2), "text": word.word}
                                   for word in (segment.words or [])]})
            progress(min(.95, .1 + .85 * (segment.end / max(1, item["duration"]))))
        progress(1.0)
        return {"language": info.language, "probability": round(info.language_probability, 3), "segments": rows}
    finally:
        try: os.remove(decoded)
        except OSError: pass


def compare_chord_reports(reference, performance, offset=0):
    """Time-aligned chord agreement for a performance recorded with the backing track."""
    agreed = total = 0.0
    offset = num(offset, 0, max(0, reference.get("duration", 0)), 0)
    performance_end = offset + performance.get("duration", 0)
    misses = []
    for expected in reference.get("segments", []):
        if expected["chord"] == "N.C.":
            continue
        if expected["end"] <= offset or expected["start"] >= performance_end:
            continue
        midpoint = (expected["start"] + expected["end"]) / 2
        heard_time = midpoint - offset
        heard = next((row for row in performance.get("segments", []) if row["start"] <= heard_time < row["end"]), None)
        seconds = expected["end"] - expected["start"]; total += seconds
        if heard and heard["chord"] == expected["chord"]:
            agreed += seconds
        else:
            misses.append({"start": expected["start"], "expected": expected["chord"], "heard": heard["chord"] if heard else "N.C."})
    return {"accuracy": round(agreed / max(.001, total), 3), "misses": misses[:30]}


def chord_practice_video(fid, report, transpose=0, simple=False):
    """Render a 720p practice video with timed current/next chord overlays."""
    item = need(get(fid), "audio", "video")
    segments = [row for row in (report or {}).get("segments", []) if row.get("end", 0) > row.get("start", 0)]
    if not segments:
        raise MediaError("Analyse the chords before making a practice video.")
    shift = int(num(transpose, -11, 11, 0))
    keys = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

    def shown(chord):
        if chord == "N.C.": return chord
        import re
        match = re.match(r"^([A-G])([#b]?)(.*)$", chord or "")
        if not match: return chord or "N.C."
        root = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}.get(match.group(1) + match.group(2), match.group(1) + match.group(2))
        suffix = match.group(3)
        if simple: suffix = "m" if suffix.startswith("m") and not suffix.startswith("maj") else ""
        return keys[(keys.index(root) + shift) % 12] + suffix

    def ass_time(seconds):
        value = max(0.0, float(seconds)); hours = int(value // 3600); value %= 3600
        return "%d:%02d:%05.2f" % (hours, int(value // 60), value % 60)

    subtitle = os.path.join(TMP, "chords-%s.ass" % secrets.token_hex(5))
    fid_out, out = new_path("mp4")
    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Chord,Arial,92,&H00FFFFFF,&H000000FF,&H00110B05,&H90000000,-1,0,0,0,100,100,1,0,1,5,2,2,30,30,88,1
Style: Next,Arial,30,&H00B9B0A5,&H000000FF,&H00110B05,&H70000000,0,0,0,0,100,100,0,0,1,3,1,2,30,30,38,1
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
"""
    events = []
    for index, row in enumerate(segments):
        current = shown(row.get("chord")); upcoming = shown(segments[index + 1].get("chord")) if index + 1 < len(segments) else "End"
        start, end = ass_time(row["start"]), ass_time(row["end"])
        events.append("Dialogue: 0,%s,%s,Chord,,0,0,0,,%s" % (start, end, current.replace(",", "")))
        events.append("Dialogue: 0,%s,%s,Next,,0,0,0,,Next: %s" % (start, end, upcoming.replace(",", "")))
    try:
        with open(subtitle, "w", encoding="utf-8-sig") as handle: handle.write(header + "\n".join(events))
        escaped = subtitle.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
        vf = "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x0b0907,ass='%s'" % escaped
        if item["kind"] == "video":
            args = ["-i", path_of(item), "-vf", vf, "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21"]
        else:
            args = ["-f", "lavfi", "-i", "color=c=0x0b0907:s=1280x720:r=30:d=%.3f" % item["duration"], "-i", path_of(item), "-vf", vf,
                    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21"]
        run(args + ["-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out])
        return register(fid_out, "mp4", _name(item, "chord practice video"), op="chord_video", parent=item["id"])
    finally:
        try: os.remove(subtitle)
        except OSError: pass


def best_part(fid, length):
    """The liveliest stretch of a song (energy + beats), starting on a beat; for Reels and Stories."""
    import librosa
    it = need(get(fid), "audio")
    L = num(length, 5, 90, 30)
    if it["duration"] <= L + 1:
        raise MediaError("The song is already shorter than that.")
    tempo, bt, y, sr = beats(it)
    hop = 512
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    ons = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    n = min(len(rms), len(ons))
    score = rms[:n] / (rms.max() + 1e-9) + 0.5 * ons[:n] / (ons.max() + 1e-9)
    win = int(L * sr / hop)
    cs = np.concatenate([[0], np.cumsum(score)])
    sums = cs[win:] - cs[:-win] if len(cs) > win else np.array([0.0])
    starts = list(bt) if len(bt) else list(np.arange(0, it["duration"] - L, 0.5))
    best_s, best_v = 0.0, -1
    for s in starts:
        k = int(s * sr / hop)
        if 0 <= k < len(sums) and s + L <= it["duration"] and sums[k] > best_v:
            best_s, best_v = float(s), float(sums[k])
    fo = min(2.0, L / 6)
    out = _audio_out(it, ["atrim=start=%.3f:end=%.3f" % (best_s, best_s + L), "asetpts=PTS-STARTPTS",
                          "afade=t=in:st=0:d=0.4", "afade=t=out:st=%.3f:d=%.3f" % (L - fo, fo)],
                     "best %ds (from %d:%02d)" % (L, best_s // 60, best_s % 60), op="best")
    out["from"] = round(best_s, 2)
    return out


# ═════════════ VIDEO ═════════════
ASPECTS = {"9:16": (1080, 1920), "1:1": (1080, 1080), "4:5": (1080, 1350), "16:9": (1920, 1080)}


def music_under_video(vid, mid, p):
    v = need(get(vid), "video"); m = need(get(mid), "audio", "video")
    D = v["duration"]
    mvol = num(p.get("music_db"), -30, 6, -6)
    off = num(p.get("music_from"), 0, max(0, m["duration"] - 1), 0)
    fo = num(p.get("fade_out"), 0, 10, 2)
    keep = bool(p.get("keep_original")) and v["has_audio"]
    ovol = num(p.get("original_db"), -30, 10, 0)
    duck = bool(p.get("duck")) and keep
    music = "[1:a]atrim=start=%.3f,asetpts=PTS-STARTPTS,aformat=channel_layouts=stereo,volume=%.2fdB,apad,atrim=end=%.3f" % (off, mvol, D)
    if fo > 0:
        music += ",afade=t=out:st=%.3f:d=%.3f" % (max(0, D - fo), fo)
    if keep:
        # the same exact format on both sides (ffmpeg 4.2's sidechaincompress can't pick one itself)
        fmt = "aformat=sample_fmts=dbl:sample_rates=%d:channel_layouts=stereo" % SR
        g = "[0:a]aresample=%d,%s,volume=%.2fdB,asplit[o][sc];%s,%s[m];" % (SR, fmt, ovol, music, fmt)
        if duck:   # music dips whenever the video's own sound (a voice) is loud
            g += "[m][sc]sidechaincompress=threshold=0.04:ratio=10:attack=15:release=450[md];[o][md]amix=inputs=2:duration=first,volume=2[out]"
        else:
            g += "[sc]anullsink;[o][m]amix=inputs=2:duration=first,volume=2[out]"
    else:
        g = music + "[out]"
    fid, out = new_path("mp4")
    run(["-i", path_of(v), "-i", path_of(m), "-filter_complex", g, "-map", "0:v:0", "-map", "[out]",
         "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out])
    return register(fid, "mp4", _name(v, "with music"), "video_music", v["id"])


def beat_reel(clip_ids, mid, p):
    """Cuts your clips/photos to the music's beats and joins them into one video."""
    clips = [need(get(c), "video", "image") for c in clip_ids][:30]
    if not clips:
        raise MediaError("Tick the videos or photos to use.")
    m = need(get(mid), "audio")
    W, H = ASPECTS[pick(p.get("aspect"), tuple(ASPECTS), "9:16")]
    total = num(p.get("length"), 5, 120, 30)
    per = int(pick(str(p.get("beats_per_cut", "4")), ("1", "2", "4", "8"), "4"))
    off = num(p.get("music_from"), 0, max(0, m["duration"] - 3), 0)
    tempo, bt, _, _ = beats(m)
    # A steady beat grid from the tempo, lined up with the beats that were heard, so quiet intros
    # (where the detector hears nothing) still get cuts on the beat.
    if len(bt) >= 4:
        period = float(np.median(np.diff(bt)))
        phase = float(bt[0]) % period
        grid = np.arange(phase, m["duration"] + period, period)
    else:   # no clear beat: a cut every 2 seconds
        grid = np.arange(0, m["duration"] + 2, 2.0 / per)
    bt = [t - off for t in grid if t >= off]
    cuts = [0.0] + [bt[k] for k in range(per, len(bt), per) if bt[k] <= total]
    if cuts[-1] < total - 0.3:
        cuts.append(total)
    durs = [b - a for a, b in zip(cuts, cuts[1:]) if b - a > 0.15]
    if not durs:
        raise MediaError("The music is too short for this length.")
    tag = secrets.token_hex(3)
    parts, cursor = [], {c["id"]: 0.0 for c in clips}
    vf = "scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,setsar=1,fps=30,format=yuv420p" % (W, H, W, H)
    try:
        for k, d in enumerate(durs):
            c = clips[k % len(clips)]
            seg = os.path.join(TMP, "reel-%s-%03d.mp4" % (tag, k))
            if c["kind"] == "image":
                # one still frame in, a slow zoom of d seconds out (zoompan makes all the frames itself)
                zoom = "zoompan=z='min(zoom+0.0012,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=%d:s=%dx%d:fps=30" % (max(1, int(d * 30)), W, H)
                pre = "scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,setsar=1" % (W, H, W, H)
                args = ["-i", path_of(c), "-vf", pre + "," + zoom + ",format=yuv420p"]
            else:
                st = cursor[c["id"]]
                if st + d > c["duration"]:
                    st = 0.0
                cursor[c["id"]] = st + d
                args = ["-ss", "%.3f" % st, "-t", "%.3f" % d, "-i", path_of(c), "-vf", vf]
            run(args + ["-an", "-t", "%.3f" % d, "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", seg])
            parts.append(seg)
        lst = os.path.join(TMP, "reel-%s.txt" % tag)
        with open(lst, "w", encoding="utf-8") as fh:
            for s in parts:
                fh.write("file '%s'\n" % s.replace("\\", "/"))
        L = sum(durs)
        fid, out = new_path("mp4")
        fo = min(2.0, L / 5)
        run(["-f", "concat", "-safe", "0", "-i", lst, "-ss", "%.3f" % off, "-i", path_of(m),
             "-filter_complex", "[1:a]atrim=end=%.3f,asetpts=PTS-STARTPTS,afade=t=out:st=%.3f:d=%.3f[a]" % (L, L - fo, fo),
             "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out])
        os.remove(lst)
    finally:
        for s in parts:
            try: os.remove(s)
            except OSError: pass
    r = register(fid, "mp4", "Beat reel %s · %d shot%s · %.0f BPM" % (p.get("aspect", "9:16"), len(durs), "" if len(durs) == 1 else "s", tempo), "beat_reel", m["id"])
    return r


# ═════════════ VOICE ═════════════
VOICES = {"af_heart": "Heart (US woman, warm)", "af_bella": "Bella (US woman)", "af_nicole": "Nicole (US woman, soft)",
          "am_michael": "Michael (US man)", "am_fenrir": "Fenrir (US man, deep)", "bf_emma": "Emma (British woman)",
          "bm_george": "George (British man)", "bm_daniel": "Daniel (British man, calm)"}
_KOKORO = None
KOKORO_DIR = os.environ.get("STUDIO_KOKORO_DIR", r"C:\Users\asus\npf-voice")


def _kokoro():
    global _KOKORO
    if _KOKORO is None:
        from kokoro_onnx import Kokoro
        mp, vp = os.path.join(KOKORO_DIR, "kokoro-v1.0.int8.onnx"), os.path.join(KOKORO_DIR, "voices-v1.0.bin")
        if not (os.path.isfile(mp) and os.path.isfile(vp)):
            raise MediaError("The voice files are missing in " + KOKORO_DIR)
        _KOKORO = Kokoro(mp, vp)
    return _KOKORO


def voiceover(text, voice, speed, music_id=None, music_db=-14, music_from=0):
    text = " ".join(str(text or "").split())[:4000]
    if len(text) < 2:
        raise MediaError("Type what the voice should say.")
    voice = pick(voice, tuple(VOICES), "af_heart")
    sp = num(speed, 0.6, 1.6, 1.0)
    samples, sr = _kokoro().create(text, voice=voice, speed=sp, lang="en-gb" if voice.startswith("b") else "en-us")
    tag = secrets.token_hex(3)
    raw = os.path.join(TMP, "voice-%s.wav" % tag)
    sf.write(raw, samples, sr)
    try:
        if not music_id:
            fid, out = new_path("wav")
            run(["-i", raw, "-af", "highpass=f=70,acompressor=threshold=%.5f:ratio=2.5:makeup=2,loudnorm=I=-16:TP=-1.5" % _lin(-18)] + WAV + [out])
            return register(fid, "wav", ("Voice: " + text[:40]), "voice")
        m = need(get(music_id), "audio")
        vd = len(samples) / float(sr)
        L = vd + 2.5
        off = num(music_from, 0, max(0, m["duration"] - 1), 0)
        mdb = num(music_db, -30, 0, -14)
        # ffmpeg 4.2's sidechaincompress needs the exact same format spelled out on both of its inputs
        fmt = "aformat=sample_fmts=dbl:sample_rates=%d:channel_layouts=stereo" % SR
        g = ("[0:a]aresample=%d,%s,adelay=800|800,apad,atrim=end=%.3f,asplit[v][sc];"
             "[1:a]atrim=start=%.3f,asetpts=PTS-STARTPTS,aformat=channel_layouts=stereo,volume=%.1fdB,apad,atrim=end=%.3f,"
             "afade=t=in:st=0:d=0.5,afade=t=out:st=%.3f:d=1.8,%s[m];"
             "[m][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=500[md];"
             "[v][md]amix=inputs=2:duration=first,volume=2,loudnorm=I=-14:TP=-1.5[out]") % (SR, fmt, L, off, mdb, L, L - 1.8, fmt)
        fid, out = new_path("wav")
        run(["-i", raw, "-i", path_of(m), "-filter_complex", g, "-map", "[out]"] + WAV + [out])
        return register(fid, "wav", ("Voice + music: " + text[:30]), "voice", m["id"])
    finally:
        try: os.remove(raw)
        except OSError: pass


# ═════════════ PRACTICE ═════════════
def practice_copy(fid, rate, start=None, end=None):
    """A slowed (or sped-up) copy that keeps the pitch, optionally only the A–B part, to take to the phone."""
    it = need(get(fid), "audio", "video")
    if not it["has_audio"]:
        raise MediaError("This video has no sound.")
    r = num(rate, 0.5, 1.5, 1.0)
    d = it["duration"] or 1e9
    f = []
    s, e = num(start, 0, d, 0), num(end, 0, d, 0)
    if e - s >= 0.5:
        f += ["atrim=start=%.3f:end=%.3f" % (s, e), "asetpts=PTS-STARTPTS"]
    if abs(r - 1) > 0.005:
        f.append(_tempo_chain(r))
    if not f:
        raise MediaError("Choose a slower speed or select a part first.")
    f.append("alimiter=limit=0.97")
    label = "practice %d%%" % round(r * 100) + (" (%s-%s)" % (_mmss(s), _mmss(e)) if e - s >= 0.5 else "")
    return _audio_out(it, f, label, op="practice")


def _mmss(t):
    return "%d:%02d" % (t // 60, t % 60)


# ═════════════ SPLIT (stems with Demucs) ═════════════
# htdemucs_6s separates drums, bass, other, vocals, guitar and piano. It runs on the CPU (about half
# the song's length on this PC). The model (~55 MB) is kept in the HuggingFace cache in the user folder
# after the first download; from then on it loads offline.
STEMS = {
    "vocals": ("Vocals only", ["vocals"]),
    "guitar": ("Guitar only", ["guitar"]),
    "karaoke": ("Karaoke (no vocals)", ["drums", "bass", "other", "guitar", "piano"]),
    "no_guitar": ("Backing without guitar", ["drums", "bass", "other", "vocals", "piano"]),
    "drums": ("Drums only", ["drums"]),
    "bass": ("Bass only", ["bass"]),
}
_DEMUCS = None
_split_lock = threading.Lock()


def _demucs():
    global _DEMUCS
    if _DEMUCS is None:
        os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
        os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
        cache = os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub", "models--adefossez--HTDemucs-6s")
        if os.path.isdir(cache):
            os.environ["HF_HUB_OFFLINE"] = "1"   # already downloaded: never go online again
        try:
            from demucs.pretrained import get_model
        except ImportError:
            raise MediaError("The song splitter isn't installed. Run: .venv/Scripts/python.exe -m pip install demucs")
        try:
            _DEMUCS = get_model("htdemucs_6s")
        except Exception as e:
            raise MediaError("Could not load the song splitter model (%s). The first use needs internet once to download it." % str(e)[:200])
    return _DEMUCS


def separate(it, progress=lambda p: None, stage=lambda s: None):
    """Runs Demucs on a library item. Returns ({source name: (samples, 2) float32 array}, sample rate).
    One separation at a time (it uses every CPU core)."""
    import torch
    from demucs.apply import apply_model
    if it["duration"] > 20 * 60:
        raise MediaError("Songs up to 20 minutes can be separated. Trim it first.")
    if not _split_lock.acquire(blocking=False):   # one at a time (it uses every core): wait for our turn
        stage("Waiting for the other separation to finish")
        _split_lock.acquire()
        stage(None)
    tmp = os.path.join(TMP, "split-%s.wav" % secrets.token_hex(4))
    try:
        progress(0.01)
        model = _demucs()
        run(["-i", path_of(it), "-vn", "-ar", str(model.samplerate), "-ac", "2", "-c:a", "pcm_f32le", tmp])
        y, sr = sf.read(tmp, dtype="float32", always_2d=True)
        wav = torch.from_numpy(y.T.copy())
        ref = wav.mean(0)
        mean, std = ref.mean(), ref.std() + 1e-8
        x = ((wav - mean) / std)[None]
        seg = float(getattr(model, "segment", 7.8) or 7.8)
        n_models = len(getattr(model, "models", [model]))
        total = max(1, n_models * math.ceil(x.shape[-1] / max(1, int(0.75 * seg * sr))))
        done = [0]

        def cb(d):
            if d.get("state") == "end":
                done[0] += 1
                progress(0.02 + 0.93 * min(1.0, done[0] / total))

        with torch.no_grad():
            out = apply_model(model, x, shifts=1, split=True, overlap=0.25, callback=cb)[0]
        out = out * std + mean
        return {name: out[k].numpy().T for k, name in enumerate(model.sources)}, sr
    finally:
        _split_lock.release()
        try: os.remove(tmp)
        except OSError: pass


def split(fid, wanted, progress=lambda p: None, stage=lambda s: None):
    """Separates a song and adds the chosen mixes (see STEMS) to the library."""
    it = need(get(fid), "audio", "video")
    if not it["has_audio"]:
        raise MediaError("This video has no sound.")
    wanted = [w for w in STEMS if w in (wanted or [])]
    if not wanted:
        raise MediaError("Tick at least one thing to make.")
    src, sr = separate(it, progress, stage)
    results = []
    for w in wanted:
        label, parts = STEMS[w]
        mix = sum(src[p] for p in parts if p in src)
        peak = float(np.max(np.abs(mix))) if mix.size else 0
        if peak > 0.99:
            mix = mix * (0.99 / peak)
        nid, path = new_path("wav")
        sf.write(path, mix, sr, subtype="PCM_16")
        if sr != SR:
            fixed = path + ".tmp.wav"
            run(["-i", path] + WAV + [fixed]); os.replace(fixed, path)
        results.append(register(nid, "wav", _name(it, label), "split", it["id"]))
    progress(1.0)
    return results
