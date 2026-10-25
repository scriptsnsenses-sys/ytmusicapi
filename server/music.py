"""YouTube Music API routes powered by ytmusicapi."""

import json
import os
from dataclasses import asdict, is_dataclass
from functools import lru_cache

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from ytmusicapi import YTMusic
from ytmusicapi.exceptions import YTMusicServerError, YTMusicUserError

router = APIRouter()


def _resolve_auth():
    auth_file = os.environ.get("YTMUSIC_AUTH_FILE")
    if auth_file:
        return auth_file
    auth = os.environ.get("YTMUSIC_AUTH")
    if not auth:
        return None
    auth = auth.strip()
    if auth.startswith("{"):
        try:
            return json.loads(auth)
        except json.JSONDecodeError:
            return auth
    return auth


@lru_cache(maxsize=1)
def get_client() -> YTMusic:
    try:
        return YTMusic(
            auth=_resolve_auth(),
            language=os.environ.get("YTMUSIC_LANGUAGE", "en"),
            location=os.environ.get("YTMUSIC_LOCATION", ""),
        )
    except Exception as exc:
        raise RuntimeError(f"Failed to init YTMusic: {exc}") from exc


def _jsonable(obj):
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if is_dataclass(obj):
        return _jsonable(asdict(obj))
    if isinstance(obj, dict):
        return {key: _jsonable(value) for key, value in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(value) for value in obj]
    return obj


def _call(fn, *args, **kwargs):
    try:
        return _jsonable(fn(*args, **kwargs))
    except YTMusicUserError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except YTMusicServerError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")


@router.get("/search")
def search(
    q: str = Query(..., description="Search query, e.g. 'Oasis Wonderwall'"),
    filter: str | None = Query(None, description="songs|videos|albums|artists|playlists|..."),
    scope: str | None = Query(None, description="library|uploads"),
    limit: int = Query(20, ge=1, le=100),
    ignore_spelling: bool = False,
):
    yt = get_client()
    return JSONResponse(_call(yt.search, q, filter=filter, scope=scope, limit=limit, ignore_spelling=ignore_spelling))


@router.get("/artist/{channel_id}")
def artist(channel_id: str):
    return JSONResponse(_call(get_client().get_artist, channel_id))


@router.get("/album/{browse_id}")
def album(browse_id: str):
    return JSONResponse(_call(get_client().get_album, browse_id))


@router.get("/song/{video_id}")
def song(video_id: str):
    return JSONResponse(_call(get_client().get_song, video_id))


@router.get("/playlist/{playlist_id}")
def playlist(playlist_id: str, limit: int | None = Query(100, ge=1, le=5000)):
    return JSONResponse(_call(get_client().get_playlist, playlist_id, limit=limit))


@router.get("/watch")
def watch(
    videoId: str | None = Query(None),
    playlistId: str | None = Query(None),
    limit: int = Query(25, ge=1, le=100),
    radio: bool = False,
    shuffle: bool = False,
):
    if not videoId and not playlistId:
        raise HTTPException(status_code=400, detail="Provide videoId and/or playlistId")
    return JSONResponse(
        _call(
            get_client().get_watch_playlist,
            videoId=videoId,
            playlistId=playlistId,
            limit=limit,
            radio=radio,
            shuffle=shuffle,
        )
    )


@router.get("/lyrics")
def lyrics(
    browseId: str | None = Query(None, description="lyrics browseId from get_watch_playlist (MPLYt...)"),
    videoId: str | None = Query(None, description="videoId of the track; the lyrics id is resolved automatically"),
):
    yt = get_client()
    if not browseId and videoId:
        watch_data = _call(yt.get_watch_playlist, videoId=videoId, limit=1)
        browseId = (watch_data or {}).get("lyrics")
        if not browseId:
            raise HTTPException(status_code=404, detail="No lyrics available for this track")
    if not browseId:
        raise HTTPException(status_code=400, detail="Provide browseId or videoId")
    data = _call(yt.get_lyrics, browseId)
    if not data:
        raise HTTPException(status_code=404, detail="No lyrics found for this track")
    return JSONResponse(data)
