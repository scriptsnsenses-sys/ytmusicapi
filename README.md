# WebTube (powered by YouTube)

WebTube is a free, self-hostable web player powered by YouTube and YouTube Music through the open-source [`ytmusicapi`](https://github.com/sigma67/ytmusicapi) library.

It has two modes:

* **WebTube Music (powered by YouTube Music)** — search, stream, queue, and organize music.
* **WebTube (powered by YouTube)** — browse the video home feed, search videos, and watch with related videos.

## What's Included
* No ads
* Background music
* No download required
* WebTube Music mode with search, playback, playlists, queue, and lyrics
* WebTube video mode with home feed, video search, a watch page, and related videos

## Project Layout
* `server/music.py` — YouTube Music routes powered by `ytmusicapi`.
* `server/youtube.py` — standalone generic YouTube scraper and `/yt` routes.
* `server/app.py` — shared FastAPI app, static shell, and API metadata.

## API
Endpoints:

```
(GET) /api
API Info

(GET) /health
API Health

(GET) /search
Search for songs

(GET) /artist/{channel_id}
Artist's channel ID

(GET) /song/{video_id}
Play a song

(GET) /playlist/{playlist_id}
Fetch a playlist

(GET) /watch
Watch a music video

(GET) /lyrics
Fetch the lyrics.

(GET) /yt/home
WebTube video mode home feed (technology, gaming, news, comedy, sports, and trailers)

(GET) /yt/search
Search YouTube videos or songs

(GET) /yt/video/{video_id}
Video details and related videos for the watch page

(GET) /yt/streams/{video_id}
Playable stream URLs for a video

(GET) /yt/stream/{video_id}/{kind}
Proxied video/audio stream (kind: video, audio, or muxed)
```
Complete docs at the `/docs` endpoint, or use the hosted WebTube instance: https://ytmusicapi-83b8.onrender.com/docs

Hosted WebTube URL: https://ytmusicapi-83b8.onrender.com
{You can use it for free forever, unlimited}

**Note: WebTube is hosted on Render and falls asleep after 15 minutes without activity. The first request may take around 30–50 seconds while the app wakes up; later requests are fast. Sorry for the inconvenience.**

### YouTube playback (built-in InnerTube resolver, no cookies)

Video mode resolves streams directly from YouTube's InnerTube API inside the Python server — no .NET runtime, no bridge binary, no browser cookies, no accounts. Resolution strategy:

1. Ten InnerTube clients across three hosts (`www.youtube.com`, `youtubei.googleapis.com`, `music.youtube.com`), ANDROID-family first because it returns direct, unciphered stream URLs.
2. If every client is rejected (YouTube bot-checks the player endpoint from some datacenter IP ranges), anonymous community instances (Piped / Invidious) act as a last-resort resolver and return proxied stream URLs.
3. A background keep-warm refresher re-resolves recently watched videos before their cache expires, so once a video resolves it keeps playing even when YouTube's gate closes again.

Optional environment variable:

* `YOUTUBE_CLIENT` — force a single client (`android`, `android_gapi`, `android_on_music`, `android_music`, `android_vr`, `web_embedded`, `ios`, `web`, ...) for debugging

The previous ASP.NET Core bridge (`youtube-bridge/`, built from a vendored [YoutubeExplode](https://github.com/scriptsnsenses-sys/YoutubeExplode)) is no longer required at runtime; it is kept in the repo for reference.

Credits:
```
sigma67/ytmusicapi:
* API
* Framework
* YouTube Music backend

WebTube is a fork of this repo, make sure to check out the original version.

Link:
https://github.com/sigma67/ytmusicapi
```

**Software licensed as MIT. Feel free to modify and make your own versions of WebTube.**

_Happy Coding_
