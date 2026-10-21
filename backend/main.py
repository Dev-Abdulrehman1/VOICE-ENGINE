"""Voice Engine backend: turns a script into speech via OpenRouter TTS + keeps history.

Run from the project root:
    uvicorn backend.main:app --reload
"""

import os
import re
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional

from dotenv import load_dotenv

# Must happen before importing backend.db (it reads DATA_DIR at import time).
load_dotenv()

import httpx  # noqa: E402
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from backend import db  # noqa: E402

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "").strip()
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "fish-audio/s2.1-pro-free:free").strip()
OPENROUTER_BASE_URL = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")
ACCESS_KEY = os.getenv("ACCESS_KEY", "").strip()
REQUEST_TIMEOUT = float(os.getenv("REQUEST_TIMEOUT", "180"))
MAX_CHARS = int(os.getenv("MAX_CHARS", "4000"))
AUDIO_FORMAT = os.getenv("AUDIO_FORMAT", "mp3").strip().lower()

MEDIA_TYPES = {"mp3": "audio/mpeg", "pcm": "audio/pcm", "wav": "audio/wav"}
GEN_ID_RE = re.compile(r"^[0-9a-f]{32}$")

# Fail closed: no access key means no app.
if not ACCESS_KEY:
    raise RuntimeError("ACCESS_KEY is not set. Copy .env.example to .env and set a strong access key.")
if not OPENROUTER_API_KEY:
    raise RuntimeError("OPENROUTER_API_KEY is not set. Add your OpenRouter key to .env.")


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="Voice Engine", lifespan=lifespan)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    else:
        # Revalidate the shell and static assets so UI edits show up without a hard refresh.
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


def require_access_key(x_access_key: Optional[str] = Header(default=None)) -> None:
    """Every /api route below is gated by the key typed in the UI."""
    if not x_access_key or not secrets.compare_digest(x_access_key, ACCESS_KEY):
        raise HTTPException(status_code=401, detail="Invalid or missing access key")


class GenerateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_CHARS)
    voice: Optional[str] = None
    instructions: Optional[str] = None


def public_view(record: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """API shape for a history row: never leaks stored file paths."""
    if record is None:
        return None
    ready = record["status"] == "ready"
    return {
        "id": record["id"],
        "text": record["text"],
        "model": record["model"],
        "voice": record["voice"],
        "instructions": record["instructions"],
        "format": record["format"],
        "byte_size": record["byte_size"],
        "duration_ms": record["duration_ms"],
        "status": record["status"],
        "error": record["error"],
        "created_at": record["created_at"],
        "audio_url": f"/api/audio/{record['id']}" if ready else None,
    }


def openrouter_error(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return (response.text or "").strip()[:400] or f"HTTP {response.status_code}"
    error = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(error, dict):
        return str(error.get("message") or error)[:400]
    if error:
        return str(error)[:400]
    return str(payload)[:400]


@app.get("/api/health")
async def health() -> Dict[str, Any]:
    return {"ok": True, "model": OPENROUTER_MODEL}


@app.get("/api/config", dependencies=[Depends(require_access_key)])
async def config() -> Dict[str, Any]:
    return {"model": OPENROUTER_MODEL, "max_chars": MAX_CHARS, "format": AUDIO_FORMAT}


@app.post("/api/generate", dependencies=[Depends(require_access_key)])
async def generate(payload: GenerateRequest) -> Dict[str, Any]:
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Script is empty")
    if len(text) > MAX_CHARS:
        raise HTTPException(status_code=400, detail=f"Script is longer than {MAX_CHARS} characters")

    gen_id = uuid.uuid4().hex
    db.create_generation(
        gen_id=gen_id,
        text=text,
        model=OPENROUTER_MODEL,
        voice=payload.voice,
        instructions=payload.instructions,
        audio_format=AUDIO_FORMAT,
    )

    body: Dict[str, Any] = {
        "model": OPENROUTER_MODEL,
        "input": text,
        "response_format": AUDIO_FORMAT,
    }
    if payload.voice:
        body["voice"] = payload.voice
    if payload.instructions:
        body["instructions"] = payload.instructions

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "X-Title": "Voice Engine",
    }

    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            response = await client.post(f"{OPENROUTER_BASE_URL}/audio/speech", json=body, headers=headers)
    except httpx.HTTPError as exc:
        message = f"Could not reach OpenRouter: {exc}"
        db.fail_generation(gen_id, message)
        raise HTTPException(status_code=502, detail=message) from exc

    if response.status_code != 200:
        message = openrouter_error(response)
        db.fail_generation(gen_id, f"OpenRouter {response.status_code}: {message}")
        status = response.status_code if 400 <= response.status_code < 500 else 502
        raise HTTPException(status_code=status, detail=f"OpenRouter {response.status_code}: {message}")

    audio = response.content
    if not audio:
        message = "OpenRouter returned an empty audio stream"
        db.fail_generation(gen_id, message)
        raise HTTPException(status_code=502, detail=message)

    file_name = f"{gen_id}.{AUDIO_FORMAT}"
    db.audio_path(file_name).write_bytes(audio)
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    record = db.finish_generation(
        gen_id,
        file_name=file_name,
        byte_size=len(audio),
        duration_ms=elapsed_ms,
        provider_id=response.headers.get("x-generation-id"),
    )
    return public_view(record) or {}


@app.get("/api/history", dependencies=[Depends(require_access_key)])
async def history(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> Dict[str, Any]:
    return {
        "items": [public_view(row) for row in db.list_generations(limit=limit, offset=offset)],
        "total": db.count_generations(),
        "limit": limit,
        "offset": offset,
    }


@app.delete("/api/history/{gen_id}", dependencies=[Depends(require_access_key)])
async def delete_history_item(gen_id: str) -> Dict[str, Any]:
    if not GEN_ID_RE.match(gen_id):
        raise HTTPException(status_code=404, detail="Not found")
    record = db.get_generation(gen_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Not found")
    if not db.delete_generation(gen_id):
        raise HTTPException(status_code=404, detail="Not found")
    if record.get("file_name"):
        db.audio_path(record["file_name"]).unlink(missing_ok=True)
    return {"deleted": gen_id}


@app.get("/api/audio/{gen_id}", dependencies=[Depends(require_access_key)])
async def get_audio(gen_id: str) -> FileResponse:
    if not GEN_ID_RE.match(gen_id):
        raise HTTPException(status_code=404, detail="Not found")
    record = db.get_generation(gen_id)
    if record is None or record["status"] != "ready" or not record.get("file_name"):
        raise HTTPException(status_code=404, detail="Audio not found")
    path = db.audio_path(record["file_name"])
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Audio file is missing on disk")
    return FileResponse(
        path,
        media_type=MEDIA_TYPES.get(record["format"], "application/octet-stream"),
        filename=record["file_name"],
    )


# Static UI is mounted last so the /api routes above win. On Vercel the same
# files are served by the CDN from public/, so only mount when they are present.
if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
