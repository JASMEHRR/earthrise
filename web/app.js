/* Earthrise: Spotify now-playing visualizer for TV, phone and browser.
   Song wheel (bottom-left), synced lyrics (left), record with sound bars (centre),
   a background scene picked from the song's genre, and a side drawer for music, setup and settings. */
(function () {
'use strict';

/* ---------- pure helpers (also loaded by tests/lib.test.js under Node) ---------- */
var STOP = {};
('a an and are as at be but by do for from go got had has have he her him his i if im in is it its just la me my na no ' +
 'not of oh on or our out over she so that the their them then there they this to too up us was we were what when ' +
 'where who will with yeah you your ya ooh uh ah hey cause dont cant wont aint ill ive id youre ' +
 // common Hindi and Punjabi filler words, romanised and in script
 'hai ki ka ke mein main tu tera teri mera meri ho na se jo ye wo toh bhi hi nahi yeh woh hain kya ' +
 'है की का के में मैं तू तेरा तेरी मेरा मेरी हो ना से जो ये वो तो भी ही नहीं हैं')
  .split(' ').forEach(function (w) { STOP[w] = true; });

function parseLrc(text) {
  if (typeof text !== 'string' || !text) return null;
  var out = [];
  text.split(/\r?\n/).forEach(function (line) {
    var re = /\[(\d+):(\d+(?:\.\d+)?)\]/g, m, times = [];
    while ((m = re.exec(line)) !== null) times.push((Number(m[1]) * 60 + Number(m[2])) * 1000);
    if (!times.length) return;
    var words = line.replace(/\[[^\]]*\]/g, '').trim();
    times.forEach(function (t) { out.push({ t: Math.round(t), text: words }); });
  });
  out.sort(function (a, b) { return a.t - b.t; });
  return out.length ? out : null;
}

function lineIndexAt(lines, ms) {
  if (!lines || !lines.length) return -1;
  var lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (lines[mid].t <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function norm(w) { return w.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, ''); }

/* Picks a lively accent colour from RGBA pixel data (e.g. a 24x24 album cover).
   Returns [r,g,b] brightened for use on black, or null when the image is basically grey. */
function vibrantColor(data) {
  var wr = 0, wg = 0, wb = 0, wsum = 0;
  for (var i = 0; i + 3 < data.length; i += 4) {
    var r = data[i], g = data[i + 1], b = data[i + 2];
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    var sat = mx ? (mx - mn) / mx : 0, lum = mx / 255;
    var w = sat * sat * lum * (lum > .2 ? 1 : .1);
    wr += r * w; wg += g * w; wb += b * w; wsum += w;
  }
  if (!wsum || wsum < data.length / 4 * .02) return null;
  var rgb = [wr / wsum, wg / wsum, wb / wsum];
  var mx2 = Math.max(rgb[0], rgb[1], rgb[2]), mn2 = Math.min(rgb[0], rgb[1], rgb[2]);
  if (mx2 - mn2 < 18) return null;
  var scale = 235 / mx2, grey = (mx2 + mn2) / 2 * scale;
  return rgb.map(function (c) { return Math.round(Math.max(0, Math.min(255, grey + (c * scale - grey) * 1.15))); });
}

/* Turns a lyric line into rows of {w, big}. "*word*" forces big; "/" forces a new row.
   Without markers, content words are big and filler words small, like a poster. */
function layoutLine(text, maxWeight) {
  maxWeight = maxWeight || 13;
  if (typeof text !== 'string') return [];
  if (text.indexOf('*') >= 0 || text.indexOf('/') >= 0) {
    return text.split('/').map(function (r) {
      return r.trim().split(/\s+/).filter(Boolean).map(function (w) {
        return { w: w.replace(/\*/g, ''), big: /^\*.+\*$/.test(w) };
      });
    }).filter(function (r) { return r.length; });
  }
  var words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  var items = words.map(function (w) { var n = norm(w); return { w: w, big: n.length >= 3 && !STOP[n] }; });
  if (!items.some(function (x) { return x.big; })) {
    var best = 0;
    items.forEach(function (x, i) { if (norm(x.w).length > norm(items[best].w).length) best = i; });
    items[best].big = true;
  }
  var rows = [], row = [], weight = 0;
  items.forEach(function (x) {
    var wgt = x.w.length * (x.big ? 1.9 : 1) + 1;
    if (row.length && weight + wgt > maxWeight) { rows.push(row); row = []; weight = 0; }
    row.push(x); weight += wgt;
  });
  if (row.length) rows.push(row);
  return rows;
}

/* Background scene for a list of Spotify artist genres, or null when nothing matches. */

function hashString(s) {
  var h = 2166136261;
  s = String(s || '');
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// Calm lyric styles. 'auto' (the default) rotates them: each song gets one, the same one every time it plays.
var TEXT_STYLES = ['rise', 'blur', 'karaoke', 'type'];
function textStyleFor(songId, setting) {
  if (TEXT_STYLES.indexOf(setting) >= 0) return setting;
  return songId ? TEXT_STYLES[hashString(songId) % TEXT_STYLES.length] : 'rise';
}

/* A YouTube video id is 11 letters, digits, - or _. */
function isVideoId(s) { return typeof s === 'string' && /^[A-Za-z0-9_-]{11}$/.test(s); }
/* Video ids from a YouTube Data API search response, best match first. */
function videoIdsFrom(json) {
  var items = (json && json.items) || [], out = [];
  for (var i = 0; i < items.length; i++) {
    var v = items[i] && items[i].id && items[i].id.videoId;
    if (isVideoId(v) && out.indexOf(v) < 0) out.push(v);
  }
  return out;
}
/* "PT3M48S" (YouTube's duration format) in milliseconds; 0 when it cannot be read. */
function isoDurationMs(s) {
  var m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s || '');
  if (!m) return 0;
  return (((+m[1] || 0) * 24 + (+m[2] || 0)) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0)) * 1000;
}
/* Orders search results for a song, best music video first. Drops vertical clips (Shorts) and anything under a
   minute. Then scores each: lower is better. The official video usually runs about as long as the track and says
   "official video" in its title; live, lyric, cover and behind-the-scenes uploads are pushed down, and so is any
   video whose title does not contain the song's name.
   ids: search order. details: videos.list items (contentDetails, player, snippet). trackMs, title: the song. */
var VIDEO_PENALTIES = [
  [/official\s+(music\s+)?video|official\s+mv\b/i, -8],
  [/lyric/i, 4], [/\blive\b|concert|\bdome\b/i, 6], [/official\s+audio|\baudio\b|visuali[sz]er/i, 5],
  [/behind\s+the\s+scenes|making\s+of|\bbts\b|teaser|trailer|reaction|\bcover\b|karaoke|instrumental|slowed|reverb|\b8d\b|remix|#shorts/i, 10]
];
function rankVideos(ids, details, trackMs, title) {
  var info = {}, want = title ? norm(String(title)) : '';
  ((details && details.items) || []).forEach(function (v) {
    if (!v || !isVideoId(v.id)) return;
    var w = Number(v.player && v.player.embedWidth) || 0, h = Number(v.player && v.player.embedHeight) || 0;
    info[v.id] = { ms: isoDurationMs(v.contentDetails && v.contentDetails.duration), vertical: h > w && w > 0,
      title: (v.snippet && v.snippet.title) || '' };
  });
  return (ids || []).filter(function (id) {
    var v = info[id];
    return !v || (!v.vertical && (!v.ms || v.ms >= 60000));
  }).map(function (id, i) {
    var v = info[id], score = 30; // nothing known about it: after any video we know is close
    if (v) {
      score = v.ms && trackMs ? Math.min(30, Math.abs(v.ms - trackMs) / 10000) : 10;
      VIDEO_PENALTIES.forEach(function (p) { if (p[0].test(v.title)) score += p[1]; });
      if (want && norm(v.title).indexOf(want) < 0) score += 12; // probably a different song by the same artist
    }
    return { id: id, score: score, i: i };
  }).sort(function (a, b) { return a.score - b.score || a.i - b.i; }).map(function (x) { return x.id; });
}
/* YouTube's free daily quota resets at midnight Pacific time; 08:00 UTC is the later of the two (PST). */
function quotaResetAt(now) {
  var d = new Date(now); d.setUTCHours(8, 0, 0, 0);
  if (d.getTime() <= now) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}
/* Largest photo from a Spotify images list (Spotify lists them biggest first, but do not rely on it). */
function largestImage(images) {
  var best = null;
  (images || []).forEach(function (im) { if (im && im.url && (!best || (im.width || 0) > (best.width || 0))) best = im; });
  return best ? best.url : '';
}

/* What a spoken request (Jarvis: "play X on Spotify") asks for. Examples:
   "Kesariya" (a song, or your playlist with that exact name), "Lover by Diljit Dosanjh", "my road trip playlist",
   "Kesariya from my road trip playlist", "my liked songs", "Tum Hi Ho from liked songs", "album Brahmastra",
   "songs by Arijit Singh", "shuffle my liked songs", "search Arijit". */
var LIKED_RE = /^(?:my\s+|the\s+)?(?:liked|likes|favou?rites?|saved)(?:\s+(?:songs|tracks|music))?$/i;
function parseRequest(q) {
  var s = String(q || '').trim().replace(/[.!?]+$/, '').replace(/\s+on\s+spotify$/i, '')
    .replace(/^(?:please\s+)?(?:play|put\s+on|start)\s+/i, '').replace(/\s+/g, ' ').trim();
  var out = { kind: 'any', text: s, from: '', by: '', shuffle: false }, m;
  if (/^shuffle\b/i.test(s)) { out.shuffle = true; s = out.text = s.replace(/^shuffle\s*/i, ''); }
  if ((m = /^(?:search(?:\s+for)?|find|look\s+for|show(?:\s+me)?)\s+(.+)$/i.exec(s))) { out.kind = 'search'; out.text = m[1]; return out; }
  if (!s || LIKED_RE.test(s)) { out.kind = 'liked'; out.text = ''; return out; }
  if ((m = /^(.+?)\s+from\s+(.+)$/i.exec(s))) {
    var where = m[2].replace(/^(?:my|the)\s+/i, '').replace(/\s+playlist$/i, '').trim();
    out.text = m[1];
    if (LIKED_RE.test(m[2]) || LIKED_RE.test(where)) { out.kind = 'inLiked'; return out; }
    out.kind = 'inPlaylist'; out.from = where; return out;
  }
  if ((m = /^(?:the\s+)?album\s+(.+)$/i.exec(s))) { out.kind = 'album'; out.text = m[1]; return out; }
  if ((m = /^(?:songs|music|tracks)\s+(?:by|of)\s+(.+)$|^(?:the\s+)?artist\s+(.+)$/i.exec(s))) { out.kind = 'artist'; out.text = m[1] || m[2]; return out; }
  if ((m = /^(?:my\s+|the\s+)?(.+?)\s+playlist$|^playlist\s+(.+)$/i.exec(s))) { out.kind = 'playlist'; out.text = m[1] || m[2]; return out; }
  if ((m = /^(.+?)\s+by\s+(.+)$/i.exec(s))) { out.kind = 'track'; out.text = m[1]; out.by = m[2]; return out; }
  return out;
}
/* The item whose title best matches spoken words: exact, then starts with, then contains (letters only, any case). */
function bestMatch(items, text) {
  var want = norm(String(text || '')), best = null, bestScore = 0;
  if (!want) return null;
  (items || []).forEach(function (x) {
    var t = norm(String((x && x.title) || '')), sc = 0;
    if (!t) return;
    if (t === want) sc = 4;
    else if (t.indexOf(want) === 0) sc = 3;
    else if (t.indexOf(want) >= 0) sc = 2;
    else if (want.indexOf(t) >= 0 && t.length >= 3) sc = 1;
    if (sc > bestScore) { best = x; bestScore = sc; }
  });
  return best;
}

var Lib = { parseLrc: parseLrc, parseRequest: parseRequest, bestMatch: bestMatch, lineIndexAt: lineIndexAt, layoutLine: layoutLine, vibrantColor: vibrantColor,
  textStyleFor: textStyleFor, TEXT_STYLES: TEXT_STYLES,
  isVideoId: isVideoId, videoIdsFrom: videoIdsFrom, quotaResetAt: quotaResetAt, largestImage: largestImage,
  isoDurationMs: isoDurationMs, rankVideos: rankVideos };
if (typeof module !== 'undefined' && module.exports) { module.exports = Lib; return; }

/* ---------- setup ---------- */
var TAU = Math.PI * 2;
var $ = function (id) { return document.getElementById(id); };
var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
var rand = function (a, b) { return a + Math.random() * (b - a); };
var native = window.EarthriseNative || null;
var REDIRECT = native ? 'earthrise://callback' : location.origin + location.pathname;
var SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state ' +
  'user-read-recently-played playlist-read-private playlist-read-collaborative user-library-read';
var LIBRARY_SCOPES = ['user-read-recently-played', 'playlist-read-private', 'user-library-read'];
var API = 'https://api.spotify.com/v1';
var BPM = 118;
// Calm backdrops only, and the same one for every song (the per-genre lasers, grids, rain and embers felt gimmicky).
var SCENES_LIST = ['cover', 'artist', 'video', 'stars', 'aurora'];

var store = {
  get: function (k, d) { try { var v = localStorage.getItem('er.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set: function (k, v) { try { localStorage.setItem('er.' + k, JSON.stringify(v)); } catch (e) { /* storage blocked: lasts this visit only */ } },
  del: function (k) { try { localStorage.removeItem('er.' + k); } catch (e) { /* same as above */ } }
};
var settings = Object.assign({ motion: true, clock: true, lyrics: true, liveAudio: true, ring: true, colour: true, info: true,
  drift: true, lyricOffset: 0, textStyle: 'auto', scene: 'cover' }, store.get('settings', {}));
// choices that no longer exist fall back to the defaults
if (settings.textStyle !== 'auto' && TEXT_STYLES.indexOf(settings.textStyle) < 0) settings.textStyle = 'auto';
if (settings.scene !== 'off' && SCENES_LIST.indexOf(settings.scene) < 0) settings.scene = 'cover';
function saveSettings() { store.set('settings', settings); }

var stage = $('stage'), cv = $('scene'), ctx = cv.getContext('2d');
var mini = $('mini'), mctx = mini.getContext('2d');
var lyrEl = $('lyrics'), rowsEl = $('rows'), videoEl = $('video');

var W = 0, H = 0, DPR = 1, portrait = false, geo = {};
var BARS = 120, HALF = BARS / 2;
var sm = new Float32Array(HALF), target = new Float32Array(HALF), bassSm = 0;
var angle = 0, miniAngle = 0, last = 0, clockT = 0;
var disc = null, discPrev = null, discFade = 1, artImg = null, blankDisc = null;
var coverBg = null, coverPrev = null, coverFade = 1;
var accent = [255, 255, 255], accentTarget = [255, 255, 255];
var lyricKey = '';

var token = store.get('token', null);
// Earthrise Link (link/ in this repo): the laptop holds the Spotify login and hands this TV tokens.
var link = store.get('link', null); // { base: 'http://192.168.x.x:5173', secret, name, v: 2 }
// Since v2 the laptop hands its Spotify login over once and then forgets it, so links saved by older
// versions (which kept asking the laptop for tokens) no longer work: drop them and show Connect again.
if (link && link.v !== 2) { link = null; store.del('link'); if (token && token.linked) { token = null; store.del('token'); } }
var np = { item: null, playing: false, progress: 0, at: 0, changedAt: 0, device: '', pausedAt: 0 };
var queue = [], lastQueueAt = 0, rowsSig = '';
var lyrics = null, lyricCache = {}, lyricInflight = {};
var genreCache = {}, artistImgCache = {};
var artistImg = null, artistKey = '', artistBg = null, artistBlur = null, artistPrev = null, artistPrevBlur = null, artistFade = 1;
var backoffUntil = 0, pollTimer = 0, refreshing = null;

/* ?demo=1 shows a fake song with sample lines, for previewing without a Spotify login */
var DEMO = /[?&]demo=1\b/.test(location.search);
var DEMO_LRC = '[00:00.50]I keep the signal in my sight\n[00:04.50]Every city burning bright\n[00:08.50]Spin the planet slow\n' +
  '[00:12.50]Nowhere left to go\n[00:16.50]Falling up through the quiet\n[00:20.50]Weightless in the blue\n[00:24.50]Hold on to the orbit\n[00:28.50]Pulling me back to you\n[00:32.50]';
function connected() { return !!token || !!link || DEMO; }
function startDemo() {
  np = { item: { id: 'demo', title: 'Orbit Line', artist: 'Demo mode', album: '', duration: 33000, art: '', thumb: '', uri: '' },
    playing: true, progress: 0, at: performance.now(), changedAt: performance.now(), device: 'Demo speaker', pausedAt: 0 };
  lyrics = { id: 'demo', lines: parseLrc(DEMO_LRC), loading: false };
  queue = ['Low Gravity', 'Signal Fire', 'Night Bus', 'Paper Moons', 'Static Hearts', 'Blue Hour'].map(function (t, i) {
    return { id: 'q' + i, title: t, artist: 'Demo mode', thumb: '', uri: '' };
  });
  np.item.album = 'Demo album';
  accentTarget = [120, 190, 255];
  // a made-up cover so the record and the "Album cover" background have something to show
  var art = document.createElement('canvas'); art.width = art.height = 300;
  var ag = art.getContext('2d'), lg = ag.createLinearGradient(0, 0, 300, 300);
  lg.addColorStop(0, '#0b2a4a'); lg.addColorStop(.55, '#2f6fb0'); lg.addColorStop(1, '#f0a35c');
  ag.fillStyle = lg; ag.fillRect(0, 0, 300, 300);
  ag.fillStyle = 'rgba(255,255,255,.85)'; ag.beginPath(); ag.arc(210, 95, 42, 0, TAU); ag.fill();
  ag.fillStyle = '#071827'; ag.beginPath(); ag.moveTo(0, 300); ag.lineTo(0, 210); ag.lineTo(90, 150); ag.lineTo(170, 220); ag.lineTo(240, 170); ag.lineTo(300, 230); ag.lineTo(300, 300); ag.fill();
  setTimeout(function () { setDisc(art); }, 0);
  setInterval(function () { if (np.playing && progressMs() > 33000) { np.progress = 0; np.at = performance.now(); } }, 500);
  // preview helpers: ?scene=rain picks a background for this visit, ?artistImg= a Spotify photo, ?video= a YouTube id
  var sc = demoParam('scene');
  if (sc === 'off' || SCENES_LIST.indexOf(sc) >= 0) settings.scene = sc;
  var ai = demoParam('artistImg');
  if (/^https:\/\/i\.scdn\.co\/image\/[A-Za-z0-9]+$/.test(ai)) setTimeout(function () { loadArtistImage(ai); }, 0);
}
function demoParam(name) {
  var m = new RegExp('[?&]' + name + '=([^&]*)').exec(location.search);
  try { return m ? decodeURIComponent(m[1]) : ''; } catch (e) { return ''; }
}

function clientId() {
  var id = '';
  try { id = native && native.getClientId ? String(native.getClientId() || '') : ''; } catch (e) { id = ''; }
  return id || store.get('clientId', '');
}
function clientIdBaked() { try { return !!(native && native.getClientId && native.getClientId()); } catch (e) { return false; } }
function progressMs() { return np.playing ? np.progress + (performance.now() - np.at) : np.progress; }
function hasScopes(list) {
  if (!token || !token.scope) return false;
  var have = token.scope.split(' ');
  return list.every(function (s) { return have.indexOf(s) >= 0; });
}

/* ---------- toast ---------- */
var toastTimer = 0;
function toast(msg) {
  var t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 5000);
}

/* ---------- Spotify login (PKCE, no secret needed) ---------- */
function b64url(bytes) {
  var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomString(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a).slice(0, n); }

function connect() {
  var id = clientId();
  if (!id) { openDrawer('connect'); toast('Add your Spotify Client ID first (step 4).'); setTimeout(function () { $('cid').focus(); }, 350); return; }
  if (!window.crypto || !crypto.subtle) { toast('Spotify login needs a secure page. Open it from the app or over https.'); return; }
  var verifier = randomString(64), state = randomString(16);
  crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then(function (digest) {
    store.set('verifier', verifier); store.set('state', state);
    var p = new URLSearchParams({
      response_type: 'code', client_id: id, scope: SCOPES, redirect_uri: REDIRECT,
      code_challenge_method: 'S256', code_challenge: b64url(new Uint8Array(digest)), state: state
    });
    location.href = 'https://accounts.spotify.com/authorize?' + p.toString();
  }).catch(function () { toast('Could not start the Spotify login.'); });
}

function tokenRequest(body) {
  return fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body)
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (!r.ok) throw new Error(j.error_description || j.error || ('HTTP ' + r.status));
      token = { access: j.access_token, refresh: j.refresh_token || (token && token.refresh),
        exp: Date.now() + (j.expires_in || 3600) * 1000, scope: j.scope || (token && token.scope) || '' };
      store.set('token', token);
    });
  });
}

