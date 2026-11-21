"""Everything the studio can do. Each function takes plain values from the page (already checked
with num()/pick()), runs ffmpeg or Python, registers the result in the library and returns it.

Audio results are saved as WAV (lossless) while you work; "Export" makes MP3 / M4A / OGG / FLAC.
Video results are MP4 (H.264 + AAC), which Instagram, Facebook, WhatsApp and YouTube all accept.
"""
import math, os, secrets, threading

import numpy as np
import soundfile as sf

from .media import FILES, TMP, MediaError, get, new_path, path_of, register, run

SR = 44100
WAV = ["-ar", str(SR), "-ac", "2", "-c:a", "pcm_s16le"]


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
PRESETS = {
    "vocal": {"label": "Vocal polish", "highpass": 80, "deess": 1, "comp": 3, "presence": 3, "reverb": 15, "room": 1.2, "loud": "-14"},
    "guitar": {"label": "Warm acoustic guitar", "highpass": 60, "bass": 2, "treble": 1, "comp": 2, "reverb": 18, "room": 1.6, "loud": "-14"},
    "cleanup": {"label": "Clean up a phone recording", "noise": 18, "hum": 1, "highpass": 90, "comp": 2, "loud": "-16"},
    "lofi": {"label": "Lo-fi", "lofi": 1, "reverb": 10, "room": 1.0},
    "radio": {"label": "Old radio", "radio": 1},
    "bass": {"label": "Bass boost", "bass": 6, "loud": "-14"},
    "hall": {"label": "Big hall reverb", "reverb": 35, "room": 3.2},
}


def _impulse(seconds, path):
    """A simple stereo room echo (decaying noise with a few early reflections) for convolution reverb."""
    n = int(SR * seconds)
    rng = np.random.default_rng(7)
    t = np.arange(n) / SR
    env = np.exp(-6.9 * t / seconds)   # -60 dB at the end
    ir = rng.standard_normal((n, 2)) * env[:, None]
    for ms, g in ((11, .5), (19, .35), (29, .3), (41, .22)):
        k = int(SR * ms / 1000)
        if k < n:
            ir[k, 0] += g; ir[min(n - 1, k + 37), 1] += g
    ir[0] = 0
    ir /= np.max(np.abs(ir)) + 1e-9
    sf.write(path, (ir * 0.5).astype(np.float32), SR)


def effects(fid, p):
    """p: dict of effect settings (see the Effects tab). Order follows a studio chain:
    clean → tone → dynamics → colour → time effects → space → loudness."""
    it = need(get(fid), "audio")
    f, extra, label = [], [], []
    if num(p.get("noise"), 0, 40, 0) > 0:
        f.append("afftdn=nr=%.1f:nf=-30" % num(p["noise"], 1, 40, 12)); label.append("noise cleaned")
    if p.get("hum"):
        f += ["bandreject=f=50:width_type=q:w=8", "bandreject=f=100:width_type=q:w=8", "bandreject=f=150:width_type=q:w=8"]; label.append("hum removed")
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
        ir = os.path.join(TMP, "ir-%.2f.wav" % room)
        if not os.path.isfile(ir):
            _impulse(room, ir)
        extra.append(ir)
        pre = (",".join(f) if f else "anull")
        mix = rv / 100.0
        graph = ("[0:a]%s,aformat=channel_layouts=stereo,asplit[dry][w];[w][1:a]afir[wet];"
                 "[dry]volume=%.3f[d];[wet]volume=%.3f[r];[d][r]amix=inputs=2:duration=first,volume=2") % (pre, 1 - mix * 0.6, mix)
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


def split(fid, wanted, progress=lambda p: None):
    """Separates a song and adds the chosen mixes (see STEMS) to the library."""
    import torch
    from demucs.apply import apply_model
    it = need(get(fid), "audio", "video")
    if not it["has_audio"]:
        raise MediaError("This video has no sound.")
    wanted = [w for w in STEMS if w in (wanted or [])]
    if not wanted:
        raise MediaError("Tick at least one thing to make.")
    if it["duration"] > 20 * 60:
        raise MediaError("Songs up to 20 minutes can be split. Trim it first.")
    if not _split_lock.acquire(blocking=False):
        raise MediaError("Another song is being split. Wait for it to finish.")
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
        src = {name: out[k] for k, name in enumerate(model.sources)}
        results = []
        for w in wanted:
            label, parts = STEMS[w]
            mix = sum(src[p] for p in parts if p in src).numpy().T
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
    finally:
        _split_lock.release()
        try: os.remove(tmp)
        except OSError: pass
