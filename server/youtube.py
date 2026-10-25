"""YouTube video mode backed directly by YouTube's InnerTube API.

No external bridge required: search runs through the WEB client and video
details/streams through the ANDROID client, which returns direct (unciphered)
googlevideo URLs. IOS and WEB act as fallbacks; WEB streams arrive
signature-encrypted, so a compact decipherer is included.

Optional environment variables:
    YOUTUBE_COOKIE      cookie header string sent with InnerTube requests
                        (bot-check mitigation on datacenter IPs)
    YOUTUBE_PO_TOKEN    service integrity token appended to player requests
    YOUTUBE_CLIENT      force a single client (android|android_gapi|android_music|
                        android_vr|web_embedded|ios|web) for debugging
"""

import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from urllib.parse import parse_qs, quote

import requests
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

router = APIRouter()

_CACHE = {}
_CACHE_TTL = 600
_HOME_QUERIES = [
    ("Trending now", "trending videos"),
    ("Technology", "technology"),
    ("Gaming", "gaming"),
    ("News & politics", "news"),
    ("Comedy", "comedy"),
    ("Sports", "sports highlights"),
    ("Movies & trailers", "movie trailers"),
]
_STREAM_KINDS = {"muxed", "video", "audio"}
_STREAM_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "*/*",
    "Origin": "https://www.youtube.com",
    "Referer": "https://www.youtube.com/",
}
_SEARCH_PARAMS_VIDEOS = "EgIQAQ=="  # videos-only search filter

_UA_CHROME = _STREAM_HEADERS["User-Agent"]
_INNERTUBE_HOST = "https://www.youtube.com/youtubei/v1"
_INNERTUBE_GOOGLEAPIS_HOST = "https://youtubei.googleapis.com/youtubei/v1"
_INNERTUBE_MUSIC_HOST = "https://music.youtube.com/youtubei/v1"

# client: (clientName, clientVersion, extra context, apiKey, user agent, host)
_INNERTUBE_CLIENTS = {
    "android": (
        "ANDROID",
        "20.10.38",
        {"androidSdkVersion": 30, "hl": "en", "gl": "US"},
        "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w",
        "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
        _INNERTUBE_HOST,
    ),
    # The VR client historically serves unciphered streams without a PO token,
    # even from datacenter IPs.
    "android_vr": (
        "ANDROID_VR",
        "1.61.48",
        {"androidSdkVersion": 32, "hl": "en", "gl": "US"},
        "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w",
        (
            "com.google.android.apps.youtube.vr.oculus/1.61.48"
            " (Linux; U; Android 12; eureka-user Build/SQ3A.220705.004.A1) gzip"
        ),
        _INNERTUBE_HOST,
    ),
    # Same ANDROID client, but on the host the native app actually uses.
    "android_gapi": (
        "ANDROID",
        "20.10.38",
        {"androidSdkVersion": 30, "hl": "en", "gl": "US"},
        "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w",
        "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
        _INNERTUBE_GOOGLEAPIS_HOST,
    ),
    # Embedded web player: only serves embeddable videos, but is gated less
    # aggressively than the plain WEB client.
    "web_embedded": (
        "WEB_EMBEDDED_PLAYER",
        "1.20250116.01.00",
        {"hl": "en", "gl": "US"},
        "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
        _UA_CHROME,
        _INNERTUBE_HOST,
    ),
    # Music clients run on music.youtube.com, which gates datacenter IPs
    # far less aggressively (music search already works from Render).
    "android_music": (
        "ANDROID_MUSIC",
        "8.02.53",
        {"androidSdkVersion": 34, "hl": "en", "gl": "US"},
        "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w",
        "com.google.android.apps.youtube.music/8.02.53 (Linux; U; Android 13) gzip",
        _INNERTUBE_MUSIC_HOST,
    ),
    "ios": (
        "IOS",
        "20.10.4",
        {
            "deviceMake": "Apple",
            "deviceModel": "iPhone16,2",
            "osName": "iPhone",
            "osVersion": "17.5.1.21F90",
            "hl": "en",
            "gl": "US",
        },
        "AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc",
        "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)",
        _INNERTUBE_HOST,
    ),
    "web": (
        "WEB",
        "2.20250110.01.00",
        {"hl": "en", "gl": "US"},
        "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
        _UA_CHROME,
        _INNERTUBE_HOST,
    ),
    # YouTube Studio creator app: historically exempt from the bot check
    # and from PO-token requirements on adaptive formats.
    "android_creator": (
        "ANDROID_CREATOR",
        "24.45.100",
        {"androidSdkVersion": 30, "hl": "en", "gl": "US"},
        "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w",
        "com.google.android.apps.youtube.creator/24.45.100 (Linux; U; Android 11) gzip",
        _INNERTUBE_GOOGLEAPIS_HOST,
    ),
    # The WEB_REMIX client ytmusicapi itself uses: keyless, on the music
    # host, and demonstrably reachable from Render's datacenter IP.
    "web_music": (
        "WEB_REMIX",
        "1." + time.strftime("%Y%m%d", time.gmtime()) + ".01.00",
        {"hl": "en", "gl": "US"},
        "",
        _UA_CHROME,
        _INNERTUBE_MUSIC_HOST,
    ),
}
_CLIENT_ORDER = [
    "android",
    "android_gapi",
    "android_creator",
    "android_music",
    "web_music",
    "android_vr",
    "web_embedded",
    "ios",
    "web",
]
# android and android_gapi are verified to return direct unciphered URLs;
# the rest are best-effort fallbacks for stricter networks.