function handleCallback() {
  var q = new URLSearchParams(location.search), code = q.get('code'), err = q.get('error');
  if (!code && !err) return Promise.resolve();
  history.replaceState(null, '', location.pathname + (DEMO ? '?demo=1' : ''));
  if (err) { toast('Spotify login was cancelled.'); return Promise.resolve(); }
  if (q.get('state') !== store.get('state', null)) { toast('Login check failed. Try Connect Spotify again.'); return Promise.resolve(); }
  return tokenRequest({ grant_type: 'authorization_code', code: code, redirect_uri: REDIRECT, client_id: clientId(), code_verifier: store.get('verifier', '') })
    .then(function () { toast('Spotify connected. Play something on any device.'); })
    .catch(function (e) { toast('Spotify login failed: ' + e.message); })
    .then(function () { store.del('verifier'); store.del('state'); });
}

function disconnect() {
  token = null; store.del('token');
  link = null; store.del('link'); linkPair = null;
  np = { item: null, playing: false, progress: 0, at: 0, changedAt: 0, device: '', pausedAt: 0 };
  queue = []; lyrics = null; library = {}; clearTimeout(pollTimer);
  accentTarget = [255, 255, 255]; setDisc(null); buildRows(); ui(); renderDrawer();
}

function accessToken() {
  if (link && (!token || token.linked)) { // the laptop refreshes the login; ask it again when under 2 minutes left
    if (token && Date.now() < token.exp - 120000) return Promise.resolve(token.access);
    if (!refreshing) {
      refreshing = linkToken().then(function (v) { refreshing = null; return v; }, function (e) { refreshing = null; throw e; });
    }
    return refreshing;
  }
  if (!token) return Promise.resolve(null);
  if (Date.now() < token.exp - 60000) return Promise.resolve(token.access);
  if (!refreshing) {
    refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh, client_id: clientId() })
      .catch(function (e) {
        if (/invalid|revoked|expired/i.test(e.message)) { disconnect(); toast('Spotify login expired. Connect again.'); }
        throw e;
      })
      .then(function (v) { refreshing = null; return v; }, function (e) { refreshing = null; throw e; });
  }
  return refreshing.then(function () { return token && token.access; });
}

function api(path, opts, retried) {
  opts = opts || {};
  return accessToken().then(function (t) {
    if (!t) throw new Error('not connected');
    var init = { method: opts.method || 'GET', headers: { Authorization: 'Bearer ' + t } };
    if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    return fetch(API + path, init);
  }).then(function (r) {
    if (r.status === 401 && !retried && token) { token.exp = 0; return api(path, opts, true); }
    if (r.status === 429) {
      backoffUntil = Date.now() + (Number(r.headers.get('Retry-After')) || 5) * 1000;
      throw new Error('rate limited');
    }
    return r;
  });
}
function apiJson(path) { return api(path).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }); }

/* ---------- now playing ---------- */
function artistsOf(it) { return it.artists ? it.artists.map(function (a) { return a.name; }).join(', ') : (it.show ? it.show.name : ''); }
function imagesOf(it) { return (it.album ? it.album.images : it.images) || []; }
function toItem(it) {
  var imgs = imagesOf(it);
  return { id: it.id || it.uri, uri: it.uri || '', title: it.name || '', artist: artistsOf(it),
    artistId: it.artists && it.artists[0] ? it.artists[0].id : '', album: it.album ? it.album.name : '',
    duration: it.duration_ms || 0, art: imgs.length ? imgs[0].url : '', thumb: imgs.length ? imgs[imgs.length - 1].url : '' };
}

function poll() {
  clearTimeout(pollTimer);
  if (!token && !link) return;
  var delay = 3000;
  if (Date.now() < backoffUntil) { pollTimer = setTimeout(poll, backoffUntil - Date.now()); return; }
  var t0 = performance.now();
  api('/me/player?additional_types=track,episode').then(function (r) {
    var rtt = performance.now() - t0;
    if (r.status === 204) { setNothing(); delay = 5000; return; }
    if (!r.ok) { delay = 8000; return; }
    return r.json().then(function (j) { applyPlayback(j, rtt); delay = j.is_playing ? 2500 : 5000; });
  }).catch(function () { delay = 8000; }).then(function () {
    if (np.item && Date.now() - lastQueueAt > 20000) loadQueue();
    if (token || link) pollTimer = setTimeout(poll, document.hidden ? 15000 : delay);
  });
}

function setNothing() {
  if (np.item) { np.item = null; queue = []; lyrics = null; setDisc(null); buildRows(); accentTarget = [255, 255, 255]; }
  np.playing = false; np.device = ''; ui();
}

function applyPlayback(j, rtt) {
  var it = j && j.item;
  if (!it) { setNothing(); return; }
  var id = it.id || it.uri, wasPlaying = np.playing;
  np.playing = !!j.is_playing;
  if (wasPlaying && !np.playing) np.pausedAt = performance.now();
  np.device = j.device && j.device.name ? j.device.name : '';
  np.progress = (j.progress_ms || 0) + (np.playing ? rtt / 2 : 0);
  np.at = performance.now();
  if (!np.item || np.item.id !== id) { np.item = toItem(it); onTrackChange(); }
  ui();
}

function onTrackChange() {
  lyricKey = ''; np.changedAt = performance.now();
  loadArt(np.item.art);
  loadLyrics(np.item);
  loadGenres(np.item);
  queue = []; buildRows(); loadQueue();
}

function loadQueue() {
  lastQueueAt = Date.now();
  apiJson('/me/player/queue').then(function (j) {
    if (!j || !j.queue) return;
    var seen = {}; queue = [];
    j.queue.forEach(function (it) {
      if (queue.length >= 20 || !it || seen[it.id]) return;
      seen[it.id] = true; queue.push(toItem(it));
    });
    buildRows(); renderInfo();
    if (drawerOpen() && drawerTab === 'music') renderDrawer();
    if (queue[0]) {
      prefetchLyrics(queue[0]);
      if (queue[0].art) { var pre = new Image(); pre.crossOrigin = 'anonymous'; pre.src = queue[0].art; }
    }
  }).catch(function () { /* queue is a nice-to-have; the wheel just shows the current song */ });
}

/* One artist lookup gives both the genres (for "Match the music") and the singer's photo. */
function loadGenres(item) {
  var aid = item.artistId;
  if (!aid) { loadArtistImage(''); return; }
  if (genreCache[aid]) { item.genres = genreCache[aid]; loadArtistImage(artistImgCache[aid] || ''); return; }
  apiJson('/artists/' + encodeURIComponent(aid)).then(function (j) {
    var g = (j && j.genres) || [];
    genreCache[aid] = g; artistImgCache[aid] = largestImage(j && j.images);
    if (np.item && np.item.artistId === aid) { np.item.genres = g; loadArtistImage(artistImgCache[aid]); ui(); }
  }).catch(function () {
    genreCache[aid] = []; artistImgCache[aid] = '';
    if (np.item && np.item.artistId === aid) loadArtistImage('');
  });
}

function checkPlayResponse(r) {
  if (r.status === 403) { toast('Choosing and skipping songs from here needs Spotify Premium.'); return false; }
  if (!r.ok) { toast('Spotify did not accept that (' + r.status + ').'); return false; }
  return true;
}
function firstDevice() {
  return apiJson('/me/player/devices').then(function (j) {
    var ds = ((j && j.devices) || []).filter(function (d) { return !d.is_restricted; });
    return ds.length ? ds[0].id : null;
  });
}
function control(action) {
  if (DEMO && !token) {
    if (action === 'play' || action === 'pause') { np.progress = progressMs(); np.at = performance.now(); np.playing = action === 'play'; ui(); }
    else toast('Demo mode: skipping works once Spotify is connected.');
    return Promise.resolve(true);
  }
  if (!token && !link) { connectSpotify(); return Promise.resolve(false); }
  var map = { play: ['PUT', '/me/player/play'], pause: ['PUT', '/me/player/pause'], next: ['POST', '/me/player/next'], prev: ['POST', '/me/player/previous'] };
  var m = map[action];
  return api(m[1], { method: m[0] }).then(function (r) {
    if (r.status === 404) { toast('No active Spotify device. Start playing on your phone or TV first.'); return false; }
    if (!checkPlayResponse(r)) return false;
    if (action === 'play' || action === 'pause') {
      np.progress = progressMs(); np.at = performance.now(); np.playing = action === 'play';
      if (!np.playing) np.pausedAt = performance.now();
      ui();
    }
    return true;
  }).catch(function () { toast('Could not reach Spotify.'); return false; })
    .then(function (ok) { setTimeout(poll, 450); return ok; });
}
function togglePlay() { return control(np.playing ? 'pause' : 'play'); }

/* Plays a track list or a playlist. Falls back to the first available device when none is active. */
/* On the TV, songs picked here (or asked for through Jarvis) play on this TV's own Spotify: the
   phone-style Spotify app on the stick, which keeps playing behind Earthrise. (Fire TV's Spotify TV
   app pauses whenever it is covered, so it is not used.) When that Spotify is not running it is not
   a device yet: Earthrise opens it in the background for a few seconds and comes back. */
