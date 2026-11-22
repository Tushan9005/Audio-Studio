"""Durable per-song project data and portable project archives."""
import json
import os
import secrets
import shutil
import threading
import zipfile

from . import media
from .media import MediaError


STORE = os.path.join(media.WS, "projects.json")
_lock = threading.Lock()


def _load():
    try:
        with open(STORE, encoding="utf-8") as handle:
            value = json.load(handle)
            return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(value):
    temporary = STORE + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=1)
    os.replace(temporary, STORE)


def get(fid):
    return _load().get(fid, {})


def save(fid, patch):
    media.get(fid)
    if not isinstance(patch, dict):
        raise MediaError("Project data must be an object.")
    # Keep the local state bounded and JSON-only.
    encoded = json.dumps(patch, ensure_ascii=False)
    if len(encoded) > 5_000_000:
        raise MediaError("This project data is too large.")
    with _lock:
        all_projects = _load()
        current = all_projects.get(fid, {})
        current.update(json.loads(encoded))
        all_projects[fid] = current
        _write(all_projects)
    return current


def remove(fid):
    with _lock:
        all_projects = _load()
        if fid in all_projects:
            del all_projects[fid]
            _write(all_projects)


def signature(item):
    return {"size": item.get("size"), "created": item.get("created")}


def cached_analysis(fid, accurate):
    item = media.get(fid)
    project = get(fid)
    key = "analysis_accurate" if accurate else "analysis_fast"
    cached = project.get(key)
    return cached.get("report") if isinstance(cached, dict) and cached.get("signature") == signature(item) else None


def store_analysis(fid, accurate, report):
    key = "analysis_accurate" if accurate else "analysis_fast"
    save(fid, {key: {"signature": signature(media.get(fid)), "report": report}})


def export_archive(fid, destination):
    item = media.get(fid)
    manifest = {"version": 1, "name": item["name"], "ext": item["ext"], "project": get(fid)}
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(media.path_of(item), "audio." + item["ext"])
        archive.writestr("project.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    return destination


def import_archive(path):
    folder = os.path.join(media.TMP, "project-import-" + secrets.token_hex(6))
    os.makedirs(folder)
    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            if "project.json" not in names:
                raise MediaError("That archive has no Audio Studio project data.")
            if archive.getinfo("project.json").file_size > 5_000_000:
                raise MediaError("That project's metadata is too large.")
            manifest = json.loads(archive.read("project.json").decode("utf-8"))
            ext = str(manifest.get("ext", "")).lower()
            audio_name = "audio." + ext
            if ext not in media.AUDIO_EXT | media.VIDEO_EXT or audio_name not in names:
                raise MediaError("The project audio is missing or unsupported.")
            info = archive.getinfo(audio_name)
            if info.file_size > 2 * 1024 ** 3:
                raise MediaError("The project audio is bigger than 2 GB.")
            extracted = os.path.join(folder, audio_name)
            with archive.open(audio_name) as source, open(extracted, "wb") as target:
                shutil.copyfileobj(source, target)
        fid, destination = media.new_path(ext)
        shutil.copy2(extracted, destination)
        item = media.register(fid, ext, manifest.get("name") or "Imported project", "project import")
        project = manifest.get("project") if isinstance(manifest.get("project"), dict) else {}
        save(fid, project)
        return item, project
    except (zipfile.BadZipFile, ValueError, KeyError) as exc:
        raise MediaError("This is not a valid Audio Studio project: %s" % str(exc)[:160])
    finally:
        shutil.rmtree(folder, ignore_errors=True)
