/* WebTube player — same-origin FastAPI backend.
   Queue engine (YouTube IFrame API, auto-advance), user playlists (localStorage),
   right-click menu, recent searches, continue listening. */
const $ = (id) => document.getElementById(id);
const statusEl = $("status"), resultsEl = $("results"), detailEl = $("detail"), homeEl = $("home");
const musicViewEl = $("musicView"), youtubeViewEl = $("youtubeView");
const ytHomeEl = $("ytHome"), ytResultsEl = $("ytResults"), ytWatchEl = $("ytWatch");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const setStatus = (t) => { statusEl.textContent = t || ""; };
const artistNames = (it) => (it?.artists || []).map((a) => a.name).join(", ");
const ytThumb = (vid) => vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : "";
const normTrack = (t) => ({ videoId: t.videoId, title: t.title || t.videoId, sub: artistNames(t) || t.sub || t.author || "" });

function thumbOf(it) {
  if (!it) return "";
  if (Array.isArray(it.thumbnails) && it.thumbnails.length) return it.thumbnails[it.thumbnails.length - 1].url;
  const th = it.thumbnail;
  if (typeof th === "string") return th;
  if (th && Array.isArray(th.thumbnails) && th.thumbnails.length) return th.thumbnails[th.thumbnails.length - 1].url;
  if (it.videoId) return ytThumb(it.videoId);
  return "";
}
/* "Artist • Album • 2:56 • 282M plays" like the reference */
function subLine(t) {
  const parts = [];
  const an = artistNames(t) || t.sub || t.author || "";
  if (an) parts.push(an);
  const al = t.album?.name || (typeof t.album === "string" ? t.album : "");
  if (al) parts.push(al);
  const d = t.duration || t.length || "";
  if (d) parts.push(d);
  let v = t.views ?? t.plays ?? "";
  if (v && typeof v === "string" && !/plays?$/i.test(v) && !/^\d+$/.test(v)) v += " plays";
  if (v) parts.push(v);
  return parts.join(" • ");
}
function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? "");
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}
function viewText(value) {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value);
  if (/^\d+$/.test(text)) return compactNumber(text) + " views";
  if (/^\d+(?:\.\d+)?\s*[KMB]$/i.test(text)) return text + " views";
  return text;
}
function dateText(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function durationText(video) {
  if (!video) return "";
  if (video.isLive || video.duration === "LIVE") return "LIVE";
  return video.duration || "";
}

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.json();
}
let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2200);
}

/* ================= queue engine (auto-advance) ================= */
let queue = [];   // [{videoId, title, sub}]
let qIndex = -1;
let ytPlayer = null, ytReady = false, pendingVid = null;

function loadYTAPI() {
  if (window.YT && window.YT.Player) { ytReady = true; return; }
  if (document.querySelector('script[data-ytapi]')) return;
  const s = document.createElement("script");
  s.dataset.ytapi = "1";
  s.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(s);
}
window.onYouTubeIframeAPIReady = () => {
  ytReady = true;
  if (pendingVid) { createPlayer(pendingVid); pendingVid = null; }
  if (pendingEmbed) {
    const pending = pendingEmbed;
    pendingEmbed = null;
    createYtEmbedNow(pending.videoId, pending.onFail, pending.onMeta);
  }
};
function createPlayer(videoId) {
  ytPlayer = new window.YT.Player("ytplayer", {
    videoId,
    playerVars: { autoplay: 1, rel: 0 },
    events: { onStateChange: onPlayerState },
  });
}
function onPlayerState(e) {
  if (window.YT && e.data === window.YT.PlayerState.ENDED) advance();
}

/* ============ official YouTube embed (watch page) ============
   Same concept as PierfrancescoSoffritti/android-youtube-player:
   playback runs through YouTube's own IFrame player in the visitor's
   browser, so it never depends on this server's IP. Server-resolved
   streams are only a fallback for when the embed cannot load. */
let ytEmbedPlayer = null, ytEmbedTimer = null, pendingEmbed = null;

function teardownYtEmbed() {
  if (ytEmbedTimer) { clearTimeout(ytEmbedTimer); ytEmbedTimer = null; }
  if (ytEmbedPlayer) {
    try { ytEmbedPlayer.destroy(); } catch { /* ignore */ }
    ytEmbedPlayer = null;
  }
  const mount = $("ytEmbed");
  if (mount && mount.tagName === "IFRAME") mount.remove();
}

function createYtEmbedNow(videoId, onFail, onMeta) {
  const host = $("ytPlayer");
  if (!host) return;
  teardownYtEmbed();
  host.innerHTML = `<div id="ytEmbed"></div>`;
  ytEmbedPlayer = new window.YT.Player("ytEmbed", {
    videoId,
    playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1 },
    events: {
      onReady: (event) => {
        if (ytEmbedTimer) { clearTimeout(ytEmbedTimer); ytEmbedTimer = null; }
        try {
          const data = event.target.getVideoData();
          if (data && onMeta) onMeta(data.title || "", data.author || "");
        } catch { /* ignore */ }
      },
      onError: () => {
        teardownYtEmbed();
        if (onFail) onFail();
      },
    },
  });
  // If the embed never comes up (API blocked, network issue), fall back.
  ytEmbedTimer = setTimeout(() => {
    if (!ytEmbedPlayer) { if (onFail) onFail(); return; }
    try { ytEmbedPlayer.getIframe(); } catch { teardownYtEmbed(); if (onFail) onFail(); }
  }, 8000);
}