var TV_NAME = /fire ?tv|aft[a-z]{2}/i;
function listDevices() { return apiJson('/me/player/devices').then(function (j) { return ((j && j.devices) || []).filter(function (d) { return !d.is_restricted; }); }); }
function tvDevice() {
  if (!native || !native.wakeSpotify) return Promise.resolve(null);
  var mine = function (ds) { return ds.filter(function (d) { return TV_NAME.test(d.name || ''); })[0] || null; };
  var wait = function (n) {
    return new Promise(function (res) { setTimeout(res, 1000); }).then(listDevices).then(function (ds) {
      return mine(ds) || (n > 0 ? wait(n - 1) : null);
    });
  };
  return listDevices().then(function (ds) {
    var d = mine(ds);
    if (d || !native.wakeSpotify()) return d;
    toast('Starting Spotify on this TV...');
    return wait(15);
  }).catch(function () { return null; });
}
function startPlayback(body, label) {
  if (DEMO && !token) { toast('Demo mode: connect Spotify to play your music.'); return Promise.resolve(false); }
  if (!token) { openDrawer('connect'); return Promise.resolve(false); }
  return tvDevice().then(function (tv) {
    return api('/me/player/play' + (tv ? '?device_id=' + encodeURIComponent(tv.id) : ''), { method: 'PUT', body: body });
  }).then(function (r) {
    if (native && native.backFromSpotify) native.backFromSpotify();
    if (r.status !== 404) return checkPlayResponse(r);
    return firstDevice().then(function (dev) {
      if (!dev) { toast('Open Spotify on your phone, PC or TV first, then pick again.'); return false; }
      return api('/me/player/play?device_id=' + encodeURIComponent(dev), { method: 'PUT', body: body }).then(checkPlayResponse);
    });
  }).then(function (ok) {
    if (ok && label) toast('Playing ' + label);
    if (ok) setTimeout(poll, 600);
    return ok;
  }).catch(function () { toast('Could not reach Spotify.'); return false; });
}
/** Plays what was asked for (from Jarvis in Glass Home): one of your playlists by name, else the best matching song. */
function playSearch(q) {
  q = String(q || '').trim();
  if (!q) return;
  if (!connected()) { openDrawer('connect'); toast('Connect Spotify first, then ask again.'); return; }
  var r = parseRequest(q);
  if (r.kind === 'search') { runSearch(r.text); return; }
  toast('Finding ' + q + '...');
  var nothing = function () { toast('Nothing on Spotify for ' + q + '.'); };
  var myLists = function () { return loadLibrary('playlists').catch(function () { return []; }); };
  var first = function (type, text) {
    return apiJson('/search?limit=5&type=' + type + '&q=' + encodeURIComponent(text)).then(function (j) {
      return ((j && j[type + 's'] && j[type + 's'].items) || []).filter(Boolean);
    });
  };
  var job;
  if (r.kind === 'liked' || r.kind === 'inLiked') {
    job = likedSongs().then(function (all) {
      if (!all.length) { toast('You have no liked songs yet.'); return; }
      if (r.kind === 'liked') return playThen({ uris: pickUris(all, 0, r.shuffle) }, 'your liked songs', r.shuffle);
      var hit = bestMatch(all, r.text);
      if (!hit) { toast('Could not find ' + r.text + ' in your liked songs.'); return; }
      return playThen({ uris: pickUris(all, all.indexOf(hit)) }, hit.title);
    });
  } else if (r.kind === 'inPlaylist') {
    job = myLists().then(function (lists) {
      var pl = bestMatch(lists, r.from);
      if (!pl) { toast('No playlist called ' + r.from + '.'); return; }
      return playlistSongs(pl.id).then(function (songs) {
        var hit = bestMatch(songs, r.text);
        if (!hit) { toast('Could not find ' + r.text + ' in ' + pl.title + '.'); return; }
        return playPlaylist(pl, hit.uri, r.shuffle);
      }, function (e) {
        if (!/HTTP 403/.test(String(e && e.message))) throw e;
        // someone else's playlist: Spotify will not list its songs to this app, but it can play the playlist
        toast('Spotify will not let Earthrise pick songs in a playlist you did not make. Playing ' + pl.title + '.');
        return playPlaylist(pl, '', r.shuffle);
      });
    });
  } else if (r.kind === 'playlist' || r.kind === 'any') {
    // your own playlist first (by name), then Spotify: a public playlist when one was asked for, else a song
    job = myLists().then(function (lists) {
      var pl = r.kind === 'playlist' ? bestMatch(lists, r.text) : (lists || []).filter(function (p) { return norm(p.title) === norm(r.text); })[0];
      if (pl) return playPlaylist(pl, '', r.shuffle);
      var type = r.kind === 'playlist' ? 'playlist' : 'track';
      return first(type, r.text).then(function (hits) {
        if (!hits.length) return nothing();
        if (type === 'playlist') return playThen({ context_uri: hits[0].uri }, hits[0].name, r.shuffle);
        return playThen({ uris: [hits[0].uri] }, hits[0].name + ' · ' + artistsOf(hits[0]));
      });
    });
  } else if (r.kind === 'album' || r.kind === 'artist') {
    job = first(r.kind, r.text).then(function (hits) {
      if (!hits.length) return nothing();
      return playThen({ context_uri: hits[0].uri }, hits[0].name, r.shuffle);
    });
  } else { // "song by artist": prefer a result by that artist; "Stand by Me" still works through the whole-phrase search
    job = first('track', r.text + ' ' + r.by).then(function (hits) {
      var by = norm(r.by), hit = hits.filter(function (t) { return norm(artistsOf(t)).indexOf(by) >= 0; })[0];
      if (hit) return hit;
      return first('track', r.text + ' by ' + r.by).then(function (h2) { return h2[0] || hits[0] || null; });
    }).then(function (hit) {
      if (!hit) return nothing();
      return playThen({ uris: [hit.uri] }, hit.name + ' · ' + artistsOf(hit));
    });
  }
  job.catch(function () { toast('Could not reach Spotify.'); });
}
window.onNativePlay = playSearch;
function playQueueFrom(index) {
  // index is 1-based into the queue (0 is the current song)
  if (index <= 0) return togglePlay();
  if (index <= 5) {
    var p = Promise.resolve(true);
    for (var i = 0; i < index; i++) p = p.then(function (ok) { return ok ? control('next') : false; });
    return p;
  }
  var uris = queue.slice(index - 1).map(function (q) { return q.uri; }).filter(Boolean);
  return startPlayback({ uris: uris }, queue[index - 1].title);
}

/* ---------- lyrics (LRCLIB, free synced lyrics) ---------- */
function loadLyrics(item) {
  var key = item.id;
  if (lyricCache[key]) { lyrics = lyricCache[key]; return; }
  lyrics = { id: key, lines: null, loading: true };
  fetchLyrics(item).then(function (res) { if (np.item && np.item.id === key) { lyrics = res; lyricKey = ''; } });
}
function prefetchLyrics(item) { if (item && item.id && !lyricCache[item.id]) fetchLyrics(item); }
function fetchLyrics(item) {
  var key = item.id;
  if (lyricInflight[key]) return lyricInflight[key];
  var artist = item.artist.split(', ')[0];
  var q = new URLSearchParams({ track_name: item.title, artist_name: artist, album_name: item.album, duration: String(Math.round(item.duration / 1000)) });
  lyricInflight[key] = fetch('https://lrclib.net/api/get?' + q.toString()).then(function (r) {
    if (r.ok) return r.json().then(function (j) { return j && j.syncedLyrics ? parseLrc(j.syncedLyrics) : null; });
    if (r.status !== 404) return null;
    var s = new URLSearchParams({ track_name: item.title, artist_name: artist });
    return fetch('https://lrclib.net/api/search?' + s.toString()).then(function (r2) { return r2.ok ? r2.json() : []; }).then(function (arr) {
      arr = Array.isArray(arr) ? arr : [];
      var secs = item.duration / 1000, hit = null;
      arr.forEach(function (x) { if (!hit && x.syncedLyrics && Math.abs((x.duration || 0) - secs) < 4) hit = x; });
      if (!hit) arr.forEach(function (x) { if (!hit && x.syncedLyrics) hit = x; });
      return hit ? parseLrc(hit.syncedLyrics) : null;
    });
  }).catch(function () { return null; }).then(function (lines) {
    var res = { id: key, lines: lines, loading: false };
    lyricCache[key] = res; delete lyricInflight[key];
    return res;
  });
  return lyricInflight[key];
}

function currentLyric() {
  if (!connected()) return { key: 'connect', text: '*Connect* / *Spotify*', dur: 4000 };
  if (!np.item) return { key: 'idle', text: '*Play* something / on *Spotify*', dur: 4000 };
  var it = np.item, justChanged = performance.now() - np.changedAt < 3500;
  if (settings.lyrics && !justChanged && lyrics && lyrics.id === it.id && lyrics.lines) {
    var p = progressMs() + 250 + (settings.lyricOffset || 0), i = lineIndexAt(lyrics.lines, p);
    if (i >= 0) {
      var L = lyrics.lines[i], nxt = lyrics.lines[i + 1];
      return { key: it.id + ':' + i, text: L.text, dur: nxt ? nxt.t - L.t : 4000, next: nxt ? nxt.text : '' };
    }
  }
  var title = it.title.replace(/\s*[\(\[].*?[\)\]]\s*/g, ' ').trim() || it.title;
  var bigTitle = title.split(/\s+/).map(function (w) { return '*' + w.replace(/[*/]/g, '') + '*'; }).join(' ');
  return { key: it.id + ':title', text: bigTitle + ' / ' + it.artist.replace(/[*/]/g, ''), dur: 4000 };
}

/* Six entrance styles. "auto" picks one per song so each track feels different. */
function showLyric(text, dur, nextText) {
  var style = textStyleFor(np.item ? np.item.id : '', settings.textStyle);
  var old = lyrEl.querySelector('.block:not(.out)');
  var rows = layoutLine(text, portrait ? 17 : 21);
  var count = rows.reduce(function (n, r) { return n + r.length; }, 0);
  lyrEl.className = 'lyrics anim-' + style + (count > 8 ? ' dense' : '');
  var blk = document.createElement('div'); blk.className = 'block';
  rows.forEach(function (r) {
    var row = document.createElement('div'); row.className = 'row';
    r.forEach(function (x) {
      var s = document.createElement('span'); s.className = 'w' + (x.big ? ' big' : '');
      if (style === 'type') {
        Array.prototype.forEach.call(x.w, function (ch) { var c = document.createElement('span'); c.className = 'ch'; c.textContent = ch; s.appendChild(c); });
      } else s.textContent = x.w;
      row.appendChild(s);
    });
    blk.appendChild(row);
  });
  if (nextText && count) { var nx = document.createElement('div'); nx.className = 'next'; nx.textContent = nextText; blk.appendChild(nx); }
  if (old) { old.classList.add('out'); setTimeout(function () { if (old.parentNode) old.remove(); }, settings.motion ? 420 : 0); }
  if (!count) return;
  lyrEl.appendChild(blk);
  var targets = blk.querySelectorAll(style === 'type' ? '.ch' : '.w'), n = targets.length;
  if (!settings.motion) { Array.prototype.forEach.call(targets, function (el) { el.classList.add('on'); }); return; }
  var d = dur || 4000, per;
  if (style === 'karaoke') per = clamp(d * .8 / n, 80, 700);
  else if (style === 'type') per = Math.min(45, d * .4 / n);
  else per = Math.min(110, d * .45 / n);
  Array.prototype.forEach.call(targets, function (el, k) { setTimeout(function () { el.classList.add('on'); }, 120 + k * per); });
}
function tickLyrics() {
  var c = currentLyric();
  if (c.key !== lyricKey) { lyricKey = c.key; showLyric(c.text, c.dur, c.next); }
}

/* ---------- record art and colour ---------- */
function makeDisc(img, px) {
  var c = document.createElement('canvas'); c.width = c.height = px;
  var g = c.getContext('2d'), R = px / 2;
  g.translate(R, R); g.beginPath(); g.arc(0, 0, R, 0, TAU); g.clip();
  if (img) {
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    var s = Math.max(px / iw, px / ih), w = iw * s, h = ih * s;
    g.drawImage(img, -w / 2, -h / 2, w, h);
  } else {
    var gr = g.createRadialGradient(-R * .3, -R * .35, R * .05, 0, 0, R);
    gr.addColorStop(0, '#3b4047'); gr.addColorStop(1, '#0c0e11');
    g.fillStyle = gr; g.fillRect(-R, -R, px, px);
  }
  var v = g.createRadialGradient(0, 0, R * .35, 0, 0, R);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.32)');
  g.fillStyle = v; g.fillRect(-R, -R, px, px);
  g.lineWidth = Math.max(.5, R / 300);
  for (var rr = R * .37, k = 0; rr < R * .985; rr += Math.max(1.6, R / 70), k++) {
    g.strokeStyle = 'rgba(0,0,0,' + (k % 3 ? .07 : .13) + ')'; g.beginPath(); g.arc(0, 0, rr, 0, TAU); g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = Math.max(1, R / 140);
  g.beginPath(); g.arc(0, 0, R * .34, 0, TAU); g.stroke();
  g.beginPath(); g.arc(0, 0, R * .035, 0, TAU); g.fillStyle = '#030303'; g.fill();
  return c;
}
function discPx() { return clamp(Math.ceil(geo.r * 2 * DPR), 64, 1024); }
/* Soft, blurred copy of the cover for the "Album cover" background. Made once per song at low size. */
function makeCoverBg(img) {
  var c = document.createElement('canvas'); c.width = c.height = 256;
  var g = c.getContext('2d');
  if ('filter' in g) { g.filter = 'blur(7px)'; g.drawImage(img, -24, -24, 304, 304); }
  else {
    var s = document.createElement('canvas'); s.width = s.height = 32;
    s.getContext('2d').drawImage(img, 0, 0, 32, 32);
    g.imageSmoothingEnabled = true; g.drawImage(s, 0, 0, 256, 256);
  }
  // how bright the cover is (0..1): bright covers get darkened more so white lyrics stay readable
  c.lum = 0.3;
  try {
    var d = g.getImageData(0, 0, 256, 256).data, sum = 0, n = 0;
    for (var i = 0; i < d.length; i += 64) { sum += .2126 * d[i] + .7152 * d[i + 1] + .0722 * d[i + 2]; n++; }
    c.lum = sum / n / 255;
  } catch (e) { /* cover from another site without CORS: keep the middle value */ }
  return c;
}
function setDisc(img) {
  artImg = img;
  coverPrev = coverBg; coverFade = settings.motion && coverPrev ? 0 : 1;
  coverBg = img ? makeCoverBg(img) : null;
  if (!W) return;
  discPrev = disc; discFade = settings.motion && discPrev ? 0 : 1;
  disc = img ? makeDisc(img, discPx()) : blankDisc;
}
/* ---------- singer photo background ---------- */
function loadArtistImage(url) {
  if (url === artistKey) return;
  artistKey = url;
  if (!url) { setArtist(null); return; }
  var img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = function () { if (artistKey === url) setArtist(img); };
  img.onerror = function () { if (artistKey === url) setArtist(null); };
  img.src = url;
}
function setArtist(img) {
  artistImg = img;
  artistPrev = artistBg; artistPrevBlur = artistBlur;
  artistFade = settings.motion && artistPrev ? 0 : 1;
  artistBg = img ? makeArtistBg(img) : null;
  artistBlur = img ? makeCoverBg(img) : null;
}
/* The photo with soft edges. On wide screens it fades out to the right, so the singer stands left of the record,
   behind the big lyric words, and the small song-info text on the right keeps a clean dark background. */