_SESSION = requests.Session()
_COOKIE = os.environ.get("YOUTUBE_COOKIE", "").strip()
_PO_TOKEN = os.environ.get("YOUTUBE_PO_TOKEN", "").strip()
_FORCED_CLIENT = os.environ.get("YOUTUBE_CLIENT", "").strip().lower()
if _FORCED_CLIENT and _FORCED_CLIENT not in _INNERTUBE_CLIENTS:
    _FORCED_CLIENT = ""


def _clients():
    if _FORCED_CLIENT:
        return [_FORCED_CLIENT]
    return _CLIENT_ORDER


def _innertube(client_key, endpoint, payload, timeout=30):
    name, version, extra, api_key, user_agent, host = _INNERTUBE_CLIENTS[client_key]
    query = f"key={api_key}&" if api_key else ""
    url = f"{host}/{endpoint}?{query}alt=json&prettyPrint=false"
    context = {"client": {"clientName": name, "clientVersion": version, **extra}}
    if client_key in ("web", "web_embedded"):
        context["thirdParty"] = {"embedUrl": "https://www.youtube.com/"}
    origin = "https://music.youtube.com" if "music.youtube.com" in host else "https://www.youtube.com"
    headers = {
        "User-Agent": user_agent,
        "Content-Type": "application/json",
        "Accept": "*/*",
        "Origin": origin,
        "Referer": origin + "/",
        "X-Youtube-Client-Name": name,
        "X-Youtube-Client-Version": version,
    }
    if _COOKIE:
        headers["Cookie"] = _COOKIE
    if _PO_TOKEN and endpoint == "player":
        context["serviceIntegrityDimensions"] = {"poToken": _PO_TOKEN}
    response = _SESSION.post(url, json={"context": context, **payload}, headers=headers, timeout=timeout)
    if response.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"YouTube InnerTube {client_key} {endpoint} returned {response.status_code}",
        )
    return response.json()


def _text(runs):
    """Flatten a YouTube text node (runs | simpleText) to a string."""
    if not runs:
        return ""
    if "simpleText" in runs:
        return runs["simpleText"]
    return "".join(part.get("text", "") for part in runs.get("runs", []))


def _best_thumbnail(node):
    thumbnails = (node or {}).get("thumbnails", [])
    return (
        max(thumbnails, key=lambda t: t.get("width", 0) * t.get("height", 0)).get("url", "")
        if thumbnails
        else ""
    )


def _format_duration(seconds):
    if seconds is None or seconds < 0:
        return "LIVE"
    seconds = int(seconds)
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


# --------------------------------------------------------------------------
# Signature deciphering (WEB client fallback)
# --------------------------------------------------------------------------

_DECIPHER_CACHE = {}


