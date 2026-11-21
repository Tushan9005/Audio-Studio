"""Workspace (the files you work on) and a safe ffmpeg runner.

Every file lives in workspace/files/<id>.<ext> and is described in workspace/index.json.
Nothing is ever changed in place: each edit makes a new file that remembers where it came from.
ffmpeg is the free build bundled with imageio-ffmpeg; it is always called with an argument list
(never through a shell), so names and numbers typed in the app can't run commands.
"""
import json, os, re, secrets, subprocess, threading, time

import imageio_ffmpeg

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = os.path.join(ROOT, "workspace")
FILES = os.path.join(WS, "files")
TMP = os.path.join(WS, "tmp")
INDEX = os.path.join(WS, "index.json")
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
for d in (WS, FILES, TMP):
    os.makedirs(d, exist_ok=True)

AUDIO_EXT = {"wav", "mp3", "m4a", "aac", "ogg", "oga", "opus", "flac", "webm", "wma", "aif", "aiff"}
VIDEO_EXT = {"mp4", "mov", "mkv", "avi", "m4v", "3gp", "webm"}
IMAGE_EXT = {"jpg", "jpeg", "png", "webp", "bmp"}
_lock = threading.Lock()


class MediaError(Exception):
    """A problem worth showing to the user as it is."""


def _load():
    try:
        with open(INDEX, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _save(items):
    tmp = INDEX + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)
    os.replace(tmp, INDEX)


def list_files():
    items = [i for i in _load() if os.path.isfile(path_of(i))]
    return sorted(items, key=lambda i: i["created"], reverse=True)


def get(fid):
    for i in _load():
        if i["id"] == fid and os.path.isfile(path_of(i)):
            return i
    raise MediaError("That file is no longer in the library.")


def path_of(item):
    return os.path.join(FILES, item["id"] + "." + item["ext"])


def new_path(ext):
    fid = time.strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(3)
    return fid, os.path.join(FILES, fid + "." + ext)


def clean_name(name, fallback="file"):
    name = re.sub(r"[^\w\-\. ()&+,·×#%:]+", "_", str(name or "")).strip(" ._")
    return (name or fallback)[:90]


def register(fid, ext, name, op="", parent=None):
    """Add a finished file to the library (probes its length and kind)."""
    p = os.path.join(FILES, fid + "." + ext)
    info = probe(p)
    kind = "image" if ext in IMAGE_EXT else ("video" if info["video"] else "audio")
    item = {"id": fid, "ext": ext, "name": clean_name(name), "kind": kind, "duration": info["duration"],
            "width": info["width"], "height": info["height"], "has_audio": info["audio"],
            "op": op, "parent": parent, "created": time.time(), "size": os.path.getsize(p)}
    with _lock:
        items = _load()
        items.append(item)
        _save(items)
    return item


def rename(fid, name):
    with _lock:
        items = _load()
        for i in items:
            if i["id"] == fid:
                i["name"] = clean_name(name, i["name"])
        _save(items)


def delete(fid):
    with _lock:
        items = _load()
        keep = []
        for i in items:
            if i["id"] == fid:
                try:
                    os.remove(path_of(i))
                except OSError:
                    pass
            else:
                keep.append(i)
        _save(keep)


def run(args, timeout=1800):
    """Run ffmpeg with an argument list. Raises MediaError with ffmpeg's last lines on failure."""
    cmd = [FFMPEG, "-hide_banner", "-nostdin", "-y"] + [str(a) for a in args]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if r.returncode != 0:
        tail = [l for l in r.stderr.strip().splitlines() if l.strip()][-4:]
        raise MediaError("ffmpeg could not do that: " + " | ".join(tail)[-600:])
    return r.stderr


def probe(path):
    """Length, video size and whether there is sound, read from ffmpeg's own report."""
    r = subprocess.run([FFMPEG, "-hide_banner", "-i", path], capture_output=True, text=True, encoding="utf-8",
                       errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    err = r.stderr
    dur = 0.0
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", err)
    if m:
        dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    v = None
    for line in err.splitlines():
        if "Video:" in line and "attached pic" not in line:
            mm = re.search(r"\b(\d{2,5})x(\d{2,5})\b", line)
            if mm:
                v = (int(mm.group(1)), int(mm.group(2)))
                break
    has_audio = "Audio:" in err
    if not m and v is None and not has_audio:
        raise MediaError("This file can't be read. Is it a sound, video or picture file?")
    return {"duration": round(dur, 3), "video": v is not None, "width": v[0] if v else 0, "height": v[1] if v else 0, "audio": has_audio}