function makeArtistBg(img) {
  var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (!iw || !ih) return null;
  var s = Math.min(1, 720 / Math.max(iw, ih)), w = Math.round(iw * s), h = Math.round(ih * s);
  var c = document.createElement('canvas'); c.width = w; c.height = h;
  var g = c.getContext('2d'), m;
  g.drawImage(img, 0, 0, w, h);
  g.globalCompositeOperation = 'destination-in';
  if (!portrait) {
    m = g.createLinearGradient(0, 0, w, 0);
    m.addColorStop(0, 'rgba(0,0,0,.4)'); m.addColorStop(.1, 'rgba(0,0,0,1)'); m.addColorStop(.58, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = m; g.fillRect(0, 0, w, h);
  }
  m = g.createLinearGradient(0, 0, 0, h);
  m.addColorStop(0, 'rgba(0,0,0,.5)'); m.addColorStop(.14, 'rgba(0,0,0,1)'); m.addColorStop(.72, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = m; g.fillRect(0, 0, w, h);
  return c;
}
function drawArtistImage(c, blur, alpha, t, bass) {
  if (blur) drawCoverImage(blur, alpha * .45, t, bass);
  if (!c) return;
  var z = 1.03 + .03 * Math.sin(t * .045) + bass * .015, w, h, x, y;
  if (portrait) { w = W * 1.15 * z; h = w * c.height / c.width; x = (W - w) / 2; y = 0; }
  else {
    h = H * 1.06 * z; w = h * c.width / c.height;
    x = -W * .04 + Math.sin(t * .03) * W * .012; y = (H - h) / 2 + Math.cos(t * .025) * H * .012;
  }
  ctx.globalAlpha = alpha; ctx.drawImage(c, x, y, w, h); ctx.globalAlpha = 1;
}

function loadArt(url) {
  if (!url) { setDisc(null); accentTarget = [255, 255, 255]; return; }
  var img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = function () {
    if (!np.item || np.item.art !== url) return;
    setDisc(img);
    accentTarget = accentFrom(img) || [255, 255, 255];
  };
  img.onerror = function () { setDisc(null); accentTarget = [255, 255, 255]; };
  img.src = url;
}
function accentFrom(img) {
  try {
    var c = document.createElement('canvas'); c.width = c.height = 24;
    var g = c.getContext('2d'); g.drawImage(img, 0, 0, 24, 24);
    return vibrantColor(g.getImageData(0, 0, 24, 24).data);
  } catch (e) {
    return null; // cover served without CORS: keep white
  }
}
function curAccent() { return settings.colour ? accent : [255, 255, 255]; }
function accentRgba(a, mixWhite) {
  var m = mixWhite || 0, c = curAccent();
  return 'rgba(' + Math.round(c[0] + (255 - c[0]) * m) + ',' + Math.round(c[1] + (255 - c[1]) * m) + ',' + Math.round(c[2] + (255 - c[2]) * m) + ',' + a + ')';
}
function mixRgba(c2, m, a) {
  var c = curAccent();
  return 'rgba(' + Math.round(c[0] + (c2[0] - c[0]) * m) + ',' + Math.round(c[1] + (c2[1] - c[1]) * m) + ',' + Math.round(c[2] + (c2[2] - c[2]) * m) + ',' + a + ')';
}

/* ---------- background scenes, chosen from the song's genre ---------- */
var scene = { name: null, parts: null, fade: 0, t: 0 };
function sceneName() {
  if (settings.scene === 'off') return null;
  if (!connected() || !np.item) return 'stars';
  return SCENES_LIST.indexOf(settings.scene) >= 0 ? settings.scene : 'cover';
}
function drawCoverImage(c, alpha, t, bass) {
  var s = Math.max(W / c.width, H / c.height) * (1.08 + .04 * Math.sin(t * .05) + bass * .02);
  var w = c.width * s, h = c.height * s;
  ctx.globalAlpha = alpha;
  ctx.drawImage(c, (W - w) / 2 + Math.sin(t * .03) * W * .02, (H - h) / 2 + Math.cos(t * .025) * H * .02, w, h);
  ctx.globalAlpha = 1;
}
var SCENES = {
  cover: {
    init: function () { return []; },
    draw: function (p, dt, t, bass) {
      if (coverFade < 1) coverFade = Math.min(1, coverFade + dt * 1.2);
      if (coverPrev && coverFade < 1) drawCoverImage(coverPrev, 1, t, bass);
      if (coverBg) drawCoverImage(coverBg, coverPrev ? coverFade : 1, t, bass);
      else {
        var g0 = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * .7);
        g0.addColorStop(0, accentRgba(.35, .2)); g0.addColorStop(1, accentRgba(.05, .2));
        ctx.fillStyle = g0; ctx.fillRect(0, 0, W, H);
      }
      // darken so the record, lyrics and info stay readable (more for bright covers)
      var lum = coverBg && coverBg.lum != null ? coverBg.lum : .3;
      ctx.fillStyle = 'rgba(0,0,0,' + (.45 + .35 * lum - bass * .05) + ')'; ctx.fillRect(0, 0, W, H);
      var v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * .3, W / 2, H / 2, Math.max(W, H) * .75);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.65)');
      ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    }
  },
  artist: {
    init: function () { return []; },
    draw: function (p, dt, t, bass) {
      if (!artistBg && (!artistPrev || artistFade >= 1)) { SCENES.cover.draw(p, dt, t, bass); return; }
      if (artistFade < 1) artistFade = Math.min(1, artistFade + dt * 1.2);
      if (artistPrev && artistFade < 1) drawArtistImage(artistPrev, artistPrevBlur, 1, t, bass);
      if (artistBg) drawArtistImage(artistBg, artistBlur, artistPrev ? artistFade : 1, t, bass);
      // darken a little everywhere so the white lyrics stay readable, and more on the right behind the song info
      ctx.fillStyle = 'rgba(0,0,0,' + (.3 - bass * .05) + ')'; ctx.fillRect(0, 0, W, H);
      var lg = ctx.createLinearGradient(0, 0, W, 0);
      lg.addColorStop(0, 'rgba(0,0,0,.15)'); lg.addColorStop(.5, 'rgba(0,0,0,0)'); lg.addColorStop(1, 'rgba(0,0,0,.45)');
      ctx.fillStyle = lg; ctx.fillRect(0, 0, W, H);
    }
  },
  video: {
    init: function () { return []; },
    draw: function (p, dt, t, bass) {
      if (yt.mix < 1) SCENES.cover.draw(p, dt, t, bass);
      if (yt.mix <= 0) return;
      // cut through the canvas so the video underneath shows, then shade it so the record and text stay readable
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,' + yt.mix + ')'; ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(0,0,0,' + (.42 * yt.mix) + ')'; ctx.fillRect(0, 0, W, H);
      var v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * .3, W / 2, H / 2, Math.max(W, H) * .75);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,' + (.6 * yt.mix) + ')');
      ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    }
  },
  stars: {
    init: function () {
      var n = Math.round(clamp(W * H / 6000, 120, 320)), a = [];
      for (var i = 0; i < n; i++) a.push({ x: rand(-1, 1), y: rand(-1, 1), z: Math.random() });
      return a;
    },
    draw: function (p, dt, t, bass) {
      var cx = W / 2, cy = geo.cy, sp = (.035 + bass * .12) * dt;
      for (var i = 0; i < p.length; i++) {
        var s = p[i]; s.z -= sp;
        var sx = cx + s.x / s.z * W * .18, sy = cy + s.y / s.z * H * .18;
        if (s.z <= .02 || sx < 0 || sx > W || sy < 0 || sy > H) { s.z = 1; s.x = rand(-1, 1); s.y = rand(-1, 1); continue; }
        var size = (1 - s.z) * 2.2 + .4;
        ctx.fillStyle = accentRgba((1 - s.z) * .75, .7);
        ctx.fillRect(sx, sy, size, size);
      }
    }
  },
  aurora: {
    init: function () {
      return [{ y: .2, amp: .06, f: 1.3, sp: .22, ph: rand(0, TAU) }, { y: .28, amp: .05, f: 1.9, sp: .3, ph: rand(0, TAU) }, { y: .36, amp: .045, f: 1.1, sp: .17, ph: rand(0, TAU) }];
    },
    draw: function (p, dt, t, bass) {
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < p.length; i++) {
        var b = p[i], top = H * (b.y - b.amp * 1.5);
        var g = ctx.createLinearGradient(0, top, 0, H * (b.y + .3));
        g.addColorStop(0, accentRgba(0, .1)); g.addColorStop(.25, accentRgba(.2 + bass * .1, .08 + i * .12)); g.addColorStop(1, accentRgba(0, .1));
        ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, H);
        for (var x = 0; x <= W + 1; x += W / 40) {
          var y = H * b.y + Math.sin(x / W * TAU * b.f + t * b.sp + b.ph) * H * b.amp * (1 + bass * .6) +
            Math.sin(x / W * TAU * b.f * 2.3 + t * b.sp * 1.7) * H * b.amp * .35;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }
};
function drawScene(dt, t, bass) {
  var n = sceneName();
  if (n !== scene.name) { scene.name = n; scene.parts = n ? SCENES[n].init() : null; scene.fade = 0; }
  if (!n) return;
  scene.fade = Math.min(1, scene.fade + dt * .6);
  ctx.globalAlpha = settings.motion ? scene.fade : 1;
  SCENES[n].draw(scene.parts, settings.motion ? dt : 0, t / 1000, bass);
  ctx.globalAlpha = 1;
}

/* ---------- music video background: a muted YouTube video kept at Spotify's position ---------- */
var yt = { player: null, ready: false, loading: false, pending: null, track: '', list: [], idx: 0, vid: '', status: '', visible: false, mix: 0, seekAt: 0 };
var ytCache = store.get('ytCache', {});
if (!ytCache || typeof ytCache !== 'object' || Array.isArray(ytCache)) ytCache = {};
function ytKey() {
  var k = '';
  try { k = native && native.getYoutubeKey ? String(native.getYoutubeKey() || '') : ''; } catch (e) { k = ''; }
  return k || store.get('ytKey', '');
}
function ytKeyBaked() { try { return !!(native && native.getYoutubeKey && native.getYoutubeKey()); } catch (e) { return false; } }
function setYtStatus(s) {
  if (yt.status === s) return;
  yt.status = s;
  if (drawerOpen() && drawerTab === 'settings') $('sceneNote').textContent = sceneNoteText();
}
function rememberVideos(trackId, ids) {
  ytCache[trackId] = ids;
  var keys = Object.keys(ytCache);
  if (keys.length > 400) keys.slice(0, keys.length - 300).forEach(function (k) { delete ytCache[k]; });
  store.set('ytCache', ytCache);
}
function findVideo(item) {
  yt.track = item.id; yt.list = []; yt.idx = 0; yt.vid = ''; yt.visible = false;
  // stop the last song's video so it does not keep downloading while hidden
  if (yt.ready) { try { yt.player.stopVideo(); } catch (e) { /* player already gone: nothing to stop */ } }
  if (DEMO && !token) {
    var d = demoParam('video');
    if (isVideoId(d)) playVideos([d]); else setYtStatus('demo');
    return;
  }
  if (Object.prototype.hasOwnProperty.call(ytCache, item.id)) { playVideos(ytCache[item.id]); return; }
  var key = ytKey();
  if (!key) { setYtStatus('nokey'); return; }
  if (Date.now() < store.get('ytQuotaUntil', 0)) { setYtStatus('quota'); return; }
  setYtStatus('searching');
  // first artist and the bare title: "(feat. X)" and "- Remastered" make searches worse
  var title = item.title.replace(/\s*[(\[][^)\]]*[)\]]/g, '').replace(/\s+-\s+.*$/, '');
  var q = item.artist.split(',')[0] + ' ' + title + ' official video';
  var url = 'https://www.googleapis.com/youtube/v3/search?part=id&type=video&videoEmbeddable=true&videoSyndicated=true&maxResults=5&q=' +
    encodeURIComponent(q) + '&key=' + encodeURIComponent(key);
  fetch(url).then(function (r) {
    return r.json().catch(function () { return null; }).then(function (j) { return { ok: r.ok, j: j }; });
  }).then(function (res) {
    if (yt.track !== item.id) return;
    if (!res.ok) {
      var err = res.j && res.j.error, why = err && err.errors && err.errors[0] ? err.errors[0].reason : '';
      if (why === 'quotaExceeded' || why === 'dailyLimitExceeded') { store.set('ytQuotaUntil', quotaResetAt(Date.now())); setYtStatus('quota'); }
      else setYtStatus('keyerror');
      return;
    }
    var ids = videoIdsFrom(res.j);
    if (!ids.length) { rememberVideos(item.id, []); playVideos([]); return; }
    // one more call (1 unit, against 100 for the search) to read each result's length and shape
    var dUrl = 'https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,player&maxWidth=640&id=' +
      ids.join(',') + '&key=' + encodeURIComponent(key);
    return fetch(dUrl).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }).then(function (d) {
      if (yt.track !== item.id) return;
      var ranked = d ? rankVideos(ids, d, item.duration, title) : ids; // details failed: keep search order
      rememberVideos(item.id, ranked);
      playVideos(ranked);
    });
  }).catch(function () { if (yt.track === item.id) setYtStatus('offline'); });
}
function playVideos(ids) {
  yt.list = Array.isArray(ids) ? ids : []; yt.idx = 0;
  if (!yt.list.length) { setYtStatus('none'); return; }
  setYtStatus('loading');
  withPlayer(cueVideo);
}
function cueVideo() {
  var id = yt.list[yt.idx];
  if (!id || !yt.track) return;
  yt.vid = id; yt.seekAt = Date.now();
  try { yt.player.loadVideoById({ videoId: id, startSeconds: Math.max(0, progressMs() / 1000) }); yt.player.mute(); }
  catch (e) { yt.vid = ''; setYtStatus('offline'); }
}
/* Load YouTube's player script once, the first time a video is needed. */
function withPlayer(cb) {
  if (yt.ready) { cb(); return; }
  yt.pending = cb;
  if (yt.loading) return;
  yt.loading = true;
  window.onYouTubeIframeAPIReady = function () {
    try {
      yt.player = new YT.Player('ytFrame', {
        width: '100%', height: '100%',
        playerVars: { autoplay: 1, mute: 1, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, playsinline: 1, rel: 0, origin: location.origin },
        events: {
          onReady: function () { yt.ready = true; yt.player.mute(); var f = yt.pending; yt.pending = null; if (f) f(); },
          onError: onVideoError
        }
      });
    } catch (e) { yt.loading = false; setYtStatus('offline'); }
  };
  var s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  s.onerror = function () { yt.loading = false; s.parentNode.removeChild(s); setYtStatus('offline'); };
  document.head.appendChild(s);
}
/* Video removed, private, or not allowed outside YouTube: try the next search result. */
function onVideoError(e) {
  var bad = yt.list[yt.idx];
  if (window.console) console.warn('YouTube could not play ' + bad + ' (error ' + (e && e.data) + ')');
  if (yt.track && Array.isArray(ytCache[yt.track])) rememberVideos(yt.track, ytCache[yt.track].filter(function (v) { return v !== bad; }));
  yt.idx++; yt.vid = ''; yt.visible = false;
  if (yt.idx < yt.list.length) cueVideo(); else setYtStatus('blocked');
}
function stopVideo() {
  yt.track = ''; yt.vid = ''; yt.list = []; yt.visible = false; yt.pending = null;
  if (yt.ready) { try { yt.player.stopVideo(); } catch (e) { /* player already gone: nothing to stop */ } }
}
/* Runs a few times a second: follows song changes, pause and seeking, and shows the video only while it is in time. */
function tickVideo() {
  var want = sceneName() === 'video' && !!np.item && connected();
  videoEl.classList.toggle('live', want && !!yt.vid);
  if (!want) { if (yt.track) stopVideo(); return; }
  if (yt.track !== np.item.id) {
    // wait until a song has been on for a moment, so skipping through songs does not use up YouTube's daily searches
    if (performance.now() - np.changedAt > 1500 || DEMO) findVideo(np.item);
    yt.visible = false; return;
  }
  if (!yt.ready || !yt.vid) { yt.visible = false; return; }
  var st = -1, cur = 0, dur = 0;
  try { st = yt.player.getPlayerState(); cur = yt.player.getCurrentTime() || 0; dur = yt.player.getDuration() || 0; }
  catch (e) { yt.visible = false; return; }
  var pos = progressMs() / 1000, now = Date.now();
  if (dur && pos > dur - .5) { if (st === 1) yt.player.pauseVideo(); yt.visible = false; return; } // song is longer than the video
  if (!np.playing) { if (st === 1) yt.player.pauseVideo(); }
  else if (st !== 1 && st !== 3 && now - yt.seekAt > 1500) { yt.player.seekTo(pos, true); yt.player.playVideo(); yt.seekAt = now; }
  else if (st === 1 && Math.abs(cur - pos) > 1.5 && now - yt.seekAt > 3000) { yt.player.seekTo(pos, true); yt.seekAt = now; }
  // an advert or a stalled video shows up as a big time gap; keep the album cover up until it is in time
  yt.visible = (st === 1 || st === 2) && Math.abs(cur - pos) < 2.5;
  if (yt.visible) setYtStatus('playing');
}