function startYtEmbed(videoId, onFail, onMeta) {
  if (window.YT && window.YT.Player) { createYtEmbedNow(videoId, onFail, onMeta); return; }
  pendingEmbed = { videoId, onFail, onMeta };
  loadYTAPI();
  if (ytEmbedTimer) clearTimeout(ytEmbedTimer);
  ytEmbedTimer = setTimeout(() => {
    if (pendingEmbed) { pendingEmbed = null; if (onFail) onFail(); }
  }, 8000);
}
function loadCurrent() {
  const t = queue[qIndex];
  if (!t) return;
  $("nowPlaying").textContent = t.title;
  $("nowSub").textContent = t.sub;
  $("ptumb").src = ytThumb(t.videoId);
  renderQueue();
  bindMediaSession(t);
  if (ytPlayer && ytPlayer.loadVideoById) ytPlayer.loadVideoById(t.videoId);
  else if (ytReady) createPlayer(t.videoId);
  else { pendingVid = t.videoId; loadYTAPI(); }
}
/* lock-screen / background-tab controls (Media Session API) */
let msBound = false;
function bindMediaSession(t) {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title || "Unknown",
      artist: t.sub || "YouTube Music",
      album: "WebTube Music (powered by YouTube Music)",
      artwork: [{ src: ytThumb(t.videoId), sizes: "480x360", type: "image/jpeg" }],
    });
  } catch { /* ignore */ }
  if (msBound) return;
  msBound = true;
  try {
    navigator.mediaSession.setActionHandler("play", () => { try { ytPlayer.playVideo(); } catch { /* ignore */ } });
    navigator.mediaSession.setActionHandler("pause", () => { try { ytPlayer.pauseVideo(); } catch { /* ignore */ } });
    navigator.mediaSession.setActionHandler("previoustrack", goBack);
    navigator.mediaSession.setActionHandler("nexttrack", advance);
  } catch { /* ignore */ }
}
function goBack() {
  if (qIndex > 0) { qIndex--; loadCurrent(); }
}
function advance() {
  if (qIndex + 1 < queue.length) { qIndex++; loadCurrent(); pushPlayed(queue[qIndex]); renderContinue(); }
  else setStatus("Queue ended");
}
/* play a track; optionally make it part of a list (auto-advance continues through it) */
function play(videoId, title, sub, list, idx) {
  if (!videoId) return;
  if (Array.isArray(list) && list.length) {
    queue = list.map(normTrack).filter((t) => t.videoId);
    qIndex = Math.max(0, idx || 0);
    if (!queue[qIndex] || queue[qIndex].videoId !== videoId) {
      const found = queue.findIndex((t) => t.videoId === videoId);
      qIndex = found >= 0 ? found : 0;
    }
  } else {
    queue = [normTrack({ videoId, title, sub: "" })];
    queue[0].title = title || videoId;
    queue[0].sub = sub || "";
    qIndex = 0;
  }
  $("player").classList.remove("hidden");
  $("sheet").classList.remove("hidden");
  $("upnext").dataset.loaded = "";
  loadCurrent();
  showPane("upnext");
  pushPlayed({ videoId, title: current.title, sub: current.sub });
  renderContinue();
}
function playNextTrack(t) {
  t = normTrack(t);
  if (!t.videoId) return;
  if (qIndex < 0) { play(t.videoId, t.title, t.sub); return; }
  queue = queue.filter((x, i) => i === qIndex || x.videoId !== t.videoId);
  queue.splice(qIndex + 1, 0, t);
  renderQueue();
  toast(`Playing next: ${t.title}`);
}
function renderQueue() {
  const box = $("upnext");
  box.dataset.loaded = "1";
  box.innerHTML = queue.length ? queue.map((t, i) => `
    <div class="qitem${i === qIndex ? " current" : ""}" data-i="${i}">
      <img loading="lazy" src="${esc(ytThumb(t.videoId))}"><div><b>${esc(t.title)}</b><span>${esc(t.sub)}</span></div>
    </div>`).join("") : "<div class='qitem'>Queue is empty — play something!</div>";
  box.querySelectorAll(".qitem[data-i]").forEach((el) => {
    el.onclick = () => { qIndex = +el.dataset.i; loadCurrent(); };
    el.oncontextmenu = (e) => { e.preventDefault(); openCtx(queue[+el.dataset.i], e.clientX, e.clientY); };
  });
}
async function loadRadio(videoId) {
  try {
    const w = await api(`/watch?videoId=${encodeURIComponent(videoId)}&limit=25`);
    queue = (w.tracks || []).map(normTrack).filter((t) => t.videoId);
    if (!queue.length) throw new Error("Radio returned no tracks");
    qIndex = 0;
    $("player").classList.remove("hidden");
    $("sheet").classList.remove("hidden");
    $("upnext").dataset.loaded = "";
    loadCurrent();
    showPane("upnext");
    pushPlayed(queue[0]);
    renderContinue();
  } catch (e) { setStatus("Queue failed: " + e.message); }
}

function openSheet() { $("sheet").classList.remove("hidden"); }
function showPane(which) {
  $("tabQueue").classList.toggle("active", which === "upnext");
  $("tabLyrics").classList.toggle("active", which === "lyrics");
  $("upnext").classList.toggle("hidden", which !== "upnext");
  $("lyrics").classList.toggle("hidden", which !== "lyrics");
}
$("tabQueue").onclick = () => { showPane("upnext"); renderQueue(); };
$("tabLyrics").onclick = () => { showPane("lyrics"); if (queue[qIndex]) loadLyrics(queue[qIndex].videoId); };
$("watchBtn").onclick = () => { $("sheet").classList.toggle("hidden"); };
$("hideBtn").onclick = () => {
  $("player").classList.add("hidden"); $("sheet").classList.add("hidden");
  try { ytPlayer && ytPlayer.stopVideo && ytPlayer.stopVideo(); } catch { /* ignore */ }
  queue = []; qIndex = -1;
};
$("upnextBtn").onclick = () => { openSheet(); showPane("upnext"); renderQueue(); };
$("lyricsBtn").onclick = () => {
  if (qIndex < 0) return;
  openSheet(); showPane("lyrics"); loadLyrics(queue[qIndex].videoId);
};
async function loadLyrics(videoId) {
  const box = $("lyrics");
  box.textContent = "Loading lyrics…";
  try {
    const d = await api(`/lyrics?videoId=${encodeURIComponent(videoId)}`);
    const text = Array.isArray(d.lyrics) ? d.lyrics.map((l) => l.text).join("\n") : (d.lyrics || "");
    box.innerHTML = esc(text || "No lyrics text returned.") + (d.source ? `<span class="src">${esc(d.source)}</span>` : "");
  } catch (e) { box.textContent = "Lyrics unavailable: " + e.message; }
}

/* ================= right-click menu ================= */
let ctxTrack = null;
function openCtx(track, x, y) {
  ctxTrack = normTrack(track);
  if (!ctxTrack.videoId) return;
  const m = $("ctxmenu");
  m.classList.remove("hidden");
  m.style.left = Math.min(x, window.innerWidth - 190) + "px";
  m.style.top = Math.min(y, window.innerHeight - 110) + "px";
}
function closeCtx() { $("ctxmenu").classList.add("hidden"); ctxTrack = null; }
document.addEventListener("click", (e) => { if (!e.target.closest("#ctxmenu") && !e.target.closest(".dots")) closeCtx(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeCtx(); closePlModal(); } });
$("ctxNext").onclick = () => { if (ctxTrack) playNextTrack(ctxTrack); closeCtx(); };
$("ctxAdd").onclick = () => { if (ctxTrack) openPlModal(ctxTrack); closeCtx(); };