def _extract_braced(source, open_index):
    """Return the source between the braces starting at open_index."""
    depth = 0
    for index in range(open_index, len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[open_index + 1 : index]
    return ""


def _parse_decipher_program(player_js):
    """Extract the decipher function body and its helper functions."""
    match = re.search(
        r'([\w$]+)\s*=\s*function\(\s*([\w$]+)\s*\)\s*\{\s*\2\s*=\s*\2\.split\(\s*""\s*\)',
        player_js,
    )
    if not match:
        return None
    body_open = player_js.index("{", match.end() - 1)
    body = _extract_braced(player_js, body_open)

    helpers = {}
    for helper_match in re.finditer(r"([\w$.]+)\(\s*[\w$]+\s*(?:,\s*(?:[\w$]+|\d+)\s*)?\)", body):
        helper_name = helper_match.group(1)
        if helper_name.endswith((".reverse", ".split", ".join", ".splice")):
            continue
        if helper_name in helpers:
            continue
        # Helper lives either as an object method or a standalone function.
        escaped = re.escape(helper_name)
        definition = re.search(rf"{escaped}\s*:\s*function\s*\([^)]*\)\s*\{{", player_js) or re.search(
            rf"function\s+{escaped}\s*\([^)]*\)\s*\{{", player_js
        )
        if not definition:
            continue
        helper_body = _extract_braced(player_js, player_js.index("{", definition.end() - 1))
        if "reverse" in helper_body:
            helpers[helper_name] = ("reverse", 0)
        elif "splice" in helper_body:
            amounts = re.findall(r"splice\(\s*\d+\s*,\s*(\d+)\s*\)", helper_body)
            helpers[helper_name] = ("splice", int(amounts[0]) if amounts else 0)
        elif "%" in helper_body:  # swap: a[0] <-> a[b % a.length]
            helpers[helper_name] = ("swap", 0)
    return {"body": body, "helpers": helpers}


def _decipher_signature(signature, player_js):
    """Return the deciphered signature, or None when the JS yields no program."""
    program = _DECIPHER_CACHE.get(player_js)
    if program is None:
        program = _parse_decipher_program(player_js)
        _DECIPHER_CACHE[player_js] = program
    if not program:
        return None

    chars = list(signature)
    for statement in re.findall(r"([\w$.]+)\(\s*[\w$]+\s*(?:,\s*([\w$]+|\d+)\s*)?\)", program["body"]):
        name, argument = statement
        amount = int(argument) if argument and argument.isdigit() else 0
        if name.endswith(".reverse"):
            chars.reverse()
        elif name.endswith(".splice"):
            if amount:
                del chars[:amount]
        elif name in program["helpers"]:
            operation = program["helpers"][name][0]
            if operation == "reverse":
                chars.reverse()
            elif operation == "splice" and amount:
                del chars[:amount]
            elif operation == "swap" and chars:
                index = amount % len(chars)
                chars[0], chars[index] = chars[index], chars[0]
    return "".join(chars)


def _player_js_url(video_id):
    """Locate the base.js player URL from the watch page."""
    response = _SESSION.get(
        f"https://www.youtube.com/watch?v={quote(video_id, safe='')}",
        headers={"User-Agent": _UA_CHROME, "Accept-Language": "en-US,en;q=0.9"},
        timeout=30,
    )
    match = re.search(r'"jsUrl"\s*:\s*"(/s/player/[^"]+)"', response.text)
    if not match:
        match = re.search(r"(/s/player/[0-9a-fA-F]+/base\.js)", response.text)
    return f"https://www.youtube.com{match.group(1)}" if match else None


_PLAYER_JS_CACHE = {"js": None, "ts": 0.0}


def _player_js():
    """Fetch and cache the current web player JavaScript (for STS + deciphering)."""
    if _PLAYER_JS_CACHE["js"] and time.monotonic() - _PLAYER_JS_CACHE["ts"] < 3600:
        return _PLAYER_JS_CACHE["js"]
    js_url = _player_js_url("aqz-KE-bpKQ")
    if not js_url:
        return None
    response = _SESSION.get(js_url, headers={"User-Agent": _UA_CHROME}, timeout=30)
    if response.status_code != 200:
        return None
    _PLAYER_JS_CACHE.update(js=response.text, ts=time.monotonic())
    return response.text


def _signature_timestamp():
    js = _player_js()
    if not js:
        return ""
    match = re.search(r"signatureTimestamp[:=]\s*(\d+)", js)
    return match.group(1) if match else ""


def _uncipher_format(stream, player_js):
    """Resolve signatureCipher/ward urls in place; return True on success."""
    ciphered = stream.get("signatureCipher") or stream.get("cipher")
    if not ciphered:
        return bool(stream.get("url"))
    parts = {key: values[0] for key, values in parse_qs(ciphered).items()}
    url = parts.get("url", "")
    signature = parts.get("s", "")
    if not url or not signature or not player_js:
        return False
    deciphered = _decipher_signature(signature, player_js)
    if deciphered is None:
        # Current player JS may not expose a decipher program at all; a raw
        # signature would yield a URL that always 403s, so drop the stream.
        return False
    if parts.get("sp", "signature"):
        url += f"&{parts.get('sp', 'signature')}={quote(deciphered, safe='')}"
    stream["url"] = url
    return True


# --------------------------------------------------------------------------
# InnerTube queries
# --------------------------------------------------------------------------


def _search_items(payload):
    """Yield videoRenderer dicts from a search response (first page or continuation)."""
    if "contents" in payload:  # first page
        sections = (
            payload.get("contents", {})
            .get("twoColumnSearchResultsRenderer", {})
            .get("primaryContents", {})
            .get("sectionListRenderer", {})
            .get("contents", [])
        )
        containers = [item.get("itemSectionRenderer", {}).get("contents", []) for item in sections]
        tokens = [
            section.get("continuationItemRenderer", {})
            .get("continuationEndpoint", {})
            .get("continuationCommand", {})
            .get("token")
            for section in sections
        ]
    else:  # continuation page
        commands = payload.get("onResponseReceivedCommands", [])
        containers = [
            item.get("itemSectionRenderer", {}).get("contents", [])
            for command in commands
            for item in command.get("appendContinuationItemsAction", {}).get("continuationItems", [])
        ]
        tokens = [
            item.get("continuationItemRenderer", {})
            .get("continuationEndpoint", {})
            .get("continuationCommand", {})
            .get("token")
            for command in commands
            for item in command.get("appendContinuationItemsAction", {}).get("continuationItems", [])
        ]
    for container in containers:
        for item in container:
            renderer = item.get("videoRenderer")
            if renderer and renderer.get("videoId"):
                yield renderer
    yield from [f"token:{token}" for token in tokens if token]


def _parse_search_video(renderer):
    length = _text(renderer.get("lengthText"))
    is_live = bool(renderer.get("badges") and not length) or "LIVE" in length.upper()
    owner = renderer.get("ownerText") or renderer.get("longBylineText") or {}
    channel_runs = owner.get("runs", [])
    channel_id = ""
    if channel_runs:
        channel_id = (
            channel_runs[0].get("navigationEndpoint", {}).get("browseEndpoint", {}).get("browseId", "")
        )
    return {
        "videoId": renderer["videoId"],
        "title": _text(renderer.get("title")),
        "channel": _text(owner),
        "channelId": channel_id,
        "duration": length or "LIVE",
        "views": _text(renderer.get("shortViewCountText")),
        "publishDate": _text(renderer.get("publishedTimeText")),
        "thumbnail": _best_thumbnail(renderer.get("thumbnail")),
        "isLive": is_live,
        "status": "OK",
    }


def _innertube_search(query, limit):
    results = []
    payload = _innertube("web", "search", {"query": query, "params": _SEARCH_PARAMS_VIDEOS})
    pending_token = None
    for item in _search_items(payload):
        if isinstance(item, str) and item.startswith("token:"):
            pending_token = item[len("token:") :]
            continue
        video = _parse_search_video(item)
        if video["videoId"] not in {seen["videoId"] for seen in results}:
            results.append(video)
            if len(results) >= limit:
                return results
    while pending_token and len(results) < limit:
        payload = _innertube("web", "search", {"continuation": pending_token})
        before = len(results)
        pending_token = None
        for item in _search_items(payload):
            if isinstance(item, str) and item.startswith("token:"):
                pending_token = item[len("token:") :]
                continue
            video = _parse_search_video(item)
            if video["videoId"] not in {seen["videoId"] for seen in results}:
                results.append(video)
                if len(results) >= limit:
                    return results
        if len(results) == before:  # no progress, avoid looping forever
            break
    return results


def _publish_date_fallback(video_id):
    """ANDROID player responses carry no microformat; pull the date from WEB watch-next."""
    try:
        payload = _innertube("web", "next", {"videoId": video_id})
        contents = (
            payload.get("contents", {})
            .get("twoColumnWatchNextResults", {})
            .get("results", {})
            .get("results", {})
            .get("contents", [])
        )
        date_text = ""
        for item in contents:
            node = item.get("videoPrimaryInfoRenderer", {}).get("dateText", {})
            date_text = node.get("simpleText", "") or _text(node)
            if date_text:
                break
        cleaned = re.sub(r"^(Premiered|Streamed live on|Started streaming on)\s+", "", date_text)
        try:
            return datetime.strptime(cleaned, "%b %d, %Y").strftime("%Y-%m-%d")
        except ValueError:
            return cleaned
    except (HTTPException, ValueError, KeyError):
        return ""


_LAST_GOOD_CLIENT = None


def _pickable(response, client):
    """True when the response yields at least one playable stream combination."""
    js = _player_js() if client.startswith("web") else None
    picked = _pick_streams(response, js)
    return bool(picked["muxed"] or (picked["video"] and picked["audio"]))


def _innertube_player(video_id, need_streams=False):
    """Call the player endpoint across clients; return the first OK response."""
    global _LAST_GOOD_CLIENT
    errors = []
    clients = _clients()
    if _LAST_GOOD_CLIENT and _LAST_GOOD_CLIENT in clients:
        clients = [_LAST_GOOD_CLIENT, *(c for c in clients if c != _LAST_GOOD_CLIENT)]
    # Two sweeps: datacenter bot checks are often transient, so a short
    # backoff between sweeps turns many would-be 502s into successes.
    for attempt in range(2):
        for client in clients:
            if attempt and client == clients[0]:
                time.sleep(1.5)
            try:
                payload = {"videoId": video_id, "contentCheckOk": True, "racyCheckOk": True}
                if client.startswith("web"):
                    # WEB-family clients refuse to return formats without the
                    # signature timestamp from the current player JavaScript.
                    sts = _signature_timestamp()
                    if sts:
                        payload["playbackContext"] = {
                            "contentPlaybackContext": {"signatureTimestamp": int(sts)}
                        }
                response = _innertube(client, "player", payload)
                status = response.get("playabilityStatus", {}).get("status")
                if status == "OK" and response.get("streamingData"):
                    if not need_streams or _pickable(response, client):
                        _LAST_GOOD_CLIENT = client
                        return client, response
                    reason = "no decipherable streams"
                else:
                    reason = (
                        response.get("playabilityStatus", {}).get("reason") or status or "no streaming data"
                    )
                errors.append(f"{client}: {reason}")
            except HTTPException as exc:
                errors.append(f"{client}: {exc.detail}")
    raise HTTPException(
        status_code=502,
        detail="YouTube player rejected the video (" + "; ".join(errors) + ")",
    )


def _parse_video_details(payload):
    details = payload.get("videoDetails", {})
    microformat = payload.get("microformat", {}).get("playerMicroformatRenderer", {})
    length = details.get("lengthSeconds")
    is_live = bool(details.get("isLiveContent")) and not length
    publish_date = (microformat.get("publishDate") or "")[:10]
    return {
        "videoId": details.get("videoId", ""),
        "title": details.get("title", ""),
        "channel": details.get("author", ""),
        "channelId": details.get("channelId", ""),
        "description": details.get("shortDescription", ""),
        "views": str(details.get("viewCount", "")),
        "duration": "LIVE" if is_live else _format_duration(int(length)) if length else "",
        "isLive": is_live,
        "thumbnail": _best_thumbnail(details.get("thumbnail")),
        "publishDate": publish_date,
        "embeddable": microformat.get("isEmbeddable", True),
        "status": "OK",
    }


def _parse_stream(stream, player_js):
    """Normalize an adaptive/muxed format entry to the bridge's StreamInfo."""
    if not _uncipher_format(stream, player_js):
        return None
    mime = stream.get("mimeType", "")
    container = mime.split("/", 1)[1].split(";", 1)[0].strip() if "/" in mime else ""
    codecs_match = re.search(r'codecs="([^"]+)"', mime)
    codec = codecs_match.group(1) if codecs_match else ""
    is_audio = mime.startswith("audio/")
    is_video = mime.startswith("video/")
    # Muxed formats are "video/...; codecs=\"<video codec>, <audio codec>\"".
    has_audio = bool(re.search(r"mp4a|opus|ac-3|ec-3|vorbis", codec, re.IGNORECASE))
    try:
        size = int(stream.get("contentLength") or 0)
    except (TypeError, ValueError):
        size = 0
    return {
        "url": stream["url"],
        "container": container,
        "quality": stream.get("qualityLabel") or stream.get("quality", ""),
        "bitrate": int(stream.get("bitrate") or 0),
        "size": size,
        "codec": codec,
        "width": stream.get("width"),
        "height": stream.get("height"),
        "isAudio": is_audio,
        "isVideoOnly": is_video and not has_audio,
        "isMuxed": is_video and has_audio,
    }


def _pick_streams(payload, player_js):
    streaming = payload.get("streamingData", {})
    formats = streaming.get("formats", []) or []
    adaptive = streaming.get("adaptiveFormats", []) or []
    parsed = [
        stream for stream in (_parse_format_entry(entry, player_js) for entry in formats + adaptive) if stream
    ]

    muxed_candidates = [stream for stream in parsed if stream["isMuxed"]]
    video_candidates = [stream for stream in parsed if stream["isVideoOnly"]]
    audio_candidates = [stream for stream in parsed if stream["isAudio"]]

    def best_mp4(candidates):
        return [stream for stream in candidates if stream["container"] == "mp4"] or candidates

    def pick(candidates, key):
        pool = best_mp4(candidates)
        return max(pool, key=key) if pool else None

    muxed = pick(muxed_candidates, lambda s: s.get("height") or 0)
    capped = [s for s in video_candidates if (s.get("height") or 0) <= 1080]
    # Prefer H.264 when heights tie: it has the widest browser/hardware support.
    video = pick(
        capped or video_candidates, lambda s: ((s.get("height") or 0), s["codec"].startswith("avc1"))
    )
    audio = pick(audio_candidates, lambda s: s["bitrate"])
    return {"muxed": muxed, "video": video, "audio": audio}


def _parse_format_entry(entry, player_js):
    try:
        return _parse_stream(entry, player_js)
    except (KeyError, TypeError, ValueError, AttributeError, re.error):
        return None


# --------------------------------------------------------------------------
# Cached accessors (route layer)
# --------------------------------------------------------------------------


def _cached(key, loader, ttl=_CACHE_TTL):
    now = time.monotonic()
    cached = _CACHE.get(key)
    if cached and now - cached[0] < ttl:
        return cached[1]
    value = loader()
    if len(_CACHE) > 256:
        _CACHE.clear()
    _CACHE[key] = (now, value)
    return value


def _search(query, limit=24):
    return _cached(
        ("search", query.strip().lower(), limit),
        lambda: _innertube_search(query, limit=limit),
        ttl=180,
    )


def _home_sections(limit):
    def load(entry):
        title, query = entry
        try:
            videos = _search(query, limit=limit)
        except HTTPException:
            videos = []
        return {"title": title, "videos": videos} if videos else None

    with ThreadPoolExecutor(max_workers=len(_HOME_QUERIES)) as pool:
        sections = list(pool.map(load, _HOME_QUERIES))
    return [section for section in sections if section]


def _video(video_id):
    def load():
        _, payload = _innertube_player(video_id)
        details = _parse_video_details(payload)
        if not details["publishDate"]:
            details["publishDate"] = _publish_date_fallback(video_id)
        return details

    return _cached(("video", video_id), load, ttl=300)


def _watch(video_id, related_limit):
    video = _video(video_id)
    related = []
    seen = {video_id}
    if related_limit:
        query = " ".join(part for part in [video.get("title"), video.get("channel")] if part)
        if query:
            try:
                for item in _search(query, limit=related_limit + 1):
                    if item["videoId"] not in seen:
                        seen.add(item["videoId"])
                        related.append(item)
                        if len(related) >= related_limit:
                            break
            except HTTPException:
                pass
    return {"video": video, "related": related}


def _streams(video_id, refresh=False):
    key = ("streams", video_id)
    if refresh:
        _CACHE.pop(key, None)

    def load():
        client, payload = _innertube_player(video_id, need_streams=True)
        # WEB-family responses arrive signature-enciphered; the shared cached
        # player JS deciphers them (STS fetch already warmed it).
        player_js = _player_js() if client.startswith("web") else None
        streams = _pick_streams(payload, player_js)
        if not (streams["muxed"] or (streams["video"] and streams["audio"])):
            raise HTTPException(status_code=404, detail="No playable streams found for this video")
        return streams

    return _cached(key, load, ttl=120)


def _open_stream(url, range_header, method):
    headers = dict(_STREAM_HEADERS)
    if range_header:
        headers["Range"] = range_header
    if _COOKIE:
        headers["Cookie"] = _COOKIE
    return requests.request(
        method,
        url,
        headers=headers,
        stream=True,
        timeout=(10, 90),
        allow_redirects=True,
    )


def _stream_headers(upstream):
    headers = {}
    for name in ("Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"):
        value = upstream.headers.get(name)
        if value:
            headers[name] = value
    headers["Cache-Control"] = "no-store"
    return headers


# --------------------------------------------------------------------------
# Routes (unchanged contract)
# --------------------------------------------------------------------------


@router.get("/yt/home")
def yt_home(limit: int = Query(24, ge=1, le=40)):
    sections = _cached(("home", limit), lambda: _home_sections(limit), ttl=300)
    if not sections:
        raise HTTPException(status_code=502, detail="YouTube returned no videos")
    return JSONResponse({"sections": sections})


@router.get("/yt/search")
def yt_search(
    q: str = Query(..., min_length=1, description="Search query"),
    filter: str = Query("videos", description="videos|songs"),
    limit: int = Query(30, ge=1, le=100),
    ignore_spelling: bool = False,
):
    if filter not in {"videos", "songs"}:
        raise HTTPException(status_code=400, detail="filter must be 'videos' or 'songs'")
    query = q if filter == "videos" else f"{q} song"
    return JSONResponse({"query": q, "filter": filter, "results": _search(query, limit=limit)})


@router.get("/yt/video/{video_id}")
def yt_video(video_id: str, related_limit: int = Query(15, ge=0, le=30)):
    return JSONResponse(_watch(video_id, related_limit))


@router.get("/yt/streams/{video_id}")
def yt_streams(video_id: str):
    data = _streams(video_id)
    available = {kind: bool(data.get(kind)) for kind in _STREAM_KINDS}
    if not available["muxed"] and not (available["video"] and available["audio"]):
        raise HTTPException(status_code=404, detail="No playable streams found for this video")
    video_stream = data.get("video") or {}
    return JSONResponse(
        {
            "videoId": video_id,
            **available,
            "quality": video_stream.get("quality"),
            "width": video_stream.get("width"),
            "height": video_stream.get("height"),
            "streams": {
                kind: f"/yt/stream/{quote(video_id, safe='')}/{kind}"
                for kind, is_available in available.items()
                if is_available
            },
        }
    )


@router.api_route("/yt/stream/{video_id}/{kind}", methods=["GET", "HEAD"])
def yt_stream(video_id: str, kind: str, request: Request):
    if kind not in _STREAM_KINDS:
        raise HTTPException(status_code=404, detail="Unknown stream type")

    range_header = request.headers.get("range")
    upstream = None
    for attempt in range(2):
        data = _streams(video_id, refresh=attempt > 0)
        stream = data.get(kind)
        if not stream or not stream.get("url"):
            raise HTTPException(status_code=404, detail=f"No {kind} stream available")

        upstream = _open_stream(stream["url"], range_header, request.method)
        if upstream.status_code in {403, 404, 410} and attempt == 0:
            upstream.close()
            upstream = None
            continue
        break

    if upstream is None:
        raise HTTPException(status_code=502, detail="Could not open the YouTube stream")

    media_type = upstream.headers.get("Content-Type") or "application/octet-stream"
    headers = _stream_headers(upstream)

    if upstream.status_code == 416:
        upstream.close()
        return Response(status_code=416, headers=headers)

    if upstream.status_code >= 400:
        status = upstream.status_code
        upstream.close()
        raise HTTPException(
            status_code=502 if status >= 500 else status, detail="YouTube stream request failed"
        )

    if request.method == "HEAD":
        upstream.close()
        return Response(status_code=upstream.status_code, headers=headers, media_type=media_type)

    def body():
        try:
            for chunk in upstream.iter_content(chunk_size=64 * 1024):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    return StreamingResponse(
        body(),
        status_code=upstream.status_code,
        media_type=media_type,
        headers=headers,
    )