/* ---------- song wheel (bottom-left) ---------- */
var wheel = { open: false, cursor: 0, lastInput: 0, dragY: null, dragged: false };
var WHEEL_LISTS = ['queue', 'playlists', 'liked', 'recent'];
function wheelList() { return WHEEL_LISTS[wheel.list || 0]; }
function wheelItems() {
  var key = wheelList();
  if (key !== 'queue') return (library[key] && library[key].items) || [];
  var items = [];
  if (np.item) items.push(np.item);
  return items.concat(queue);
}
/** Left / Right on the open wheel: the next list (Up next, playlists, liked songs, recently played). */
function switchWheel(d) {
  wheel.list = ((wheel.list || 0) + d + WHEEL_LISTS.length) % WHEEL_LISTS.length;
  wheel.cursor = 0; rowsSig = ''; touchWheel();
  var key = wheelList();
  buildRows(); focusCursorRow();
  if (key !== 'queue' && (!library[key] || Date.now() - library[key].at > 60000)) {
    wheelTitle('Loading ' + LIB[key].title.toLowerCase() + '...');
    loadLibrary(key).then(function () { if (wheelList() === key) { rowsSig = ''; buildRows(); focusCursorRow(); } })
      .catch(function () { if (wheelList() === key) wheelTitle('Could not load ' + LIB[key].title.toLowerCase()); });
  }
}
function wheelTitle(text) {
  var key = wheelList();
  $('wheelList').textContent = text || ('\u2039  ' + (key === 'queue' ? 'Up next' : LIB[key].title) + '  \u203a');
}
function buildRows() {
  var items = wheelItems(), isQueue = wheelList() === 'queue';
  var sig = wheelList() + ':' + items.map(function (x) { return x.id; }).join('|');
  if (sig === rowsSig) { markRows(); return; }
  rowsSig = sig; rowsEl.innerHTML = '';
  items.forEach(function (x, pos) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'song' + (isQueue && pos === 0 ? ' active' : ''); b.dataset.pos = String(pos); b.tabIndex = -1;
    var pic;
    if (x.thumb) { pic = document.createElement('img'); pic.src = x.thumb; pic.alt = ''; } else { pic = document.createElement('span'); pic.className = 'ph'; }
    var meta = document.createElement('span'); meta.className = 'meta';
    var t = document.createElement('b'); t.textContent = x.title;
    var a = document.createElement('small'); a.textContent = isQueue && pos === 0 ? 'Now playing · ' + x.artist : x.artist;
    meta.appendChild(t); meta.appendChild(a);
    var eq = document.createElement('span'); eq.className = 'eq'; eq.setAttribute('aria-hidden', 'true'); eq.innerHTML = '<i></i><i></i><i></i>';
    b.appendChild(pic); b.appendChild(meta); b.appendChild(eq);
    b.setAttribute('aria-label', isQueue && pos === 0 ? 'Now playing ' + x.title + '. Press to play or pause.' : 'Play ' + x.title);
    b.addEventListener('click', function () { if (!wheel.dragged) selectWheel(pos); });
    rowsEl.appendChild(b);
  });
  wheel.cursor = Math.min(wheel.cursor, Math.max(0, items.length - 1));
  $('wheelLabel').textContent = np.item ? np.item.title : '';
  wheelTitle();
  layoutWheel(); markRows();
}
function markRows() {
  var isQueue = wheelList() === 'queue';
  Array.prototype.forEach.call(rowsEl.children, function (b) { b.classList.toggle('playing', isQueue && b.dataset.pos === '0' && np.playing); });
}
function layoutWheel() {
  if (!W) return;
  var u = W / 100, P = portrait;
  var discD = P ? 22 * u : 9 * u, dcx = P ? 4 * u : 1.6 * u, dcy = H - (P ? 18 * u : 8.5 * u);
  geo.mini = { x: dcx, y: dcy, d: discD };
  [mini, $('wheelBtn')].forEach(function (el) {
    el.style.width = el.style.height = discD + 'px';
    el.style.left = (dcx - discD / 2) + 'px'; el.style.top = (dcy - discD / 2) + 'px';
  });
  mini.width = mini.height = Math.round(discD * DPR);
  var lbl = $('wheelLabel');
  lbl.style.left = (dcx + discD / 2 + 12) + 'px'; lbl.style.top = (dcy - 10) + 'px';
  var rowH = P ? clamp(10 * u, 40, 48) : clamp(3.3 * u, 32, 60), fs = clamp(rowH * .36, 12, 22);
  var R = Math.max(P ? 34 * u : 14 * u, discD / 2 + 16, rowH * 4), rows = rowsEl.children;
  for (var i = 0; i < rows.length; i++) {
    var el = rows[i], o = i - wheel.cursor;
    el.style.height = rowH + 'px'; el.style.fontSize = fs + 'px';
    el.classList.toggle('cursor', wheel.open && o === 0);
    if (!wheel.open) {
      el.style.transform = 'translate(' + dcx + 'px,' + (dcy - rowH / 2) + 'px) scale(.3)';
      el.style.opacity = '0'; el.style.pointerEvents = 'none'; el.tabIndex = -1;
      continue;
    }
    var dy = (o - 1) * rowH * 1.2, dx = Math.sqrt(Math.max(R * R - dy * dy, Math.pow(discD / 2 + 10, 2)));
    var ang = Math.atan2(dy, dx) * (P ? .25 : .5), vis = Math.abs(o) <= 3;
    el.style.transform = 'translate(' + (dcx + dx) + 'px,' + (dcy + dy - rowH / 2) + 'px) rotate(' + ang + 'rad)';
    el.style.opacity = vis ? String(1 - Math.abs(o) * .24) : '0';
    el.style.pointerEvents = vis ? 'auto' : 'none';
    el.tabIndex = o === 0 ? 0 : -1;
  }
  var wl = $('wheelList');
  wl.style.left = (dcx + discD / 2 + 14) + 'px'; wl.style.top = (dcy - 5.4 * rowH * 1.2 - rowH * .2) + 'px';
  wl.style.fontSize = Math.round(fs * .95) + 'px';
  stage.classList.toggle('wheel-open', wheel.open);
}
var wheelTimer = 0;
function touchWheel() {
  wheel.lastInput = performance.now();
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(function () { if (wheel.open && performance.now() - wheel.lastInput > 7900) closeWheel(); }, 8000);
}
function openWheel() {
  if (!connected()) { toast('Connect Spotify to see your songs.'); return; }
  if (!wheelItems().length && wheelList() === 'queue') { wheel.list = 1; rowsSig = ''; } // nothing playing: start at your playlists
  wheel.open = true; wheel.cursor = 0; touchWheel(); switchWheel(0);
  if (token && Date.now() - lastQueueAt > 8000) loadQueue();
}
function closeWheel() {
  wheel.open = false; wheel.cursor = 0; wheel.list = 0; rowsSig = ''; buildRows(); // next time it opens on Up next
  if (rowsEl.contains(document.activeElement)) $('wheelBtn').focus({ preventScroll: true });
}
function moveWheel(d) {
  if (!wheel.open) { openWheel(); return; }
  var n = rowsEl.children.length;
  wheel.cursor = clamp(wheel.cursor + d, 0, Math.max(0, n - 1));
  touchWheel(); layoutWheel(); focusCursorRow();
}
function focusCursorRow() { var el = rowsEl.children[wheel.cursor]; if (el) el.focus({ preventScroll: true }); }
function selectWheel(pos) {
  touchWheel();
  var el = rowsEl.children[pos];
  if (el) { el.classList.add('chosen'); setTimeout(function () { el.classList.remove('chosen'); }, 500); }
  var key = wheelList(), items = wheelItems();
  if (key === 'queue') playQueueFrom(pos);
  else if (items[pos]) LIB[key].pick(items[pos], pos, items);
  setTimeout(closeWheel, 450);
}

/* ---------- live TV audio from the Android app ---------- */
var nativeAudio = { arr: null, at: 0, lastSignal: 0, status: '' };
window.onNativeSpectrum = function (arr) {
  var t = performance.now(); nativeAudio.arr = arr; nativeAudio.at = t;
  for (var i = 0; i < arr.length; i++) if (arr[i] > .08) { nativeAudio.lastSignal = t; break; }
};
window.onNativeAudioStatus = function (s) { nativeAudio.status = s; if (drawerOpen()) renderDrawer(); };
window.onNativeKey = function (name) {
  if (name === 'playpause') togglePlay();
  else if (name === 'next') control('next');
  else if (name === 'prev') control('prev');
  else if (name === 'menu') { if (drawerOpen()) closeDrawer(); else openDrawer('settings'); }
};
window.handleBack = function () {
  if (drawerOpen() && drawerTab === 'music' && musicView) { closeMusicView(); return true; }
  if (drawerOpen()) { closeDrawer(); return true; }
  if (wheel.open) { closeWheel(); return true; }
  if (stage.classList.contains('show-controls')) { hideControls(); return true; }
  return false;
};
function applyLiveAudio() {
  if (native && native.setLiveAudio) { try { native.setLiveAudio(!!settings.liveAudio); } catch (e) { nativeAudio.status = 'unavailable'; } }
}
function nativeLive() {
  var t = performance.now();
  return !!nativeAudio.arr && t - nativeAudio.at < 500 && t - nativeAudio.lastSignal < 2500;
}