/* ================= user playlists (localStorage) ================= */
const PL_KEY = "ytm_user_playlists";
const getPlaylists = () => { try { return JSON.parse(localStorage.getItem(PL_KEY)) || []; } catch { return []; } };
const savePlaylists = (p) => { try { localStorage.setItem(PL_KEY, JSON.stringify(p)); } catch { /* ignore */ } };
function createPlaylist(name) {
  name = (name || "").trim();
  if (!name) return null;
  const pls = getPlaylists();
  const pl = { id: "pl_" + Date.now(), name, tracks: [] };
  pls.unshift(pl);
  savePlaylists(pls);
  return pl;
}
function addTrackToPlaylist(plId, track) {
  const pls = getPlaylists();
  const pl = pls.find((p) => p.id === plId);
  if (!pl) return false;
  track = normTrack(track);
  if (!pl.tracks.some((t) => t.videoId === track.videoId)) pl.tracks.push(track);
  savePlaylists(pls);
  return true;
}
let plModalTrack = null;
function openPlModal(track) {
  plModalTrack = normTrack(track);
  $("pltarget").textContent = `${plModalTrack.title} — ${plModalTrack.sub}`;
  renderPlModal();
  $("plmodal").classList.remove("hidden");
}
function closePlModal() { $("plmodal").classList.add("hidden"); plModalTrack = null; }
function renderPlModal() {
  const pls = getPlaylists();
  $("pllist").innerHTML = pls.length ? pls.map((p) => `
    <div class="plrow" data-id="${esc(p.id)}"><span>📝</span><span class="plname">${esc(p.name)}</span><span class="plcount">${p.tracks.length} songs</span></div>
  `).join("") : `<div class="recent-empty">No playlists yet — create one below.</div>`;
  $("pllist").querySelectorAll(".plrow").forEach((el) => {
    el.onclick = () => {
      if (addTrackToPlaylist(el.dataset.id, plModalTrack)) {
        const p = getPlaylists().find((x) => x.id === el.dataset.id);
        toast(`Added to ${p.name}`);
        closePlModal();
      }
    };
  });
}
$("plcreate").onclick = () => {
  const pl = createPlaylist($("plname").value);
  if (!pl) return;
  $("plname").value = "";
  if (plModalTrack) {
    addTrackToPlaylist(pl.id, plModalTrack);
    toast(`Added to ${pl.name}`);
    closePlModal();
  } else renderPlModal();
};
$("plclose").onclick = closePlModal;
$("plmodal").addEventListener("click", (e) => { if (e.target.id === "plmodal") closePlModal(); });

/* ================= library view ================= */
function showLibrary() {
  resultsEl.innerHTML = ""; homeEl.innerHTML = "";
  const pls = getPlaylists();
  detailEl.innerHTML = `<h2 class="shelf-title">Your library</h2>
    <div><button class="btn-primary" id="libNew">＋ New playlist</button></div>
    <div class="grid" style="margin-top:14px">` + (pls.length ? pls.map((p) => `
      <button class="card" data-id="${esc(p.id)}">
        <span class="art"><img src="${esc(p.tracks.length ? ytThumb(p.tracks[0].videoId) : "")}" alt=""><span class="veil"><span class="playdot">▶</span></span></span>
        <span class="meta"><b>${esc(p.name)}</b><span>${p.tracks.length} songs</span></span>
      </button>`).join("") : `<div style="color:var(--muted)">No playlists yet. Right-click any song → Add to playlist.</div>`) + `</div>`;
  detailEl.querySelectorAll(".card[data-id]").forEach((c) => { c.onclick = () => showUserPlaylist(c.dataset.id); });
  $("libNew").onclick = () => { plModalTrack = null; $("pltarget").textContent = ""; renderPlModal(); $("plmodal").classList.remove("hidden"); };
  detailEl.scrollIntoView();
  setStatus("");
}
function showUserPlaylist(id) {
  const pl = getPlaylists().find((p) => p.id === id);
  if (!pl) { showLibrary(); return; }
  detailEl.innerHTML = hero("Playlist", pl.tracks.length ? ytThumb(pl.tracks[0].videoId) : "", pl.name,
    `${pl.tracks.length} songs · yours`, pl.tracks.length ? pl.tracks[0].videoId : null, null) +
    trackRows(pl.tracks, true);
  bindRows(detailEl, pl.tracks);
  detailEl.querySelectorAll("[data-rm]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const pls = getPlaylists();
      const p = pls.find((x) => x.id === id);
      p.tracks.splice(+b.dataset.rm, 1);
      savePlaylists(pls);
      showUserPlaylist(id);
    };
  });
  const hp = $("heroPlay");
  if (hp && pl.tracks.length) hp.onclick = () => play(pl.tracks[0].videoId, pl.tracks[0].title, pl.tracks[0].sub, pl.tracks, 0);
  detailEl.scrollIntoView({ behavior: "smooth" });
  setStatus("");
}
$("libLink").onclick = (e) => { e.preventDefault(); showLibrary(); };

/* ================= recent searches ================= */
const RS_KEY = "ytm_recent_searches";
const getRecents = () => { try { return JSON.parse(localStorage.getItem(RS_KEY)) || []; } catch { return []; } };
function saveRecent(q) {
  q = (q || "").trim();
  if (!q) return;
  const r = getRecents().filter((x) => x.toLowerCase() !== q.toLowerCase());
  r.unshift(q);
  try { localStorage.setItem(RS_KEY, JSON.stringify(r.slice(0, 10))); } catch { /* ignore */ }
}
function renderRecents() {
  const panel = $("recentPanel");
  const recents = getRecents();
  panel.innerHTML = `<div class="recent-head">Recent searches</div>` + (recents.length ? recents.map((q, i) => `
    <div class="recent-item" data-i="${i}">
      <span class="clock">🕐</span><span class="txt">${esc(q)}</span><button class="rm" data-rm="${i}" title="Remove">✕</button>
    </div>`).join("") : `<div class="recent-empty">No recent searches</div>`);
  panel.querySelectorAll(".recent-item").forEach((el) => {
    el.onclick = (e) => {
      if (e.target.dataset.rm !== undefined) {
        const r = getRecents();
        r.splice(+e.target.dataset.rm, 1);
        try { localStorage.setItem(RS_KEY, JSON.stringify(r)); } catch { /* ignore */ }
        renderRecents();
        return;
      }
      $("q").value = recents[+el.dataset.i];
      panel.classList.add("hidden");
      doSearch();
    };
  });
}
$("q").addEventListener("focus", () => { renderRecents(); $("recentPanel").classList.remove("hidden"); });
$("q").addEventListener("click", () => { renderRecents(); $("recentPanel").classList.remove("hidden"); });
$("q").addEventListener("blur", () => { setTimeout(() => $("recentPanel").classList.add("hidden"), 150); });

