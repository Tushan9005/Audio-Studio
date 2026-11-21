"""Audio Studio: a small local web app (http://127.0.0.1:8765), only reachable from this PC."""
import os, secrets, shutil, threading, time

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import media, ops
from .media import MediaError

PORT = int(os.environ.get("STUDIO_PORT", "8765"))
STATIC = os.path.join(media.ROOT, "static")
MAX_UPLOAD = 2 * 1024 ** 3   # 2 GB per file
app = FastAPI(title="Audio Studio", docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def local_only(request: Request, call_next):
    # Only this PC, and only pages served by the studio itself: stops other websites (DNS rebinding,
    # cross-site posts) from driving the app while it is open.
    host = (request.headers.get("host") or "").split(":")[0]
    if host not in ("127.0.0.1", "localhost"):
        return JSONResponse({"error": "Not allowed"}, status_code=403)
    origin = request.headers.get("origin")
    if origin and origin not in ("http://127.0.0.1:%d" % PORT, "http://localhost:%d" % PORT):
        return JSONResponse({"error": "Not allowed"}, status_code=403)
    return await call_next(request)


@app.exception_handler(MediaError)
async def media_error(_req, exc):
    return JSONResponse({"error": str(exc)}, status_code=400)


@app.exception_handler(Exception)
async def any_error(_req, exc):
    return JSONResponse({"error": "Something went wrong: %s" % str(exc)[:300]}, status_code=500)


# ── library ──
@app.get("/api/files")
def files():
    return {"files": media.list_files(), "voices": ops.VOICES, "presets": {k: v["label"] for k, v in ops.PRESETS.items()},
            "preset_values": ops.PRESETS}


@app.post("/api/upload")
async def upload(files: list[UploadFile] = File(...)):
    out = []
    for up in files[:20]:
        name = media.clean_name(up.filename or "upload")
        ext = (name.rsplit(".", 1)[-1] if "." in name else "").lower()
        if ext not in media.AUDIO_EXT | media.VIDEO_EXT | media.IMAGE_EXT:
            raise MediaError("%s: this type of file isn't supported." % name)
        fid, path = media.new_path(ext)
        size = 0
        with open(path, "wb") as fh:
            while True:
                chunk = await up.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_UPLOAD:
                    fh.close(); os.remove(path)
                    raise MediaError("%s is bigger than 2 GB." % name)
                fh.write(chunk)
        try:
            out.append(media.register(fid, ext, name.rsplit(".", 1)[0] if "." in name else name, "upload"))
        except MediaError:
            os.remove(path)
            raise
    return {"files": out}


@app.post("/api/record")
async def record(file: UploadFile = File(...), name: str = "Recording"):
    """A take recorded in the browser (WebM/Ogg); stored as WAV so every tool can use it."""
    raw = os.path.join(media.TMP, "rec-%s.webm" % os.urandom(4).hex())
    with open(raw, "wb") as fh:
        shutil.copyfileobj(file.file, fh)
    try:
        fid, out = media.new_path("wav")
        media.run(["-i", raw, "-vn"] + ops.WAV + [out])
        return {"file": media.register(fid, "wav", name or "Recording", "record")}
    finally:
        os.remove(raw)


@app.post("/api/files/{fid}/rename")
async def rename(fid: str, request: Request):
    media.get(fid)
    media.rename(fid, (await request.json()).get("name", ""))
    return {"ok": True}


@app.delete("/api/files/{fid}")
def remove(fid: str):
    media.delete(fid)
    return {"ok": True}


@app.get("/media/{fid}")
def stream(fid: str):
    it = media.get(fid)
    return FileResponse(media.path_of(it))


@app.get("/download/{fid}")
def download(fid: str):
    it = media.get(fid)
    return FileResponse(media.path_of(it), filename="%s.%s" % (it["name"], it["ext"]))


# ── tools ──
@app.post("/api/do/{action}")
async def do(action: str, request: Request):
    p = await request.json()
    f = p.get("id")
    acts = {
        "vocal_layers": lambda: ops.vocal_layers(f, p.get("layers")),
        "trim": lambda: ops.trim(f, p.get("start"), p.get("end")),
        "cut": lambda: ops.cut_out(f, p.get("start"), p.get("end")),
        "fade": lambda: ops.fades(f, p.get("fade_in"), p.get("fade_out")),
        "volume": lambda: ops.volume(f, p.get("db")),
        "loop": lambda: ops.loop(f, p.get("times")),
        "join": lambda: ops.join(p.get("ids") or [], p.get("crossfade")),
        "export": lambda: ops.export(f, p.get("format"), p.get("quality")),
        "extract": lambda: ops.extract_audio(f),
        "effects": lambda: ops.effects(f, p.get("fx") or {}),
        "effects_video": lambda: ops.effects_video(f, p.get("fx") or {}),
        "best": lambda: ops.best_part(f, p.get("length")),
        "video_music": lambda: ops.music_under_video(f, p.get("music"), p),
        "beat_reel": lambda: ops.beat_reel(p.get("clips") or [], p.get("music"), p),
        "practice": lambda: ops.practice_copy(f, p.get("rate"), p.get("start"), p.get("end")),
        "voice": lambda: ops.voiceover(p.get("text"), p.get("voice"), p.get("speed"), p.get("music") or None, p.get("music_db"), p.get("music_from")),
    }
    if action == "analyse":
        return {"analysis": await run_in_threadpool(ops.analyse, f)}
    if action == "sound_check":
        return {"sound_check": await run_in_threadpool(ops.sound_check, f)}
    if action not in acts:
        raise MediaError("Unknown tool.")
    return {"file": await run_in_threadpool(acts[action])}   # long jobs don't freeze the app


# ── long jobs (song splitting): run in the background, the page asks for progress ──
JOBS = {}


@app.post("/api/split")
async def split(request: Request):
    p = await request.json()
    ops.need(media.get(p.get("id")), "audio", "video")
    jid = secrets.token_hex(6)
    job = JOBS[jid] = {"progress": 0.0, "done": False, "error": None, "files": [], "started": time.time()}

    def work():
        try:
            job["files"] = ops.split(p.get("id"), p.get("stems") or [], progress=lambda x: job.update(progress=round(x, 3)))
        except MediaError as e:
            job["error"] = str(e)
        except Exception as e:
            job["error"] = "Something went wrong: %s" % str(e)[:300]
        finally:
            job["done"] = True

    threading.Thread(target=work, daemon=True).start()
    for k in [k for k, j in JOBS.items() if j["done"] and time.time() - j["started"] > 3600]:
        JOBS.pop(k, None)
    return {"job": jid}


@app.get("/api/jobs/{jid}")
def job(jid: str):
    j = JOBS.get(jid)
    if not j:
        raise MediaError("That job is gone (was the app restarted?).")
    return {**j, "elapsed": round(time.time() - j["started"], 1)}


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