/* ---------- bars ---------- */
var phases = [];
for (var pi = 0; pi < HALF; pi++) phases.push([Math.random() * TAU, Math.random() * TAU, .6 + Math.random() * 1.2]);
function sampleBars(t) {
  var b = 0, k;
  if (nativeLive()) {
    var a = nativeAudio.arr, n = a.length;
    for (k = 0; k < HALF; k++) target[k] = clamp((a[Math.floor(k / HALF * n)] - .18) / .7 * (1 + k / HALF * .6), 0, 1);
    b = clamp(((a[1] + a[2] + a[3] + a[4]) / 4 - .45) / .45, 0, 1);
  } else if (np.playing) {
    var ms = progressMs(), beatLen = 60000 / BPM, beat = (ms / beatLen) % 1, kick = Math.exp(-beat * 7);
    var bar2 = (ms / beatLen) % 2, snare = bar2 >= 1 ? Math.exp(-(bar2 - 1) * 9) : 0, tt = settings.motion ? t : 0;
    for (k = 0; k < HALF; k++) {
      var f = k / HALF, ph = phases[k];
      var v = .2 + .16 * Math.sin(tt * .004 * ph[2] + ph[0]) + .1 * Math.sin(tt * .0093 * ph[2] + ph[1]);
      v *= 1 - f * .45;
      if (k < 10) v += kick * .55 * (1 - k / 10);
      if (k > 16 && k < 42) v += snare * .22;
      target[k] = clamp(v, 0, 1);
    }
    b = kick * .85;
  } else {
    var ti = settings.motion ? t : 0;
    for (k = 0; k < HALF; k++) target[k] = .08 + .06 * Math.sin(ti * .0016 + k * .45) + .03 * Math.sin(ti * .0029 - k * .9);
  }
  for (k = 0; k < HALF; k++) sm[k] += (target[k] - sm[k]) * (target[k] > sm[k] ? .55 : .12);
  bassSm += (b - bassSm) * (b > bassSm ? .6 : .14);
}
function drawSheen(c, x, y, r) {
  if (!c.createConicGradient) return;
  var g = c.createConicGradient(-Math.PI / 4, x, y);
  g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(.07, 'rgba(255,255,255,.14)'); g.addColorStop(.15, 'rgba(255,255,255,0)');
  g.addColorStop(.5, 'rgba(255,255,255,0)'); g.addColorStop(.57, 'rgba(255,255,255,.1)'); g.addColorStop(.65, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
}

function draw(t, dt) {
  var active = np.playing || nativeLive();
  sampleBars(t);
  for (var ci = 0; ci < 3; ci++) accent[ci] += (accentTarget[ci] - accent[ci]) * Math.min(1, dt * 1.5);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  var cx = geo.cx, cy = geo.cy, r = geo.r, pulse = settings.motion ? bassSm : 0, sc = 1 + pulse * .045;
  var showVid = yt.visible && sceneName() === 'video';
  yt.mix = settings.motion ? clamp(yt.mix + (showVid ? dt * 1.2 : -dt * 2), 0, 1) : (showVid ? 1 : 0);

  drawScene(dt, t, pulse);

  var gr = ctx.createRadialGradient(cx, cy, r * .8, cx, cy, r * 3.2);
  gr.addColorStop(0, accentRgba(.22 + pulse * .22, .35));
  gr.addColorStop(.35, accentRgba(.08 + pulse * .08, .15));
  gr.addColorStop(1, accentRgba(0, .15));
  ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);

  var r0 = r * sc * 1.08;
  ctx.lineWidth = Math.max(1, TAU * r0 / BARS * .5); ctx.lineCap = 'butt';
  for (var i = 0; i < BARS; i++) {
    var k = Math.min(HALF - 1, i <= HALF ? i : BARS - i), v = sm[k];
    var a = -Math.PI / 2 + i / BARS * TAU, ca = Math.cos(a), sa = Math.sin(a);
    var len = r * (.05 + Math.pow(v, 1.35) * .85);
    ctx.strokeStyle = accentRgba(.5 + .5 * v, .45 - .4 * v);
    ctx.beginPath(); ctx.moveTo(cx + ca * r0, cy + sa * r0); ctx.lineTo(cx + ca * (r0 + len), cy + sa * (r0 + len)); ctx.stroke();
  }

  if (settings.ring && np.item && np.item.duration) {
    var frac = clamp(progressMs() / np.item.duration, 0, 1), rr = r * sc * 1.04;
    ctx.lineWidth = Math.max(2, r * .012);
    ctx.strokeStyle = 'rgba(255,255,255,.12)';
    ctx.beginPath(); ctx.arc(cx, cy, rr, 0, TAU); ctx.stroke();
    ctx.strokeStyle = accentRgba(.95, .2);
    ctx.beginPath(); ctx.arc(cx, cy, rr, -Math.PI / 2, -Math.PI / 2 + frac * TAU); ctx.stroke();
  }

  if (settings.motion) { angle += dt * (active ? 1.1 : .15); miniAngle += dt * (active ? 2.2 : .3); }
  if (discFade < 1) discFade = Math.min(1, discFade + dt * 2.5);
  var cur = disc || blankDisc;
  ctx.save(); ctx.translate(cx, cy); ctx.scale(sc, sc); ctx.rotate(angle);
  if (discPrev && discFade < 1) { ctx.drawImage(discPrev, -r, -r, r * 2, r * 2); ctx.globalAlpha = discFade; }
  if (cur) ctx.drawImage(cur, -r, -r, r * 2, r * 2);
  ctx.globalAlpha = 1; ctx.restore();
  drawSheen(ctx, cx, cy, r * sc);
  var rg = rimGlow(r);
  ctx.drawImage(rg, cx - rg.width / 2 * sc, cy - rg.height / 2 * sc, rg.width * sc, rg.height * sc);

  var md = mini.width;
  mctx.setTransform(1, 0, 0, 1, 0, 0); mctx.clearRect(0, 0, md, md);
  if (cur) { mctx.save(); mctx.translate(md / 2, md / 2); mctx.rotate(miniAngle); mctx.drawImage(cur, -md / 2, -md / 2, md, md); mctx.restore(); }
  drawSheen(mctx, md / 2, md / 2, md / 2);
  mctx.beginPath(); mctx.arc(md / 2, md / 2, md / 2 - DPR, 0, TAU);
  mctx.strokeStyle = 'rgba(255,255,255,.7)'; mctx.lineWidth = 1.5 * DPR; mctx.stroke();

  lyrEl.style.transform = settings.motion ? 'scale(' + (1 + pulse * .025) + ')' : '';
  if (t - clockT > 300) {
    clockT = t; tickInfo(); tickVideo(); var c = curAccent();
    stage.style.setProperty('--acc', 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')');
  }
}

function loop(t) {
  requestAnimationFrame(loop);
  // paused or nothing playing: about 15 frames a second is plenty for a slow, still scene and leaves the CPU to
  // whatever else the TV is doing (controls and the menu keep full speed so the remote feels quick)
  var idle = !np.playing && !DEMO && !stage.classList.contains('show-controls') && !wheel.open && !drawerOpen();
  if (idle && last && t - last < 64) return;
  var dt = Math.min(.05, (t - (last || t)) / 1000); last = t;
  if (W) draw(t, dt);
  tickLyrics();
}

/* ---------- layout ---------- */
/* The white rim with its glow, drawn once per size: a live shadowBlur every frame was one of the costliest parts on TVs. */
var rimCache = { r: 0, c: null };
function rimGlow(r) {
  if (rimCache.c && rimCache.r === r) return rimCache.c;
  var pad = Math.ceil(r * .5), d = Math.ceil(r * 2 + pad * 2), c = document.createElement('canvas');
  c.width = c.height = d;
  var g = c.getContext('2d');
  g.beginPath(); g.arc(d / 2, d / 2, r, 0, TAU);
  g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = Math.max(1.5, r * .016);
  g.shadowColor = 'rgba(255,255,255,.95)'; g.shadowBlur = r * .22; g.stroke();
  rimCache = { r: r, c: c };
  return c;
}
function resize() {
  W = window.innerWidth; H = window.innerHeight;
  if (!W || !H) return;
  // the TV's WebView reports 2x; drawing the full-screen canvas at 1920x1080 there ran at about 10 fps
  DPR = native ? 1 : Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  portrait = H > W;
  stage.classList.toggle('portrait', portrait);
  geo = portrait ? { cx: W * .5, cy: H * .5, r: W * .18 } : { cx: W * .5, cy: H * .48, r: H * .17 };
  blankDisc = makeDisc(null, discPx());
  disc = artImg ? makeDisc(artImg, discPx()) : blankDisc; discPrev = null; discFade = 1;
  artistBg = artistImg ? makeArtistBg(artistImg) : null; artistPrev = null; artistFade = 1;
  scene.name = null;
  layoutWheel();
  lyricKey = '';
  if ($('info')) renderInfo();
}

/* ---------- side drawer: music, connect steps, settings ---------- */
var drawerTab = 'music', library = {};
function drawerOpen() { return $('drawer').classList.contains('open'); }
function openDrawer(tab) {
  if (wheel.open) closeWheel();
  drawerTab = tab || drawerTab;
  $('drawer').classList.add('open'); stage.classList.add('drawer-open');
  showControls(); renderDrawer();
  setTimeout(function () { var t = document.querySelector('.tab[data-tab="' + drawerTab + '"]'); if (t) t.focus({ preventScroll: true }); }, 60);
}
function closeDrawer() {
  musicView = null;
  $('drawer').classList.remove('open'); stage.classList.remove('drawer-open');
  showControls(); var b = $('btnMusic'); if (b && b.getClientRects().length) b.focus({ preventScroll: true });
}
/**
 * Redraws the menu without losing the remote's place. Lists and option buttons are rebuilt when the
 * song or a setting changes (every few seconds while music plays); without this the focused button
 * vanished and the next arrow press jumped back to the first tab.
 */
function renderDrawer() {
  var f = document.activeElement, inside = f && $('drawer').contains(f) && f !== document.body;
  var before = inside ? focusables() : [], idx = before.indexOf(f);
  var key = inside ? (f.id || f.className + '|' + f.textContent.trim()) : '';
  drawDrawer();
  if (!inside || document.activeElement === f && f.isConnected) return;
  var now = focusables(), same = null;
  for (var i = 0; i < now.length && !same; i++) if ((now[i].id || now[i].className + '|' + now[i].textContent.trim()) === key) same = now[i];
  var target = same || now[Math.min(Math.max(idx, 0), now.length - 1)];
  if (target) target.focus({ preventScroll: true });
}
function drawDrawer() {
  Array.prototype.forEach.call(document.querySelectorAll('.tab[data-tab]'), function (b) {
    var on = b.dataset.tab === drawerTab; b.setAttribute('aria-selected', String(on)); b.classList.toggle('on', on);
  });
  Array.prototype.forEach.call(document.querySelectorAll('.pane'), function (p) { p.hidden = p.dataset.pane !== drawerTab; });
  if (drawerTab === 'music') renderMusic();
  if (drawerTab === 'connect') renderConnect();
  if (drawerTab === 'settings') renderSettings();
}

function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function musicItem(title, sub, thumb, onPick) {
  var b = el('button', 'mitem'); b.type = 'button';
  if (thumb) { var im = el('img'); im.src = thumb; im.alt = ''; im.loading = 'lazy'; b.appendChild(im); } else b.appendChild(el('span', 'ph'));
  var m = el('span', 'meta'); m.appendChild(el('b', null, title)); m.appendChild(el('small', null, sub)); b.appendChild(m);
  b.addEventListener('click', onPick);
  return b;
}
function section(title) { var s = el('section', 'msec'); s.appendChild(el('h3', null, title)); var list = el('div', 'mlist'); s.appendChild(list); return { root: s, list: list }; }
/* ---------- your Spotify library: used by the Music menu and the song wheel ---------- */
/** All pages of a Spotify list (it sends 50 at a time), up to maxPages. */
function apiJsonAll(path, maxPages) {
  var items = [];
  function page(p, n) {
    return apiJson(p).then(function (j) {
      items = items.concat((j && j.items) || []);
      var next = j && j.next;
      if (next && n + 1 < maxPages && next.indexOf(API) === 0) return page(next.slice(API.length), n + 1);
      return { items: items };
    });
  }
  return page(path, 0);
}
var LIB = {
  playlists: { title: 'Your playlists', load: function () { return apiJsonAll('/me/playlists?limit=50', 10); }, map: function (j) {
    return (j.items || []).filter(Boolean).map(function (p) {
      var imgs = p.images || [], total = (p.tracks && p.tracks.total) || (p.items && p.items.total) || 0;
      return { id: p.id, uri: p.uri, title: p.name, artist: total + ' songs', total: total, thumb: imgs.length ? imgs[imgs.length - 1].url : '' };
    });
  }, pick: function (x) { return startPlayback({ context_uri: x.uri }, x.title); } },
  liked: { title: 'Liked songs', load: function () { return apiJson('/me/tracks?limit=50'); }, map: function (j) {
    return (j.items || []).map(function (x) { return toItem(x.track); });
  }, pick: function (x, i, all) { return startPlayback({ uris: all.slice(i, i + 100).map(function (y) { return y.uri; }) }, x.title); } },
  recent: { title: 'Recently played', load: function () { return apiJson('/me/player/recently-played?limit=50'); }, map: function (j) {
    var seen = {}, out = [];
    (j.items || []).forEach(function (x) { var t = x.track; if (t && !seen[t.id] && out.length < 30) { seen[t.id] = 1; out.push(toItem(t)); } });
    return out;
  }, pick: function (x) { return startPlayback({ uris: [x.uri] }, x.title); } }
};
var LIB_ORDER = ['recent', 'playlists', 'liked'];
function loadLibrary(key) {
  var cached = library[key], s = LIB[key];
  if (cached && Date.now() - cached.at < 60000) return Promise.resolve(cached.items);
  return s.load().then(function (j) { var items = s.map(j); library[key] = { at: Date.now(), items: items }; return items; });
}
/* Songs in one of your playlists, all of them (50 per call, up to 1,000). Spotify's newer API calls the list
   "items" (each entry's song in .item); older responses use "tracks" (.track), so both are read. */
function playlistSongs(id) {
  var key = 'pl:' + id, c = library[key], base = '/playlists/' + encodeURIComponent(id);
  if (c && Date.now() - c.at < 120000) return Promise.resolve(c.items);
  return apiJsonAll(base + '/items?limit=50', 20).catch(function () { return apiJsonAll(base + '/tracks?limit=50', 20); }).then(function (j) {
    var items = (j.items || []).map(function (x) { return x && (x.item || x.track); })
      .filter(function (t) { return t && t.uri && t.type !== 'episode' && !t.is_local; }).map(toItem);
    library[key] = { at: Date.now(), items: items };
    return items;
  });
}
/* Every liked song (50 per call, up to 2,000). onProgress gets the list so far, so a long library shows up as it loads. */
function likedSongs(onProgress) {
  var c = library.likedAll;
  if (c && Date.now() - c.at < 120000) return Promise.resolve(c.items);
  var items = [];
  function page(p, n) {
    return apiJson(p).then(function (j) {
      (j.items || []).forEach(function (x) { if (x && x.track && x.track.uri && !x.track.is_local) items.push(toItem(x.track)); });
      if (onProgress) onProgress(items);
      var next = j && j.next;
      if (next && n + 1 < 40 && next.indexOf(API) === 0) return page(next.slice(API.length), n + 1);
      return items;
    });
  }
  return page('/me/tracks?limit=50', 0).then(function (all) { library.likedAll = { at: Date.now(), items: all }; return all; });
}
function thumbOf(images) { return images && images.length ? images[images.length - 1].url : ''; }
/* Spotify search across songs, artists, albums and playlists. */
function searchSpotify(q, limit) {
  return apiJson('/search?type=track,artist,album,playlist&limit=' + (limit || 8) + '&q=' + encodeURIComponent(q)).then(function (j) {
    function list(k) { return ((j && j[k] && j[k].items) || []).filter(Boolean); }
    return {
      tracks: list('tracks').map(toItem),
      artists: list('artists').map(function (a) { return { uri: a.uri, title: a.name, artist: 'Artist', thumb: thumbOf(a.images) }; }),
      albums: list('albums').map(function (a) { return { uri: a.uri, title: a.name, artist: 'Album · ' + artistsOf(a), thumb: thumbOf(a.images) }; }),
      playlists: list('playlists').map(function (p) {
        return { id: p.id, uri: p.uri, title: p.name, artist: 'Playlist' + (p.owner && p.owner.display_name ? ' · ' + p.owner.display_name : ''), thumb: thumbOf(p.images) };
      })
    };
  });
}
/* Up to 100 song links for a play request: in order from a start point, or a random 100 when shuffling. */
function pickUris(items, from, shuffle) {
  var list = items.slice();
  if (shuffle) {
    for (var i = list.length - 1; i > 0; i--) { var r = Math.floor(Math.random() * (i + 1)), t = list[i]; list[i] = list[r]; list[r] = t; }
    return list.slice(0, 100).map(function (x) { return x.uri; });
  }
  return list.slice(from || 0, (from || 0) + 100).map(function (x) { return x.uri; });
}
/* Starts something, then turns Spotify's shuffle on when asked. */
function playThen(body, label, shuffle) {
  return startPlayback(body, label).then(function (ok) {
    if (ok && shuffle) api('/me/player/shuffle?state=true', { method: 'PUT' }).catch(function () { /* shuffle is a nicety */ });
    return ok;
  });
}
function playPlaylist(p, startUri, shuffle) {
  var body = { context_uri: p.uri };
  if (startUri) body.offset = { uri: startUri };
  else if (shuffle && p.total) body.offset = { position: Math.floor(Math.random() * p.total) };
  return playThen(body, p.title, shuffle);
}