/* ================= continue listening ================= */
const RP_KEY = "ytm_recently_played";
const getPlayed = () => { try { return JSON.parse(localStorage.getItem(RP_KEY)) || []; } catch { return []; } };
function pushPlayed(t) {
  const track = normTrack(t || {});
  if (!track.videoId) return;
  const list = getPlayed().filter((x) => x.videoId !== track.videoId);
  list.unshift({ ...track, at: Date.now() });
  try { localStorage.setItem(RP_KEY, JSON.stringify(list.slice(0, 20))); } catch { /* ignore */ }
}
function renderContinue() {
  const box = $("continue");
  const list = getPlayed();
  if (!list.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<h2 class="shelf-title">Continue listening</h2><div class="shelf-row">` + list.map((t) => `
    <button class="card" data-vid="${esc(t.videoId)}" data-title="${esc(t.title)}" data-sub="${esc(t.sub)}">
      <span class="art"><img loading="lazy" src="${esc(ytThumb(t.videoId))}" alt=""><span class="veil"><span class="playdot">▶</span></span></span>
      <span class="meta"><b>${esc(t.title)}</b><span>${esc(t.sub)}</span></span>
    </button>`).join("") + `</div>`;
  box.querySelectorAll(".card").forEach((c) => {
    c.onclick = () => play(c.dataset.vid, c.dataset.title, c.dataset.sub);
    c.oncontextmenu = (e) => { e.preventDefault(); openCtx({ videoId: c.dataset.vid, title: c.dataset.title, artists: [{ name: c.dataset.sub }] }, e.clientX, e.clientY); };
  });
}

/* ================= search ================= */
document.querySelectorAll("#chips .chip").forEach((c) => {
  c.onclick = () => {
    document.querySelectorAll("#chips .chip").forEach((x) => x.classList.remove("active"));
    c.classList.add("active");
    if ($("q").value.trim()) doSearch();
  };
});
const activeFilter = () => document.querySelector("#chips .chip.active")?.dataset.filter || "";

async function doSearch() {
  if (mode === "youtube") return doYtSearch();
  const q = $("q").value.trim();
  if (!q) return;
  saveRecent(q);
  $("recentPanel").classList.add("hidden");
  detailEl.innerHTML = ""; homeEl.innerHTML = ""; $("continue").innerHTML = "";
  setStatus("Searching…");
  try {
    const p = new URLSearchParams({ q, limit: 24 });
    if (activeFilter()) p.set("filter", activeFilter());
    const items = await api("/search?" + p);
    setStatus(items.length ? `${items.length} result(s) for “${q}”` : `No results for “${q}”`);
    resultsEl.innerHTML = `<h2 class="shelf-title">Results</h2><div class="grid">` + items.map((it, i) => card(it, i)).join("") + `</div>`;
    bindCards(resultsEl, items);
  } catch (e) { setStatus("Search failed: " + e.message); }
}
$("searchBtn").onclick = doSearch;
$("q").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
function musicHome() {
  resultsEl.innerHTML = ""; detailEl.innerHTML = "";
  renderMouseLockCard();
  renderContinue();
}
const goHome = (e) => {
  if (e) e.preventDefault();
  if (mode === "youtube") {
    if (location.hash !== "#yt") pushRoute("yt");
    showYtHome();
    return;
  }
  musicHome();
};
$("homeLink").onclick = goHome;
$("brandHome").onclick = goHome;

function card(it, i) {
  return `<button class="card" data-idx="${i}" ${it.videoId ? `data-vid="${esc(it.videoId)}" data-title="${esc(it.title || "")}" data-sub="${esc(artistNames(it) || it.author || "")}"` : ""}>
    <span class="art"><img loading="lazy" src="${esc(thumbOf(it))}" alt=""><span class="veil"><span class="playdot">▶</span></span></span>
    <span class="meta"><b>${esc(it.title)}</b><span>${esc(artistNames(it) || it.author || "")}</span></span>
  </button>`;
}
function bindCards(root, items) {
  const playable = items.map(normTrack).filter((t) => t.videoId);
  root.querySelectorAll(".card").forEach((c) => {
    const it = items[+c.dataset.idx];
    c.onclick = () => openResult(it, playable);
    c.oncontextmenu = (e) => {
      if (!it.videoId) return;
      e.preventDefault();
      openCtx(it, e.clientX, e.clientY);
    };
  });
}
function openResult(it, playable) {
  const type = it.resultType;
  if (type === "song" || type === "video") {
    const idx = (playable || []).findIndex((t) => t.videoId === it.videoId);
    play(it.videoId, it.title, artistNames(it), playable, idx);
  }
  else if (type === "album") showAlbum(it.browseId);
  else if (type === "artist") showArtist(it.browseId);
  else if (type === "playlist") showPlaylist(String(it.browseId || "").replace(/^VL/, ""));
  else if (it.videoId) play(it.videoId, it.title, artistNames(it), playable, (playable || []).findIndex((t) => t.videoId === it.videoId));
  else if (it.browseId) showAlbum(it.browseId);
}

/* ================= detail views ================= */
function hero(kind, img, title, sub, firstVid, radioId) {
  return `<div class="hero">
    ${img ? `<img src="${esc(img)}" alt="">` : ""}
    <div><div class="kicker">${esc(kind)}</div><h1>${esc(title)}</h1><div class="sub">${sub}</div>
    <div class="actions">
      ${firstVid ? `<button class="btn-primary" id="heroPlay">▶ Play</button>` : ""}
      ${radioId ? `<button class="btn-ghost" id="heroRadio">Radio</button>` : ""}
    </div></div>
  </div>`;
}
/* screenshot-style rows: square thumb | Title / Artist • Album • time • plays | ⋮ */
function trackRows(tracks, removable) {
  return tracks.map((t, i) => `
    <div class="trow" data-vid="${esc(t.videoId || "")}" data-title="${esc(t.title || "")}" data-sub="${esc(artistNames(t))}">
      <img loading="lazy" src="${esc(thumbOf(t))}" alt="">
      <span class="tt"><b>${esc(t.title)}</b><span>${esc(subLine(t))}</span></span>
      ${removable ? `<button class="dots" data-rm="${i}" title="Remove">✕</button>` : `<button class="dots" data-menu="${i}" title="More">⋮</button>`}
    </div>`).join("");
}
function bindRows(root, tracks) {
  root.querySelectorAll(".trow[data-vid]").forEach((r) => {
    const i = tracks.findIndex((t) => t.videoId === r.dataset.vid);
    r.onclick = (e) => {
      if (e.target.closest(".dots")) return;
      if (r.dataset.vid) play(r.dataset.vid, r.dataset.title, r.dataset.sub, tracks, i >= 0 ? i : 0);
    };
    r.oncontextmenu = (e) => {
      e.preventDefault();
      openCtx({ videoId: r.dataset.vid, title: r.dataset.title, artists: [{ name: r.dataset.sub }] }, e.clientX, e.clientY);
    };
  });
  root.querySelectorAll(".dots[data-menu]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const row = b.closest(".trow");
      const rect = b.getBoundingClientRect();
      openCtx({ videoId: row.dataset.vid, title: row.dataset.title, artists: [{ name: row.dataset.sub }] }, rect.left - 150, rect.bottom + 4);
    };
  });
}
const firstVid = (tracks) => (tracks || []).find((t) => t.videoId)?.videoId || null;

async function showAlbum(browseId) {
  setStatus("Loading album…");
  try {
    const a = await api(`/album/${encodeURIComponent(browseId)}`);
    const tracks = a.tracks || [];
    detailEl.innerHTML = hero("Album", thumbOf(a), a.title || "Album",
      `${esc(artistNames({ artists: a.artists }))} · ${esc(a.year || "")} · ${tracks.length} songs`,
      firstVid(tracks), null) + trackRows(tracks);
    bindRows(detailEl, tracks);
    const hp = $("heroPlay");
    if (hp && tracks.length) hp.onclick = () => { const t = tracks.find((x) => x.videoId); play(t.videoId, t.title, artistNames(t), tracks, tracks.indexOf(t)); };
    detailEl.scrollIntoView({ behavior: "smooth" });
    setStatus("");
  } catch (e) { setStatus("Album failed: " + e.message); }
}

async function showArtist(channelId) {
  setStatus("Loading artist…");
  try {
    const a = await api(`/artist/${encodeURIComponent(channelId)}`);
    const songs = a.songs?.results || a.songs || [];
    const secs = ["albums", "singles", "videos"]
      .map((sec) => ({ sec, s: a[sec], items: a[sec]?.results || a[sec] || [] }))
      .filter((x) => Array.isArray(x.items) && x.items.length);
    detailEl.innerHTML = hero("Artist", thumbOf(a), a.name || a.title || "Artist", esc(a.subscribers || ""),
      firstVid(songs), channelId) +
      (songs.length ? `<h2 class="shelf-title">Top songs</h2>` + trackRows(songs.slice(0, 10)) : "") +
      secs.map((x) => `<h2 class="shelf-title">${esc(x.s?.title || x.sec)}</h2><div class="shelf-row">` +
        x.items.map((it, i) => card(it, i)).join("") + `</div>`).join("");
    bindRows(detailEl, songs);
    detailEl.querySelectorAll(".shelf-row").forEach((row, ri) => bindCards(row, secs[ri].items));
    const hp = $("heroPlay");
    if (hp) hp.onclick = () => { const t = songs.find((x) => x.videoId); play(t.videoId, t.title, artistNames(t), songs, songs.indexOf(t)); };
    const hr = $("heroRadio");
    if (hr) hr.onclick = async () => {
      const t = songs.find((x) => x.videoId);
      if (t) await loadRadio(t.videoId);
    };
    detailEl.scrollIntoView({ behavior: "smooth" });
    setStatus("");
  } catch (e) { setStatus("Artist failed: " + e.message); }
}

async function showPlaylist(playlistId) {
  setStatus("Loading playlist…");
  try {
    const p = await api(`/playlist/${encodeURIComponent(playlistId)}?limit=100`);
    const tracks = p.tracks || [];
    detailEl.innerHTML = hero("Playlist", thumbOf(p), p.title || "Playlist",
      `${esc(p.author?.name || "")} · ${esc(p.trackCount || tracks.length)} songs`,
      firstVid(tracks), playlistId) + trackRows(tracks);
    bindRows(detailEl, tracks);
    const hp = $("heroPlay");
    if (hp && tracks.length) hp.onclick = () => { const t = tracks.find((x) => x.videoId); play(t.videoId, t.title, artistNames(t), tracks, tracks.indexOf(t)); };
    const hr = $("heroRadio");
    if (hr) hr.onclick = async () => {
      const w = await api(`/watch?playlistId=${encodeURIComponent(playlistId)}&limit=25`);
      if (w.tracks?.length) {
        queue = w.tracks.map(normTrack).filter((t) => t.videoId);
        qIndex = 0;
        loadCurrent();
        showPane("upnext");
      }
    };
    detailEl.scrollIntoView({ behavior: "smooth" });
    setStatus("");
  } catch (e) { setStatus("Playlist failed: " + e.message); }
}

/* ================= mouse-lock remote ================= */
const REMOTE_KEY = "ytm_mouse_lock";
let remoteArmed = false;
let remoteLocked = false;
let remoteClicks = [];
let remoteFocusEl = null;
try { remoteArmed = localStorage.getItem(REMOTE_KEY) === "1"; } catch { /* ignore */ }

function mouseLockCardHtml() {
  return `<button class="mouse-lock-card" type="button">
    <span class="mlc-icon">🖱️</span>
    <span class="mlc-text"><b>Mouse lock remote</b>
      <span>${remoteArmed
        ? "Armed — triple-click anywhere to lock the mouse, then steer with the arrow keys"
        : "Click to arm, then triple-click anywhere to lock your mouse and control WebTube with arrows"}</span>
    </span>
    <span class="mlc-state">${remoteArmed ? "ON" : "OFF"}</span>
  </button>`;
}
function renderMouseLockCard() {
  homeEl.innerHTML = mouseLockCardHtml();
  bindMouseLockCards();
}
function bindMouseLockCards() {
  document.querySelectorAll(".mouse-lock-card").forEach((card) => {
    card.onclick = (e) => { e.stopPropagation(); toggleRemoteArmed(); };
  });
}
function toggleRemoteArmed() {
  remoteArmed = !remoteArmed;
  try { localStorage.setItem(REMOTE_KEY, remoteArmed ? "1" : "0"); } catch { /* ignore */ }
  renderMouseLockCard();
  document.querySelectorAll(".mouse-lock-card").forEach((card) => {
    const text = card.querySelector(".mlc-text span");
    const state = card.querySelector(".mlc-state");
    if (text) text.textContent = remoteArmed
      ? "Armed — triple-click anywhere to lock the mouse, then steer with the arrow keys"
      : "Click to arm, then triple-click anywhere to lock your mouse and control WebTube with arrows";
    if (state) state.textContent = remoteArmed ? "ON" : "OFF";
  });
  toast(remoteArmed
    ? "Mouse lock armed: triple-click anywhere to lock the mouse"
    : "Mouse lock disabled");
}
/* triple-click anywhere (each click within 1.5s) locks the pointer */
document.addEventListener("click", () => {
  // The host can terminate a pointer lock without firing pointerlockchange;
  // reconcile against the authoritative state so a stale flag cannot block
  // re-locking forever.
  if (remoteLocked && document.pointerLockElement !== document.body) {
    remoteLocked = false;
    updateRemoteHud();
    clearRemoteFocus();
  }
  if (!remoteArmed || remoteLocked) return;
  const now = performance.now();
  remoteClicks = remoteClicks.filter((t) => now - t < 1500);
  remoteClicks.push(now);
  if (remoteClicks.length >= 3) {
    remoteClicks = [];
    lockMouse();
  }
}, true);
function lockMouse() {
  if (!document.body.requestPointerLock) { toast("Pointer lock is not supported here"); return; }
  const request = document.body.requestPointerLock();
  if (request && request.catch) request.catch(() => toast("Could not lock the mouse — try again"));
}
document.addEventListener("pointerlockchange", () => {
  remoteLocked = document.pointerLockElement === document.body;
  updateRemoteHud();
  if (remoteLocked) {
    const first = remoteCandidates()[0];
    setRemoteFocus(first);
    toast("Mouse locked — arrows navigate, Enter selects, Esc releases");
  } else {
    clearRemoteFocus();
  }
});
document.addEventListener("pointerlockerror", () => toast("Could not lock the mouse — try again"));
function updateRemoteHud() {
  let hud = $("remoteHud");
  if (!hud) {
    hud = document.createElement("div");
    hud.id = "remoteHud";
    hud.className = "remote-hud hidden";
    document.body.appendChild(hud);
  }
  hud.textContent = "🖱️ Mouse locked — ↑ ↓ ← → navigate · Enter select · Esc release";
  hud.classList.toggle("hidden", !remoteLocked);
}
function remoteCandidates() {
  return [...document.querySelectorAll("button, a[href], input")].filter((el) => {
    if (el.disabled || el.closest(".hidden")) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}
function setRemoteFocus(el) {
  clearRemoteFocus();
  remoteFocusEl = el;
  if (el) {
    el.classList.add("remote-focus");
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }
}
function clearRemoteFocus() {
  if (remoteFocusEl) remoteFocusEl.classList.remove("remote-focus");
  remoteFocusEl = null;
}
function remoteMove(dir) {
  const candidates = remoteCandidates();
  if (!candidates.length) return;
  if (!remoteFocusEl || !candidates.includes(remoteFocusEl)) { setRemoteFocus(candidates[0]); return; }
  const cur = remoteFocusEl.getBoundingClientRect();
  const ccx = cur.left + cur.width / 2, ccy = cur.top + cur.height / 2;
  let best = null, bestScore = Infinity;
  for (const el of candidates) {
    if (el === remoteFocusEl) continue;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const dx = cx - ccx, dy = cy - ccy;
    let along = -1, perp = 0;
    if (dir === "left")  { if (dx >= -8) continue; along = -dx; perp = Math.abs(dy); }
    if (dir === "right") { if (dx <= 8) continue; along = dx; perp = Math.abs(dy); }
    if (dir === "up")    { if (dy >= -8) continue; along = -dy; perp = Math.abs(dx); }
    if (dir === "down")  { if (dy <= 8) continue; along = dy; perp = Math.abs(dx); }
    if (along < 0) continue;
    const score = along + perp * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) setRemoteFocus(best);
}
document.addEventListener("keydown", (e) => {
  if (!remoteLocked) return;
  const map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
  if (map[e.key]) { e.preventDefault(); remoteMove(map[e.key]); return; }
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    if (remoteFocusEl) remoteFocusEl.click();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    if (document.exitPointerLock) document.exitPointerLock();
  }
});

/* ================= YouTube mode ================= */
const MODE_KEY = "ytm_mode";
let mode = "music";
let ytFilter = "videos";
let ytHomeLoaded = false;
let musicViewReady = false;
let musicWasPlaying = false;

function pushRoute(hash) {
  if (location.hash === "#" + hash) return;
  history.pushState(null, "", "#" + hash);
}
function suspendMusic() {
  try {
    musicWasPlaying = !!(ytPlayer?.getPlayerState && ytPlayer.getPlayerState() === window.YT?.PlayerState?.PLAYING);
  } catch { musicWasPlaying = false; }
  try { ytPlayer?.pauseVideo?.(); } catch { /* ignore */ }
  $("player").classList.add("hidden");
  $("sheet").classList.add("hidden");
}
function resumeMusic() {
  if (queue.length && qIndex >= 0) {
    $("player").classList.remove("hidden");
    if (musicWasPlaying) {
      try { ytPlayer?.playVideo?.(); } catch { /* ignore */ }
    }
  }
  musicWasPlaying = false;
}
function stopYtVideo() {
  ytWatchEl.innerHTML = "";
  ytWatchEl.classList.add("hidden");
}
function setMode(next) {
  if (next !== "yt") stopYtPlayback();
  if (next === mode) return;
  mode = next;
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
  const isYt = mode === "youtube";
  document.body.classList.toggle("yt-mode", isYt);
  musicViewEl.classList.toggle("hidden", isYt);
  youtubeViewEl.classList.toggle("hidden", !isYt);
  $("chips").classList.toggle("hidden", isYt);
  $("ytChips").classList.toggle("hidden", !isYt);
  $("libLink").classList.toggle("hidden", isYt);
  $("modeMusic").classList.toggle("active", !isYt);
  $("modeYt").classList.toggle("active", isYt);
  $("modeMusic").setAttribute("aria-selected", String(!isYt));
  $("modeYt").setAttribute("aria-selected", String(isYt));
  $("brandLabel").innerHTML = isYt
    ? "WebTube <em>(powered by YouTube)</em>"
    : "WebTube Music <em>(powered by YouTube Music)</em>";
  $("q").placeholder = isYt ? "Search WebTube" : "Search WebTube Music";
  document.title = isYt ? "WebTube (powered by YouTube)" : "WebTube Music (powered by YouTube Music)";
  if (isYt) {
    suspendMusic();
    stopYtVideo();
    ytHomeEl.classList.remove("hidden");
    ytResultsEl.innerHTML = "";
    ytResultsEl.classList.add("hidden");
  } else {
    stopYtVideo();
    ytHomeEl.innerHTML = "";
    ytResultsEl.innerHTML = "";
    ytHomeLoaded = false;
    resumeMusic();
    renderContinue();
  }
  setStatus("");
}
function ytBadge(video) {
  const text = durationText(video);
  if (!text) return "";
  return `<span class="yt-badge${text === "LIVE" ? " live" : ""}">${esc(text)}</span>`;
}
function ytCard(video) {
  const meta = [video.channel, viewText(video.views)].filter(Boolean).join(" • ");
  return `<button class="yt-card" data-vid="${esc(video.videoId)}">
    <span class="yt-thumb"><img loading="lazy" src="${esc(video.thumbnail || ytThumb(video.videoId))}" alt="">${ytBadge(video)}</span>
    <span class="yt-info"><b>${esc(video.title)}</b><span>${esc(meta)}</span></span>
  </button>`;
}
function bindYtCards(root) {
  root.querySelectorAll(".yt-card[data-vid]").forEach((card) => {
    card.onclick = () => openYtVideo(card.dataset.vid);
  });
}
async function loadYtHome() {
  setStatus("Loading WebTube…");
  try {
    const data = await api("/yt/home");
    const sections = data.sections || [];
    const remoteSection = `
      <section class="yt-section yt-remote-section">
        <div class="yt-row">${mouseLockCardHtml()}</div>
      </section>`;
    ytHomeEl.innerHTML = remoteSection + (sections.length ? sections.map((section) => `
      <section class="yt-section">
        <h2 class="yt-section-title">${esc(section.title)}</h2>
        <div class="yt-row">${(section.videos || []).map(ytCard).join("")}</div>
      </section>`).join("") : `<div class="yt-empty">No videos returned. Try searching above.</div>`);
    bindMouseLockCards();
    bindYtCards(ytHomeEl);
    ytHomeLoaded = true;
    setStatus("");
  } catch (e) {
    ytHomeLoaded = false;
    setStatus("WebTube home failed: " + e.message);
  }
}
function showYtHome(force = false) {
  if (mode !== "youtube") setMode("youtube");
  ytWatchEl.innerHTML = "";
  ytWatchEl.classList.add("hidden");
  ytResultsEl.innerHTML = "";
  ytResultsEl.classList.add("hidden");
  ytHomeEl.classList.remove("hidden");
  if (force || !ytHomeLoaded) loadYtHome();
  else setStatus("");
}
function openYtVideo(videoId) {
  if (!videoId) return;
  if (mode !== "youtube") setMode("youtube");
  pushRoute("yt/" + encodeURIComponent(videoId));
  loadYtVideo(videoId);
}
function ytRelCard(video) {
  const meta = [video.channel, viewText(video.views)].filter(Boolean).join(" • ");
  return `<button class="yt-rel" data-vid="${esc(video.videoId)}">
    <span class="yt-thumb"><img loading="lazy" src="${esc(video.thumbnail || ytThumb(video.videoId))}" alt="">${ytBadge(video)}</span>
    <span class="yt-rel-info"><b>${esc(video.title)}</b><span>${esc(meta)}</span></span>
  </button>`;
}
async function loadYtVideo(videoId) {
  if (mode !== "youtube") setMode("youtube");
  ytHomeEl.classList.add("hidden");
  ytResultsEl.classList.add("hidden");
  ytWatchEl.classList.remove("hidden");
  // Render the watch page and start the official player immediately —
  // playback never waits on server-side details, which can be slow or
  // bot-gated on datacenter hosts.
  renderYtVideo({ videoId, title: "", channel: "", views: "", description: "" }, []);
  setStatus("Loading…");
  window.scrollTo({ top: 0, behavior: "smooth" });
  try {
    const data = await api(`/yt/video/${encodeURIComponent(videoId)}`);
    applyYtDetails(data.video || {}, data.related || []);
    setStatus("");
  } catch (e) {
    // Details unavailable (bot check) — the official player in the
    // visitor's browser still plays, and it backfills title/channel.
    setStatus("Details unavailable — playing via the YouTube player.");
  }
}
function applyYtDetails(video, related) {
  // Patch the already-rendered watch page in place so the running player
  // is not torn down and restarted.
  const h1 = ytWatchEl.querySelector("h1");
  if (h1 && video.title) { h1.textContent = video.title; document.title = `${video.title} - WebTube`; }
  const who = ytWatchEl.querySelector(".who b");
  if (who && video.channel) who.textContent = video.channel;
  const avatar = ytWatchEl.querySelector(".yt-avatar");
  if (avatar && video.channel) avatar.textContent = video.channel.trim().charAt(0).toUpperCase() || "?";
  const meta = ytWatchEl.querySelector(".who span");
  const metaText = [viewText(video.views), dateText(video.publishDate)].filter(Boolean).join(" • ");
  if (meta && metaText) meta.textContent = metaText;
  if (video.description && !ytWatchEl.querySelector(".yt-description")) {
    const actions = ytWatchEl.querySelector(".yt-actions");
    if (actions) {
      actions.insertAdjacentHTML("afterend", `<div class="yt-description"><b>Description</b>${esc(video.description)}</div>`);
    }
  }
  const list = ytWatchEl.querySelector(".yt-related-list");
  if (list && related.length) {
    list.innerHTML = related.map(ytRelCard).join("");
    list.querySelectorAll(".yt-rel[data-vid]").forEach((card) => {
      card.onclick = () => openYtVideo(card.dataset.vid);
    });
  }
  const audioBtn = $("ytPlayAudio");
  if (audioBtn && video.videoId) {
    audioBtn.onclick = () => {
      const items = [
        { videoId: video.videoId, title: video.title, sub: video.channel },
        ...related.map((item) => ({ videoId: item.videoId, title: item.title, sub: item.channel })),
      ];
      pushRoute("music");
      setMode("music");
      play(video.videoId, video.title, video.channel, items, 0);
    };
  }
}
function stopYtPlayback() {
  teardownYtEmbed();
  document.querySelectorAll("#ytVideo, #ytAudio").forEach((el) => {
    el.pause();
    el.removeAttribute("src");
    el.load();
  });
}
function renderYtVideo(video, related) {
  stopYtPlayback();
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`;
  const meta = [viewText(video.views), dateText(video.publishDate)].filter(Boolean).join(" • ");
  const avatar = String(video.channel || "?").trim().charAt(0).toUpperCase() || "?";
  const title = video.title || "Loading…";
  const player = `<div class="yt-player-host" id="ytPlayer"><div class="yt-player-loading">Loading video…</div></div>`;
  const description = video.description
    ? `<div class="yt-description"><b>Description</b>${esc(video.description)}</div>`
    : "";
  const relatedHtml = related.length
    ? related.map(ytRelCard).join("")
    : `<div class="yt-empty">No related videos found.</div>`;
  ytWatchEl.innerHTML = `<div class="yt-watch">
    <div class="yt-watch-main">
      <div class="yt-watch-player">${player}</div>
      <h1>${esc(title)}</h1>
      <div class="yt-watch-meta">
        <span class="yt-avatar">${esc(avatar)}</span>
        <div class="who"><b>${esc(video.channel || "Unknown channel")}</b><span>${esc(meta)}</span></div>
      </div>
      <div class="yt-actions">
        <button class="yt-action" id="ytPlayAudio">▶ Play audio</button>
        <button class="yt-action" id="ytCopyLink">Copy link</button>
        <a class="yt-action" href="${esc(watchUrl)}" target="_blank" rel="noopener">Open on YouTube ↗</a>
      </div>
      ${description}
    </div>
    <aside class="yt-related"><h3>Up next</h3><div class="yt-related-list">${relatedHtml}</div></aside>
  </div>`;
  document.title = `${video.title || "Video"} - WebTube`;

  const audioBtn = $("ytPlayAudio");
  if (audioBtn) {
    audioBtn.onclick = () => {
      const list = [
        { videoId: video.videoId, title: video.title, sub: video.channel },
        ...related.map((item) => ({ videoId: item.videoId, title: item.title, sub: item.channel })),
      ];
      pushRoute("music");
      setMode("music");
      play(video.videoId, video.title, video.channel, list, 0);
    };
  }
  const copyBtn = $("ytCopyLink");
  if (copyBtn) {
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        toast("Link copied");
      } catch { toast("Couldn’t copy link"); }
    };
  }
  ytWatchEl.querySelectorAll(".yt-rel[data-vid]").forEach((card) => {
    card.onclick = () => openYtVideo(card.dataset.vid);
  });
  setupYtPlayback(video.videoId, watchUrl, (title, author) => {
    const h1 = ytWatchEl.querySelector("h1");
    if (h1 && (!video.title || h1.textContent === "Loading…") && title) {
      h1.textContent = title;
      document.title = `${title} - WebTube`;
    }
    if (author && (!video.channel || video.channel === "Unknown channel")) {
      const who = ytWatchEl.querySelector(".who b");
      if (who) who.textContent = author;
      const av = ytWatchEl.querySelector(".yt-avatar");
      if (av) av.textContent = author.trim().charAt(0).toUpperCase() || "?";
    }
  });
}
function setupYtPlayback(videoId, watchUrl, onMeta) {
  const host = $("ytPlayer");
  if (!host) return;
  const fallback = (message) => {
    host.innerHTML = `<div class="yt-fallback"><p>${esc(message)}</p><a class="yt-action" href="${esc(watchUrl)}" target="_blank" rel="noopener">Open on YouTube ↗</a></div>`;
  };
  // Primary: official YouTube player (plays in the visitor's browser).
  startYtEmbed(
    videoId,
    () => setupYtStreams(videoId, host, fallback),
    onMeta,
  );
}
async function setupYtStreams(videoId, host, fallback) {
  try {
    const data = await api(`/yt/streams/${encodeURIComponent(videoId)}`);
    const streams = data.streams || {};
    if (streams.video && streams.audio) {
      host.innerHTML = `
        <video id="ytVideo" controls autoplay playsinline preload="metadata" src="${esc(streams.video)}"></video>
        <audio id="ytAudio" preload="auto" src="${esc(streams.audio)}"></audio>
        <button class="yt-sound-note hidden" id="ytSoundNote" type="button">Click to enable sound</button>`;
      const video = $("ytVideo"), audio = $("ytAudio"), note = $("ytSoundNote");
      const playAudio = () => {
        audio.play().then(() => note.classList.add("hidden")).catch(() => note.classList.remove("hidden"));
      };
      video.addEventListener("loadedmetadata", () => { audio.currentTime = video.currentTime; });
      video.addEventListener("play", playAudio);
      video.addEventListener("pause", () => audio.pause());
      video.addEventListener("seeking", () => { audio.currentTime = video.currentTime; });
      video.addEventListener("ratechange", () => { audio.playbackRate = video.playbackRate; });
      video.addEventListener("volumechange", () => { audio.volume = video.volume; audio.muted = video.muted; });
      video.addEventListener("waiting", () => audio.pause());
      video.addEventListener("playing", () => { if (audio.paused) playAudio(); });
      video.addEventListener("timeupdate", () => {
        if (audio.readyState >= 1 && Math.abs(audio.currentTime - video.currentTime) > 0.3) {
          audio.currentTime = video.currentTime;
        }
      });
      video.addEventListener("ended", () => audio.pause());
      video.addEventListener("error", () => fallback("Playback failed. Open on YouTube."));
      note.onclick = playAudio;
      if (!video.paused) playAudio();
      return;
    }
    if (streams.muxed) {
      host.innerHTML = `<video id="ytVideo" controls autoplay playsinline preload="metadata" src="${esc(streams.muxed)}"></video>`;
      $("ytVideo").addEventListener("error", () => fallback("Playback failed. Open on YouTube."));
      return;
    }
    fallback("No playable streams found for this video.");
  } catch (e) {
    fallback(e.message || "Video failed to load.");
  }
}
async function doYtSearch() {
  stopYtPlayback();
  const q = $("q").value.trim();
  if (!q) return;
  saveRecent(q);
  $("recentPanel").classList.add("hidden");
  pushRoute("yt");
  ytHomeEl.classList.add("hidden");
  ytWatchEl.innerHTML = "";
  ytWatchEl.classList.add("hidden");
  ytResultsEl.classList.remove("hidden");
  setStatus("Searching WebTube…");
  try {
    const params = new URLSearchParams({ q, filter: ytFilter, limit: 36 });
    const data = await api("/yt/search?" + params);
    const items = data.results || [];
    const label = ytFilter === "songs" ? "Songs" : "Videos";
    setStatus(items.length ? `${items.length} ${label.toLowerCase()} for “${q}”` : `No ${label.toLowerCase()} for “${q}”`);
    ytResultsEl.innerHTML = `<h2 class="yt-section-title">${label} · ${esc(q)}</h2>` +
      (items.length ? `<div class="yt-grid">${items.map(ytCard).join("")}</div>` : `<div class="yt-empty">No results found.</div>`);
    bindYtCards(ytResultsEl);
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (e) {
    setStatus("WebTube search failed: " + e.message);
  }
}

document.querySelectorAll("#ytChips .chip").forEach((chip) => {
  chip.onclick = () => {
    document.querySelectorAll("#ytChips .chip").forEach((other) => other.classList.remove("active"));
    chip.classList.add("active");
    ytFilter = chip.dataset.filter || "videos";
    if ($("q").value.trim()) doYtSearch();
  };
});
$("modeMusic").onclick = () => {
  if (mode === "music") return;
  pushRoute("music");
  setMode("music");
};
$("modeYt").onclick = () => {
  if (mode === "youtube") {
    showYtHome();
    return;
  }
  pushRoute("yt");
  setMode("youtube");
  showYtHome();
};

function applyRoute() {
  const hash = location.hash.replace(/^#/, "");
  if (hash === "yt" || hash.startsWith("yt/")) {
    setMode("youtube");
    if (hash.startsWith("yt/") && hash.length > 3) {
      loadYtVideo(decodeURIComponent(hash.slice(3)));
    } else {
      showYtHome();
    }
    return;
  }
  setMode("music");
  try { localStorage.setItem(MODE_KEY, "music"); } catch { /* ignore */ }
  if (!musicViewReady) {
    musicViewReady = true;
    renderMouseLockCard();
    renderContinue();
  }
}

window.addEventListener("popstate", applyRoute);
if (!location.hash) {
  let saved = "music";
  try { saved = localStorage.getItem(MODE_KEY) || "music"; } catch { /* ignore */ }
  if (saved === "youtube") history.replaceState(null, "", "#yt");
}
applyRoute();
