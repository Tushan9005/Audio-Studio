"""Import audio from one public social video into the local library with yt-dlp.

The URL allow-list is intentionally narrow.  yt-dlp still owns the site-specific
network logic; this module only gives it a safe, bounded destination in workspace.
"""
import os
import re
import shutil
import tempfile
from urllib.parse import urlparse

from . import media
from .media import MediaError


ALLOWED_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be",
    "instagram.com", "www.instagram.com",
    "facebook.com", "www.facebook.com", "m.facebook.com", "fb.watch",
}


def validate_url(value):
    url = str(value or "").strip()
    try:
        parsed = urlparse(url)
    except ValueError:
        parsed = None
    host = (parsed.hostname or "").lower() if parsed else ""
    if not parsed or parsed.scheme not in ("http", "https") or host not in ALLOWED_HOSTS:
        raise MediaError("Paste a valid Instagram, Facebook or YouTube video link.")
    return url


def import_audio(value, progress=lambda _x: None, stage=lambda _s: None):
    """Download only the soundtrack, normalize it to M4A, and register it."""
    url = validate_url(value)
    try:
        from yt_dlp import YoutubeDL
        from yt_dlp.utils import DownloadError
    except ImportError:
        raise MediaError("Link importing is not installed yet. Run Start Audio Studio.bat once more to install the new dependency.")

    folder = tempfile.mkdtemp(prefix="social-", dir=media.TMP)
    template = os.path.join(folder, "source.%(ext)s")

    def hook(info):
        if info.get("status") == "downloading":
            total = info.get("total_bytes") or info.get("total_bytes_estimate") or 0
            if total:
                progress(min(.42, .42 * info.get("downloaded_bytes", 0) / total))
            stage("Downloading audio")
        elif info.get("status") == "finished":
            progress(.44)
            stage("Preparing audio")

    def duration_filter(info, _incomplete=False):
        if info.get("duration") and float(info["duration"]) > 20 * 60:
            return "This video is longer than 20 minutes"
        return None

    opts = {
        "outtmpl": template,
        "noplaylist": True,
        "playlist_items": "1",
        "max_filesize": 1024 * 1024 * 1024,
        # Chord analysis needs no picture. This is dramatically faster than
        # downloading and re-encoding a full 720p video.
        "format": "bestaudio[ext=m4a]/bestaudio/best",
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
        "socket_timeout": 30,
        "retries": 2,
        "match_filter": duration_filter,
    }
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
        candidates = [os.path.join(folder, name) for name in os.listdir(folder)
                      if os.path.isfile(os.path.join(folder, name)) and not name.endswith((".part", ".ytdl"))]
        if not candidates:
            raise MediaError("The video could not be found after downloading.")
        source = max(candidates, key=os.path.getsize)
        fid, dest = media.new_path("m4a")
        # Normalise only the small audio stream for reliable browser playback.
        media.run(["-i", source, "-vn", "-c:a", "aac", "-b:a", "192k", dest])
        title = media.clean_name(info.get("title") or "Imported social video", "Imported social video")
        progress(.48)
        return media.register(fid, "m4a", title, "link audio")
    except DownloadError as exc:
        message = str(exc).splitlines()[-1].replace("ERROR: ", "")
        message = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", message)
        raise MediaError("Could not download that link: %s" % message[:260])
    finally:
        shutil.rmtree(folder, ignore_errors=True)