/* ---------- Music menu views: a playlist's songs, all liked songs, search results ---------- */
var musicView = null; // null = the library home; else { kind: 'playlist' | 'liked' | 'search', title, items, shown }
function openMusicView(v) {
  musicView = v; v.shown = 100;
  if (!drawerOpen()) openDrawer('music'); else { drawerTab = 'music'; renderDrawer(); }
  setTimeout(function () { var b = $('mBack'); if (b) b.focus({ preventScroll: true }); }, 80);
  var mine = v, done = function () { if (musicView === mine && drawerOpen()) renderDrawer(); };
  var load = v.kind === 'playlist' ? playlistSongs(v.id)
    : v.kind === 'liked' ? likedSongs(function (sofar) { mine.items = sofar.slice(); done(); })
    : searchSpotify(v.q);
  load.then(function (res) { if (v.kind === 'search') mine.res = res; else mine.items = res; done(); })
    .catch(function (e) {
      // Spotify does not let apps in development mode list the songs of playlists someone else made (403);
      // playing the whole playlist still works, so offer that
      if (v.kind === 'playlist' && /HTTP 403/.test(String(e && e.message))) mine.locked = true;
      else mine.error = 'Could not load this from Spotify.';
      done();
    });
}
function closeMusicView() {
  musicView = null; renderDrawer();
  setTimeout(function () { var b = $('musicBody').querySelector('button'); if (b) b.focus({ preventScroll: true }); }, 0);
}
function runSearch(q) {
  q = String(q || '').trim();
  if (!q) return;
  $('searchQ').value = q;
  openMusicView({ kind: 'search', q: q, title: 'Results for "' + q + '"' });
}
function renderMusicView(body) {
  var v = musicView, head = el('div', 'mhead');
  var back = el('button', 'pbtn', 'Back'); back.type = 'button'; back.id = 'mBack';
  back.addEventListener('click', closeMusicView);
  head.appendChild(back); head.appendChild(el('h3', null, v.title)); body.appendChild(head);
  if (v.error) { body.appendChild(el('p', 'small', v.error)); return; }
  if (v.kind === 'search') {
    if (!v.res) { body.appendChild(el('p', 'small', 'Searching...')); return; }
    var groups = [['Songs', v.res.tracks, function (x) { return playThen({ uris: [x.uri] }, x.title + ' · ' + x.artist); }],
      ['Artists', v.res.artists, function (x) { return playThen({ context_uri: x.uri }, x.title); }],
      ['Albums', v.res.albums, function (x) { return playThen({ context_uri: x.uri }, x.title); }],
      ['Playlists', v.res.playlists, function (x) { openMusicView({ kind: 'playlist', id: x.id, uri: x.uri, title: x.title }); }]];
    var any = false;
    groups.forEach(function (g) {
      if (!g[1].length) return;
      any = true;
      var sec = section(g[0]); body.appendChild(sec.root);
      g[1].forEach(function (x) { sec.list.appendChild(musicItem(x.title, x.artist, x.thumb, function () { g[2](x); })); });
    });
    if (!any) body.appendChild(el('p', 'small', 'Nothing on Spotify for that. Try other words.'));
    return;
  }
  var acts = el('div', 'inline');
  var all = el('button', 'pbtn primary', 'Play all'), mix = el('button', 'pbtn', 'Shuffle');
  all.type = mix.type = 'button';
  function play(shuffle) {
    if (v.kind === 'playlist') return playPlaylist({ uri: v.uri, title: v.title, total: v.items ? v.items.length : 0 }, '', shuffle);
    if (v.items && v.items.length) return playThen({ uris: pickUris(v.items, 0, shuffle) }, 'your liked songs', shuffle);
  }
  all.addEventListener('click', function () { play(false); }); mix.addEventListener('click', function () { play(true); });
  acts.appendChild(all); acts.appendChild(mix); body.appendChild(acts);
  if (v.locked) {
    body.appendChild(el('p', 'small', 'Someone else made this playlist, and Spotify only lets Earthrise list the songs in playlists you made. Play all and Shuffle still play it.'));
    return;
  }
  if (!v.items) { body.appendChild(el('p', 'small', 'Loading...')); return; }
  if (!v.items.length) { body.appendChild(el('p', 'small', 'No songs here.')); return; }
  var list = el('div', 'mlist'); body.appendChild(list);
  v.items.slice(0, v.shown).forEach(function (x, i) {
    list.appendChild(musicItem(x.title, x.artist, x.thumb, function () {
      if (v.kind === 'playlist') playPlaylist({ uri: v.uri, title: v.title }, x.uri);
      else playThen({ uris: pickUris(v.items, i) }, x.title);
    }));
  });
  if (v.items.length > v.shown) {
    var more = el('button', 'pbtn', 'Show more (' + (v.items.length - v.shown) + ' left)'); more.type = 'button'; more.id = 'mMore';
    more.addEventListener('click', function () { v.shown += 100; renderDrawer(); });
    body.appendChild(more);
  }
}
function renderMusic() {
  var body = $('musicBody'); body.innerHTML = '';
  if (!connected()) {
    body.appendChild(el('p', 'lead', 'Connect Spotify to see what is playing, your recent songs and your playlists.'));
    var go = el('button', 'pbtn', 'Show me how to connect'); go.type = 'button';
    go.addEventListener('click', function () { drawerTab = 'connect'; renderDrawer(); });
    body.appendChild(go); return;
  }
  if (musicView) { renderMusicView(body); return; }
  var up = section('Playing and up next');
  wheelItems().slice(0, 12).forEach(function (x, i) {
    up.list.appendChild(musicItem(x.title, (i === 0 ? 'Now playing · ' : '') + x.artist, x.thumb, function () { playQueueFrom(i); }));
  });
  if (!up.list.children.length) up.list.appendChild(el('p', 'small', 'Nothing playing right now.'));
  body.appendChild(up.root);
  if (DEMO && !token) { body.appendChild(el('p', 'small', 'Demo mode. Connect Spotify to load your recent songs and playlists.')); return; }
  if (!hasScopes(LIBRARY_SCOPES)) {
    body.appendChild(el('p', 'lead', 'To show your playlists and recent songs, Earthrise needs a bit more access. Reconnect and press Agree.'));
    var rc = el('button', 'pbtn', 'Reconnect Spotify'); rc.type = 'button'; rc.addEventListener('click', connect); body.appendChild(rc);
    return;
  }
  LIB_ORDER.forEach(function (key) {
    var s = LIB[key];
    var sec = section(s.title); sec.list.appendChild(el('p', 'small', 'Loading...')); body.appendChild(sec.root);
    loadLibrary(key).then(function (items) {
      sec.list.innerHTML = '';
      if (!items.length) sec.list.appendChild(el('p', 'small', 'Nothing here yet.'));
      items.forEach(function (x, i) {
        // a playlist opens to its songs (pick any, or Play all / Shuffle); other rows play straight away
        var pick = key === 'playlists' ? function () { openMusicView({ kind: 'playlist', id: x.id, uri: x.uri, title: x.title }); }
          : function () { s.pick(x, i, items); };
        sec.list.appendChild(musicItem(x.title, x.artist, x.thumb, pick));
      });
      if (key === 'liked' && items.length) {
        var allLiked = el('button', 'pbtn', 'All liked songs'); allLiked.type = 'button'; allLiked.id = 'mAllLiked';
        allLiked.addEventListener('click', function () { openMusicView({ kind: 'liked', title: 'Liked songs' }); });
        sec.list.appendChild(allLiked);
      }
    }).catch(function () { sec.list.innerHTML = ''; sec.list.appendChild(el('p', 'small', 'Could not load this from Spotify.')); });
  });
}
/* ---------- Earthrise Link on the laptop: pairing and tokens (calls go through LinkClient.java) ---------- */
var linkCalls = {}, linkSeq = 0, linkPair = null, linkNote = '', linkPollT = 0;
window.onLinkResult = function (id, res) { var cb = linkCalls[id]; delete linkCalls[id]; if (cb) cb(res || {}); };
function linkNative(start) {
  return new Promise(function (resolve) { var id = 'l' + (++linkSeq); linkCalls[id] = resolve; start(id); });
}
function linkCall(method, base, path, body, secret) {
  return linkNative(function (id) { native.linkCall(id, method, base, path, body ? JSON.stringify(body) : '', secret || ''); });
}
function linkBody(r) { try { return JSON.parse(r.body || '{}'); } catch (e) { return {}; } }
function linkToken() {
  return linkCall('GET', link.base, '/link/token', null, link.secret).then(function (r) {
    var j = linkBody(r);
    if (r.status === 200 && j.access_token) {
      token = { access: j.access_token, refresh: '', exp: Number(j.expires_at) || Date.now() + 50 * 60000, scope: j.scope || SCOPES, linked: true };
      store.set('token', token);
      if (linkNote) { linkNote = ''; renderDrawer(); }
      return token.access;
    }
    if (r.status === 401) { // the laptop no longer knows this TV
      link = null; store.del('link'); token = null; store.del('token');
      linkNote = 'Your laptop forgot this TV. Pair again below.';
    } else if (r.status === 409) linkNote = 'Log in to Spotify in Earthrise Link on your laptop.';
    else linkNote = 'Cannot reach ' + ((link && link.name) || 'your laptop') + '. Is Earthrise Link running on it?';
    renderDrawer();
    throw new Error(linkNote);
  });
}
/** Find the laptop on this Wi-Fi (or use the address typed in), then ask it to pair. */
function linkStart(typed) {
  if (!native || !native.linkCall) return;
  clearTimeout(linkPollT);
  linkPair = { step: 'finding' }; linkNote = ''; renderDrawer();
  var parts = String(typed || '').split(':');
  var found = typed
    ? Promise.resolve(/^\d{1,3}(\.\d{1,3}){3}(:\d{2,5})?$/.test(typed) ? { ok: true, ip: parts[0], port: +(parts[1] || 5173), name: parts[0] } : { ok: false, bad: true })
    : linkNative(function (id) { native.linkDiscover(id); });
  found.then(function (f) {
    if (!f || !f.ok) {
      linkPair = { step: 'manual' };
      linkNote = f && f.bad ? 'Type the address Earthrise Link shows, like 192.168.1.20.' : 'No laptop found. Start Earthrise Link on it, or type the address it shows.';
      renderDrawer(); return;
    }
    var base = 'http://' + f.ip + ':' + (f.port || 5173);
    return linkCall('POST', base, '/link/pair', { device: 'Fire TV' }).then(function (r) {
      var j = linkBody(r);
      if (r.status !== 200 || !j.pairId) {
        linkPair = { step: 'manual' };
        linkNote = r.status ? 'The laptop said no (' + r.status + ').' : 'Cannot reach ' + base.slice(7) + '. Is Earthrise Link running?';
        renderDrawer(); return;
      }
      linkPair = { step: 'code', base: base, name: f.name || 'your laptop', id: j.pairId, code: String(j.code || '') };
      renderDrawer(); linkWait();
    });
  });
}
function linkWait() {
  if (!linkPair || linkPair.step !== 'code') return;
  linkCall('GET', linkPair.base, '/link/pair/' + encodeURIComponent(linkPair.id)).then(function (r) {
    if (!linkPair || linkPair.step !== 'code') return;
    var j = linkBody(r);
    if (j.status === 'approved' && j.spotify && j.spotify.refresh_token) {
      // the laptop's login is now this TV's: from here it renews straight with Spotify (accessToken())
      token = { access: j.spotify.access_token, refresh: j.spotify.refresh_token, exp: Number(j.spotify.expires_at) || 0, scope: j.spotify.scope || '' };
      store.set('token', token); link = null; store.del('link'); linkPair = null; linkNote = '';
      toast('Connected. The laptop is not needed any more.'); ui(); poll(); hideControls(); renderDrawer();
      return;
    }
    if (r.status === 200 && j.status === 'approved' && j.secret && !j.error) { // an older laptop app: keep asking it for tokens
      link = { base: linkPair.base, secret: j.secret, name: linkPair.name, v: 2 };
      store.set('link', link); linkPair = null; token = null; store.del('token');
      linkToken().then(function () { toast('Connected through ' + link.name + '.'); ui(); poll(); hideControls(); })
        .catch(function () { /* linkNote says why */ }).then(renderDrawer);
      return;
    }
    if (j.status === 'denied' || j.status === 'expired') {
      linkPair = { step: 'manual' };
      linkNote = j.status === 'denied' ? 'The laptop said no.' : 'The code expired. Try again.';
      renderDrawer(); return;
    }
    // allowed, but the laptop is not logged in to Spotify yet (409) or cannot reach it (502): keep waiting
    var note = j.error === 'spotify_login_needed' ? 'Allowed. Now log in to Spotify in Earthrise Link on the laptop.'
      : j.error === 'spotify_unreachable' ? 'Allowed. The laptop cannot reach Spotify right now, still trying.' : '';
    if (note !== linkNote) { linkNote = note; renderDrawer(); }
    linkPollT = setTimeout(linkWait, 2000);
  });
}
function renderLink() {
  var box = $('linkBox');
  box.hidden = !native || !native.linkCall;
  if (box.hidden) return;
  var p = linkPair || {}, code = $('linkCode');
  code.hidden = p.step !== 'code';
  if (p.step === 'code') code.textContent = p.code;
  $('linkManual').hidden = p.step !== 'manual';
  $('linkText').textContent = link ? 'Using the Spotify login on ' + link.name + '.'
    : token && !p.step ? 'Connected. The laptop is not needed any more.'
    : p.step === 'finding' ? 'Looking for your laptop on this Wi-Fi...'
    : p.step === 'code' ? 'On ' + p.name + ', press Allow when Earthrise Link shows this code:'
    : 'Run Earthrise Link on your laptop (link\\start.cmd) and log in to Spotify there. Then:';
  $('linkNote').textContent = linkNote;
  $('linkBtn').textContent = link ? 'Stop using the laptop' : (p.step === 'code' || p.step === 'finding') ? 'Cancel' : 'Find my laptop';
}
function renderConnect() {
  renderLink();
  var baked = clientIdBaked();
  $('redirMain').textContent = REDIRECT;
  $('redirTv').hidden = !!native;
  $('cidInput').hidden = baked; $('cidBaked').hidden = !baked;
  $('cid').value = store.get('clientId', '');
  $('spStatus').textContent = token ? 'Connected.' : (DEMO ? 'Demo mode, not connected.' : 'Not connected yet.');
  $('spBtn').textContent = token ? 'Disconnect' : 'Connect Spotify';
  var ytBaked = ytKeyBaked();
  $('ytInput').hidden = ytBaked; $('ytBaked').hidden = !ytBaked;
  $('ytk').value = store.get('ytKey', '');
}
function chipGroup(container, options, current, onPick) {
  container.innerHTML = '';
  options.forEach(function (o) {
    var b = el('button', 'chip', o[1]); b.type = 'button'; b.setAttribute('aria-pressed', String(o[0] === current));
    b.addEventListener('click', function () { onPick(o[0]); });
    container.appendChild(b);
  });
}
function renderSettings() {
  Array.prototype.forEach.call(document.querySelectorAll('.tog'), function (b) { b.setAttribute('aria-pressed', String(!!settings[b.dataset.key])); });
  $('togAudio').hidden = !native;
  var off = (settings.lyricOffset || 0) / 1000;
  $('lyrOffset').textContent = (off > 0 ? '+' : '') + off.toFixed(1) + ' s';
  chipGroup($('textChips'), [['auto', 'Rotate'], ['rise', 'Rise'], ['blur', 'Blur'], ['karaoke', 'Karaoke'], ['type', 'Typewriter']],
    settings.textStyle, function (v) { settings.textStyle = v; saveSettings(); lyricKey = ''; renderSettings(); focusChip('textChips', v); });
  chipGroup($('sceneChips'), [['cover', 'Album cover'], ['artist', 'Singer'], ['video', 'Music video'], ['stars', 'Stars'], ['aurora', 'Aurora'], ['off', 'None']],
    settings.scene, function (v) { settings.scene = v; saveSettings(); renderSettings(); focusChip('sceneChips', v); });
  var note = '';
  if (native) {
    if (nativeAudio.status === 'denied') note = 'Audio permission is off, so the bars follow a simulated beat.';
    else if (nativeAudio.status === 'unavailable') note = 'This TV does not share its sound with apps, so the bars follow a simulated beat.';
    else if (nativeAudio.status === 'on') note = 'Bars follow the sound on this TV. When Spotify plays elsewhere they follow a simulated beat.';
  }
  $('audioNote').textContent = note;
  $('sceneNote').textContent = sceneNoteText();
}
function sceneNoteText() {
  var s = settings.scene;
  if (s === 'artist') return artistBg ? 'A photo of the singer, from Spotify.' : (np.item && connected() ? 'No singer photo for this song, so the album cover shows.' : 'Shows a photo of the singer, from Spotify.');
  if (s !== 'video') return '';
  var until = new Date(store.get('ytQuotaUntil', 0)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return {
    nokey: 'Needs a free YouTube key. See the Connect tab, under Music video background.',
    searching: 'Looking for the music video...',
    loading: 'Loading the music video...',
    playing: 'Muted music video, kept in time with the song. Some videos have a longer intro than the song.',
    none: 'No music video found for this song, so the album cover shows.',
    blocked: 'This song\'s videos only play on YouTube itself, so the album cover shows.',
    quota: 'YouTube\'s free daily limit is used up. New videos come back at ' + until + '. Songs already found still play.',
    keyerror: 'YouTube did not accept the key. Check that YouTube Data API v3 is turned on for it.',
    offline: 'Could not reach YouTube, so the album cover shows.',
    demo: 'Demo mode: connect Spotify to see music videos.'
  }[yt.status] || 'Plays the song\'s music video, muted, behind the record.';
}
function focusChip(groupId, v) {
  var list = $(groupId).children, opts = Array.prototype.map.call(list, function (b) { return b; });
  opts.forEach(function (b) { if (b.getAttribute('aria-pressed') === 'true') b.focus({ preventScroll: true }); });
}
function nudgeLyrics(ms) {
  settings.lyricOffset = clamp((settings.lyricOffset || 0) + ms, -5000, 5000);
  saveSettings(); renderSettings(); lyricKey = '';
}

/* ---------- controls and remote ---------- */
var ctlTimer = 0;
function showControls() {
  stage.classList.add('show-controls'); stage.classList.remove('idle');
  clearTimeout(ctlTimer);
  ctlTimer = setTimeout(function () { if (!drawerOpen() && !wheel.open && connected()) hideControls(); }, 6000);
}
function hideControls() {
  stage.classList.remove('show-controls'); stage.classList.add('idle');
  var a = document.activeElement;
  if (a && a !== document.body && !drawerOpen() && !rowsEl.contains(a)) a.blur();
}

function ui() {
  stage.classList.toggle('disconnected', !connected());
  stage.classList.toggle('is-playing', np.playing);
  stage.classList.toggle('no-clock', !settings.clock);
  stage.classList.toggle('still', !settings.motion);
  $('btnPlay').setAttribute('aria-label', np.playing ? 'Pause' : 'Play');
  $('device').textContent = np.item && np.device ? 'Playing on ' + np.device : '';
  $('wheelLabel').textContent = np.item ? np.item.title : '';
  renderInfo();
  markRows();
  if (!connected()) showControls();
  // only the background note changes with the song; rebuilding the buttons here lost the remote's place
  if (drawerOpen() && drawerTab === 'settings') $('sceneNote').textContent = sceneNoteText();
}

/* Right-hand now-playing panel: title, artist, album, time, up next. Hidden on narrow portrait screens. */
function fmtTime(ms) {
  var s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
}
function renderInfo() {
  var show = settings.info && np.item && !portrait;
  $('info').hidden = !show;
  if (!show) return;
  var it = np.item;
  $('iTitle').textContent = it.title;
  $('iArtist').textContent = it.artist;
  $('iAlbum').textContent = it.album || '';
  var nx = queue[0];
  $('iNext').hidden = !nx;
  if (nx) { $('iNextTitle').textContent = nx.title; $('iNextArtist').textContent = nx.artist; }
  tickInfo();
}
function tickInfo() {
  if ($('info').hidden || !np.item) return;
  var p = Math.min(progressMs(), np.item.duration || Infinity), d = np.item.duration || 0;
  $('iElapsed').textContent = fmtTime(p);
  $('iTotal').textContent = d ? fmtTime(d) : '';
  $('iBar').style.width = d ? (clamp(p / d, 0, 1) * 100).toFixed(2) + '%' : '0';
}

function visible(el) {
  if (!el.getClientRects().length || el.closest('[hidden]')) return false;
  var cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
}
function focusables() {
  var sel = drawerOpen() ? '#drawer button, #drawer input' : '#controls button, #wheelBtn';
  return Array.prototype.filter.call(document.querySelectorAll(sel), visible);
}
function spatial(dir) {
  var items = focusables(), cur = document.activeElement;
  if (items.indexOf(cur) < 0) { if (items.length) items[0].focus(); return; }
  var a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2, best = null, bs = Infinity;
  items.forEach(function (e) {
    if (e === cur) return;
    var b = e.getBoundingClientRect(), dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay, main, cross;
    if (dir === 'ArrowRight') { main = dx; cross = dy; } else if (dir === 'ArrowLeft') { main = -dx; cross = dy; }
    else if (dir === 'ArrowDown') { main = dy; cross = dx; } else { main = -dy; cross = dx; }
    if (main <= 4) return;
    var s = main + Math.abs(cross) * 2;
    if (s < bs) { bs = s; best = e; }
  });
  if (best) best.focus();
}
function focusDefault() {
  var e = connected() ? $('btnPlay') : $('btnConnect');
  if (e && e.getClientRects().length) e.focus();
}

document.addEventListener('keydown', function (e) {
  var k = e.key, arrow = /^Arrow/.test(k), typing = e.target && e.target.tagName === 'INPUT';
  if (k === 'MediaPlayPause') { e.preventDefault(); togglePlay(); return; }
  if (k === 'MediaTrackNext') { e.preventDefault(); control('next'); return; }
  if (k === 'MediaTrackPrevious') { e.preventDefault(); control('prev'); return; }
  if (drawerOpen()) {
    showControls();
    if (k === 'Escape') { e.preventDefault(); if (drawerTab === 'music' && musicView) closeMusicView(); else closeDrawer(); return; }
    if (arrow && !(typing && (k === 'ArrowLeft' || k === 'ArrowRight'))) { e.preventDefault(); spatial(k); }
    return;
  }
  if (wheel.open) {
    if (k === 'ArrowUp') { e.preventDefault(); moveWheel(-1); return; }
    if (k === 'ArrowDown') { e.preventDefault(); moveWheel(1); return; }
    if (k === 'Enter' || k === ' ') { e.preventDefault(); selectWheel(wheel.cursor); return; }
    if (k === 'ArrowRight' || k === 'ArrowLeft') { e.preventDefault(); switchWheel(k === 'ArrowRight' ? 1 : -1); return; }
    if (k === 'Escape') { e.preventDefault(); closeWheel(); showControls(); return; }
    return;
  }
  var wasHidden = !stage.classList.contains('show-controls');
  showControls();
  if (document.activeElement === $('wheelBtn') && (k === 'ArrowUp' || k === 'ArrowDown')) { e.preventDefault(); openWheel(); return; }
  if (wasHidden && (arrow || k === 'Enter')) { e.preventDefault(); focusDefault(); return; }
  if (arrow) { e.preventDefault(); spatial(k); return; }
  if (k === ' ' && !typing) { e.preventDefault(); togglePlay(); return; }
  if (k === 'Escape') hideControls();
});
['mousemove', 'touchstart', 'pointerdown'].forEach(function (ev) { document.addEventListener(ev, function () { showControls(); }, { passive: true }); });

// Mouse wheel or trackpad: over the bottom-left corner (or anywhere while the wheel is open) scrolls songs.
var wheelThrottle = 0;
document.addEventListener('wheel', function (e) {
  if (drawerOpen()) return;
  var inCorner = e.clientX < W * .45 && e.clientY > H * .4;
  if (!inCorner && !wheel.open) return;
  e.preventDefault();
  var now = performance.now();
  if (now - wheelThrottle < 110 || Math.abs(e.deltaY) < 2) return;
  wheelThrottle = now;
  moveWheel(e.deltaY > 0 ? 1 : -1);
}, { passive: false });
// Touch: drag up or down on the wheel to scroll it.
function dragStart(e) { wheel.dragY = e.clientY; wheel.dragged = false; }
function dragMove(e) {
  if (wheel.dragY == null) return;
  var step = portrait ? 44 : 36, d = e.clientY - wheel.dragY;
  if (Math.abs(d) >= step) { wheel.dragged = true; moveWheel(d < 0 ? 1 : -1); wheel.dragY = e.clientY; }
}
function dragEnd() { wheel.dragY = null; setTimeout(function () { wheel.dragged = false; }, 50); }
[rowsEl, $('wheelBtn')].forEach(function (t) {
  t.addEventListener('pointerdown', dragStart);
  t.addEventListener('pointermove', dragMove);
  t.addEventListener('pointerup', dragEnd);
  t.addEventListener('pointercancel', dragEnd);
});
$('wheelBtn').addEventListener('click', function () { if (wheel.dragged) return; if (wheel.open) closeWheel(); else openWheel(); });

$('btnPlay').addEventListener('click', togglePlay);
$('btnNext').addEventListener('click', function () { control('next'); });
$('btnPrev').addEventListener('click', function () { control('prev'); });
/** Connect Spotify: on the TV, use the laptop's login (Earthrise Link) first; the on-TV login stays in the Connect tab. */
function connectSpotify() {
  if (native && native.linkCall) { openDrawer('connect'); if (!link && !linkPair) linkStart(); return; }
  if (clientId()) connect(); else openDrawer('connect');
}
$('btnConnect').addEventListener('click', connectSpotify);
$('searchForm').addEventListener('submit', function (e) { e.preventDefault(); runSearch($('searchQ').value); });
$('btnMusic').addEventListener('click', function () { if (drawerOpen() && drawerTab === 'music') closeDrawer(); else openDrawer('music'); });
$('btnSettings').addEventListener('click', function () { if (drawerOpen() && drawerTab === 'settings') closeDrawer(); else openDrawer('settings'); });
$('drawerClose').addEventListener('click', closeDrawer);
Array.prototype.forEach.call(document.querySelectorAll('.tab[data-tab]'), function (b) {
  b.addEventListener('click', function () { drawerTab = b.dataset.tab; renderDrawer(); b.focus({ preventScroll: true }); });
});
$('spBtn').addEventListener('click', function () { if (token) { disconnect(); toast('Spotify disconnected.'); } else connect(); });
$('linkBtn').addEventListener('click', function () {
  if (link) { disconnect(); toast('No longer using the laptop.'); return; }
  if (linkPair && (linkPair.step === 'code' || linkPair.step === 'finding')) { clearTimeout(linkPollT); linkPair = null; linkNote = ''; renderDrawer(); return; }
  linkStart();
});
$('linkIpGo').addEventListener('click', function () { linkStart($('linkIp').value.trim()); });
$('cidSave').addEventListener('click', function () {
  var v = $('cid').value.trim();
  if (!/^[0-9a-f]{32}$/i.test(v)) { toast('A Spotify Client ID is 32 letters and numbers.'); return; }
  store.set('clientId', v); toast('Client ID saved. Now press Connect Spotify (step 5).'); $('spBtn').focus();
});
$('ytSave').addEventListener('click', function () {
  var v = $('ytk').value.trim();
  if (v && !/^AIza[0-9A-Za-z_-]{35}$/.test(v)) { toast('A Google API key starts with AIza and is 39 characters long.'); return; }
  if (v) store.set('ytKey', v); else store.del('ytKey');
  store.del('ytQuotaUntil'); stopVideo(); yt.status = '';
  toast(v ? 'YouTube key saved. In Settings, set Background to Music video.' : 'YouTube key removed.');
});
Array.prototype.forEach.call(document.querySelectorAll('.tog'), function (b) {
  b.addEventListener('click', function () {
    var key = b.dataset.key; settings[key] = !settings[key];
    saveSettings(); renderSettings(); ui();
    if (key === 'liveAudio') applyLiveAudio();
    lyricKey = '';
  });
});
// Earlier = show lines sooner, for when lyrics lag behind the song.
$('lyrEarlier').addEventListener('click', function () { nudgeLyrics(250); });
$('lyrLater').addEventListener('click', function () { nudgeLyrics(-250); });
document.addEventListener('visibilitychange', function () { if (!document.hidden && token) poll(); });

/* Screen care for a TV left on: drift everything a few pixels so nothing burns in,
   and dim after two minutes of pause while nothing is open. */
function tickScreenCare() {
  var t = Date.now() / 1000;
  if (settings.drift && !stage.classList.contains('show-controls')) {
    stage.classList.add('drift');
    stage.style.transform = 'translate(' + Math.round(Math.sin(t / 600 * TAU) * 12) + 'px,' + Math.round(Math.cos(t / 470 * TAU) * 9) + 'px)';
  } else if (!settings.drift) { stage.classList.remove('drift'); stage.style.transform = ''; }
  var dim = connected() && np.item && !np.playing && np.pausedAt && performance.now() - np.pausedAt > 120000 &&
    !stage.classList.contains('show-controls') && !drawerOpen() && !wheel.open;
  stage.classList.toggle('dimmed', !!dim);
}
function tickClock() {
  $('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
}

var rt = 0;
window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(resize, 90); });
if (DEMO && !token) startDemo();
resize(); buildRows(); ui(); tickClock();
setInterval(tickClock, 10000); setInterval(tickScreenCare, 5000);
applyLiveAudio();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { lyricKey = ''; });
handleCallback().then(function () {
  ui(); if (token || link) poll();
  var asked = native && native.takePlay ? String(native.takePlay() || '') : ''; // opened by Jarvis with something to play
  if (asked) setTimeout(function () { playSearch(asked); }, 800);
  if (connected()) hideControls(); else showControls();
  if (!connected() && !clientId()) openDrawer('connect');
});
requestAnimationFrame(loop);
})();
