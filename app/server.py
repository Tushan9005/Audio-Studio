"""Audio Studio: a small local web app (http://127.0.0.1:8765), only reachable from this PC."""
import os, secrets, shutil, threading, time

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import media, ops, tune
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


def _tune_params(q):
    return {k: q.get(k) for k in ("key", "scale", "strength", "style", "ref")}


@app.get("/api/layer_stem/{fid}")
def layer_stem(fid: str, request: Request):
    """One vocal layer's audio for the live preview: the same file the final render mixes."""
    q = request.query_params
    return FileResponse(ops.layer_stem(fid, q.get("shift"), q.get("voice") or "fixed", _tune_params(q), q.get("seed")), media_type="audio/wav")


@app.get("/api/fx_suggest/{fid}")
def fx_suggest(fid: str):
    """Which Instagram cover preset suits this recording (tone balance and dynamics), with the reason."""
    return ops.fx_suggest(fid)


# ── tune (pitch correction) ──
@app.get("/api/tune/info/{fid}")
def tune_info(fid: str):
    media.get(fid)
    return {"info": tune.info(fid), "scales": {k: v[0] for k, v in tune.SCALES.items()}, "voices": {k: v[0] for k, v in tune.VOICES.items()}}


@app.post("/api/tune/prepare")
async def tune_prepare(request: Request):
    p = await request.json()
    ops.need(media.get(p.get("id")), "audio", "video")
    return {"job": _start_job(lambda progress, stage: tune.prepare(p.get("id"), p.get("together"), progress, stage), "tune_prepare", p.get("id"))}


@app.get("/api/tune/summary/{fid}")
def tune_summary(fid: str, request: Request):
    return tune.summary(fid, _tune_params(request.query_params))


@app.get("/api/tune/audio/{fid}")
def tune_audio(fid: str, request: Request):
    """The tuned song (voice + guitar) for the live preview: the same file Save adds to the library."""
    return FileResponse(tune.mix(fid, _tune_params(request.query_params)), media_type="audio/wav")


# ── tools: every tool runs as a background job, so the page never freezes ──
LABELS = {"trim": "Keep only this part", "cut": "Remove a part", "fade": "Fades", "volume": "Volume", "loop": "Loop",
          "join": "Join files", "export": "Save as", "extract": "Take the sound out", "effects": "Effects",
          "effects_video": "Polish video sound", "best": "Best part", "video_music": "Music under video",
          "beat_reel": "Beat reel", "practice": "Practice copy", "voice": "Voiceover", "vocal_layers": "Vocal layers mix",
          "tune": "Save tuned version", "analyse": "Tempo & key", "sound_check": "Sound check",
          "split": "Split song", "tune_prepare": "Analyse singing"}


@app.post("/api/do/{action}")
async def do(action: str, request: Request):
    """Starts a tool as a background job and returns {"job": id} at once (add ?wait=1 to get the result directly)."""
    p = await request.json()
    f = p.get("id")
    acts = {
        "vocal_layers": lambda: ops.vocal_layers(f, p.get("layers"), p.get("tune")),
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
    if action not in acts and action not in ("analyse", "tune", "sound_check"):
        raise MediaError("Unknown tool.")

    def run(progress, stage):
        if action == "analyse":
            return {"analysis": ops.analyse(f)}
        if action == "sound_check":
            return {"sound_check": ops.sound_check(f)}
        if action == "tune":
            files = tune.save(f, p)
            return {"file": files[0], "files": files}
        return {"file": acts[action]()}

    if request.query_params.get("wait"):
        return await run_in_threadpool(run, lambda x: None, lambda s: None)
    fid = f or (p.get("ids") or p.get("clips") or [None])[0]
    return {"job": _start_job(run, action, fid, determinate=False)}


# ── background jobs: the page polls /api/jobs for progress and results ──
JOBS = {}


@app.post("/api/split")
async def split(request: Request):
    p = await request.json()
    ops.need(media.get(p.get("id")), "audio", "video")

    def run(progress, stage):
        files = ops.split(p.get("id"), p.get("stems") or [], progress, stage)
        return {"file": files[0] if files else None, "files": files}
    return {"job": _start_job(run, "split", p.get("id"))}


def _start_job(fn, action, fid=None, determinate=True):
    """Runs fn(progress, stage) in a background thread. progress(x) is 0..1 (None = unknown); stage(text) says
    what it is waiting for. Finished jobs are kept for an hour so a reloaded page can still show them."""
    jid = secrets.token_hex(6)
    try:
        fname = media.get(fid)["name"] if fid else ""
    except MediaError:
        fname = ""
    job = JOBS[jid] = {"id": jid, "action": action, "label": LABELS.get(action, action), "fid": fid, "fname": fname,
                       "progress": 0.0 if determinate else None, "stage": None, "done": False, "error": None,
                       "result": None, "started": time.time(), "finished": None}

    def work():
        try:
            job["result"] = fn(lambda x: job.update(progress=round(x, 3)), lambda s: job.update(stage=s))
        except MediaError as e:
            job["error"] = str(e)
        except Exception as e:
            job["error"] = "Something went wrong: %s" % str(e)[:300]
        finally:
            job["finished"] = time.time()
            job["done"] = True

    threading.Thread(target=work, daemon=True).start()
    for k in [k for k, j in JOBS.items() if j["done"] and time.time() - j["started"] > 3600]:
        JOBS.pop(k, None)
    return jid


def _job_view(j):
    return {**j, "elapsed": round((j["finished"] or time.time()) - j["started"], 1)}


@app.get("/api/jobs")
def jobs():
    return {"jobs": [_job_view(j) for j in sorted(JOBS.values(), key=lambda j: j["started"])]}


@app.get("/api/jobs/{jid}")
def job(jid: str):
    j = JOBS.get(jid)
    if not j:
        raise MediaError("That job is gone (was the app restarted?).")
    return _job_view(j)


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
