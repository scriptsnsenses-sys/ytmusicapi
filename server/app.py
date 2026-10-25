"""WebTube API.

Run locally:
    uvicorn server.app:app --host 0.0.0.0 --port 8000

Render uses:
    uvicorn server.app:app --host 0.0.0.0 --port $PORT

YouTube Music auth (optional, only needed for library / private endpoints):
    YTMUSIC_AUTH        JSON string (browser headers or oauth token) OR path to auth file
    YTMUSIC_AUTH_FILE   path to headers.json / oauth.json (alternative to YTMUSIC_AUTH)
    YTMUSIC_LANGUAGE    default "en"
    YTMUSIC_LOCATION    default "" (auto)
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .music import router as music_router
from .youtube import router as youtube_router

app = FastAPI(title="WebTube API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

app.include_router(music_router)
app.include_router(youtube_router)


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(str(STATIC_DIR / "manifest.webmanifest"), media_type="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    # Must be served from the root scope so it can control the whole app.
    return FileResponse(str(STATIC_DIR / "sw.js"), media_type="application/javascript")


@app.get("/")
def root():
    index = STATIC_DIR / "index.html"
    if index.is_file():
        return FileResponse(str(index))
    return {"service": "webtube", "health": "/health", "player": "static files missing"}


@app.get("/api")
def api_info():
    return {
        "service": "webtube",
        "docs": "/docs",
        "health": "/health",
        "endpoints": [
            "/search",
            "/artist/{channel_id}",
            "/album/{browse_id}",
            "/song/{video_id}",
            "/playlist/{playlist_id}",
            "/watch",
            "/lyrics",
            "/yt/home",
            "/yt/search",
            "/yt/video/{video_id}",
            "/yt/streams/{video_id}",
            "/yt/stream/{video_id}/{kind}",
        ],
    }


@app.get("/health")
def health():
    return {"status": "ok"}
