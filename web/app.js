/* Earthrise: Spotify now-playing visualizer for TV, phone and browser.
   Part 1 song fan (bottom-left), part 2 synced lyrics (left), part 3 record with sound bars (centre). */
(function () {
'use strict';

/* ---------- pure helpers (also loaded by tests/lib.test.js under Node) ---------- */
var STOP = {};
('a an and are as at be but by do for from go got had has have he her him his i if im in is it its just la me my na no ' +
 'not of oh on or our out over she so that the their them then there they this to too up us was we were what when ' +
 'where who will with yeah you your ya ooh uh ah hey cause dont cant wont aint ill ive id youre')
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

function norm(w) { return w.toLowerCase().replace(/[^a-z0-9]/g, ''); }

/* Turns a lyric line into rows of {w, big}. "*word*" forces big; "/" forces a new row.
   Without markers, content words are big and filler words small, like a poster. */
function layoutLine(text, maxWeight) {
  maxWeight = maxWeight || 13;
  if (typeof text !== 'string') return [];
  var marked = text.indexOf('*') >= 0 || text.indexOf('/') >= 0;
  if (marked) {
    return text.split('/').map(function (r) {
      return r.trim().split(/\s+/).filter(Boolean).map(function (w) {
        var big = /^\*.+\*$/.test(w);
        return { w: w.replace(/\*/g, ''), big: big };
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

var Lib = { parseLrc: parseLrc, lineIndexAt: lineIndexAt, layoutLine: layoutLine };
if (typeof module !== 'undefined' && module.exports) { module.exports = Lib; return; }

/* ---------- setup ---------- */
var TAU = Math.PI * 2;
var $ = function (id) { return document.getElementById(id); };
var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
var native = window.EarthriseNative || null;
var REDIRECT = native ? 'earthrise://callback' : location.origin + location.pathname;
var SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';
var API = 'https://api.spotify.com/v1';
var BPM = 118;

var store = {
  get: function (k, d) { try { var v = localStorage.getItem('er.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set: function (k, v) { try { localStorage.setItem('er.' + k, JSON.stringify(v)); } catch (e) { /* storage blocked: settings last for this visit only */ } },
  del: function (k) { try { localStorage.removeItem('er.' + k); } catch (e) { /* same as above */ } }
};
var settings = Object.assign({ motion: true, clock: true, lyrics: true, liveAudio: true }, store.get('settings', {}));

var stage = $('stage'), cv = $('scene'), ctx = cv.getContext('2d');
var mini = $('mini'), mctx = mini.getContext('2d');
var lyrEl = $('lyrics'), rowsEl = $('rows');

var W = 0, H = 0, DPR = 1, portrait = false, geo = {};
var BARS = 120, HALF = BARS / 2;
var sm = new Float32Array(HALF), target = new Float32Array(HALF), bassSm = 0;
var angle = 0, miniAngle = 0, last = 0;
var disc = null, discPrev = null, discFade = 1, artImg = null, blankDisc = null;
var lyricKey = '';

var token = store.get('token', null);
var np = { item: null, playing: false, progress: 0, at: 0 };
var queue = [], lastQueueAt = 0, rowsSig = '';
var lyrics = null, lyricCache = {};
var backoffUntil = 0, pollTimer = 0, refreshing = null;

/* ?demo=1 shows a fake song with sample lines, for previewing without a Spotify login */
var DEMO = /[?&]demo=1\b/.test(location.search);
var DEMO_LRC = '[00:00.50]I keep the signal in my sight\n[00:04.50]Every city burning bright\n[00:08.50]Spin the planet slow\n' +
  '[00:12.50]Nowhere left to go\n[00:16.50]Falling up through the quiet\n[00:20.50]Weightless in the blue\n[00:24.50]Hold on to the orbit\n[00:28.50]Pulling me back to you\n[00:32.50]';
function connected() { return !!token || DEMO; }
function startDemo() {
  np = { item: { id: 'demo', title: 'Orbit Line', artist: 'Demo mode', album: '', duration: 33000, art: '', thumb: '' }, playing: true, progress: 0, at: performance.now() };
  lyrics = { id: 'demo', lines: parseLrc(DEMO_LRC), loading: false };
  queue = [{ id: 'q1', title: 'Low Gravity', artist: 'Demo mode', thumb: '' }, { id: 'q2', title: 'Signal Fire', artist: 'Demo mode', thumb: '' }];
  setInterval(function () { if (np.playing && progressMs() > 33000) { np.progress = 0; np.at = performance.now(); } }, 500);
}

function clientId() {
  var id = '';
  try { id = native && native.getClientId ? String(native.getClientId() || '') : ''; } catch (e) { id = ''; }
  return id || store.get('clientId', '');
}
function progressMs() { return np.playing ? np.progress + (performance.now() - np.at) : np.progress; }

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
  if (!id) { openPanel(); toast('Add your Spotify Client ID first.'); $('cid').focus(); return; }
  if (!window.crypto || !crypto.subtle) { toast('Spotify login needs a secure page. Open it over https or from the app.'); return; }
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
      token = { access: j.access_token, refresh: j.refresh_token || (token && token.refresh), exp: Date.now() + (j.expires_in || 3600) * 1000 };
      store.set('token', token);
    });
  });
}

function handleCallback() {
  var q = new URLSearchParams(location.search), code = q.get('code'), err = q.get('error');
  if (!code && !err) return Promise.resolve();
  history.replaceState(null, '', location.pathname);
  if (err) { toast('Spotify login was cancelled.'); return Promise.resolve(); }
  if (q.get('state') !== store.get('state', null)) { toast('Login check failed. Try Connect Spotify again.'); return Promise.resolve(); }
  return tokenRequest({ grant_type: 'authorization_code', code: code, redirect_uri: REDIRECT, client_id: clientId(), code_verifier: store.get('verifier', '') })
    .then(function () { toast('Spotify connected. Play something on any device.'); })
    .catch(function (e) { toast('Spotify login failed: ' + e.message); })
    .then(function () { store.del('verifier'); store.del('state'); });
}

function disconnect() {
  token = null; store.del('token'); np = { item: null, playing: false, progress: 0, at: 0 };
  queue = []; lyrics = null; clearTimeout(pollTimer); setDisc(null); buildRows(); ui();
}

function accessToken() {
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
    return fetch(API + path, { method: opts.method || 'GET', headers: { Authorization: 'Bearer ' + t } });
  }).then(function (r) {
    if (r.status === 401 && !retried && token) { token.exp = 0; return api(path, opts, true); }
    if (r.status === 429) {
      backoffUntil = Date.now() + (Number(r.headers.get('Retry-After')) || 5) * 1000;
      throw new Error('rate limited');
    }
    return r;
  });
}

/* ---------- now playing ---------- */
function poll() {
  clearTimeout(pollTimer);
  if (!token) return;
  var delay = 3000;
  if (Date.now() < backoffUntil) { pollTimer = setTimeout(poll, backoffUntil - Date.now()); return; }
  var t0 = performance.now();
  api('/me/player/currently-playing?additional_types=track,episode').then(function (r) {
    var rtt = performance.now() - t0;
    if (r.status === 204) { setNothing(); delay = 5000; return; }
    if (!r.ok) { delay = 8000; return; }
    return r.json().then(function (j) { applyPlayback(j, rtt); delay = j.is_playing ? 2500 : 5000; });
  }).catch(function () { delay = 8000; }).then(function () {
    if (np.item && Date.now() - lastQueueAt > 20000) loadQueue();
    if (token) pollTimer = setTimeout(poll, document.hidden ? 15000 : delay);
  });
}

function setNothing() {
  if (np.item) { np.item = null; queue = []; lyrics = null; setDisc(null); buildRows(); }
  np.playing = false; ui();
}

function applyPlayback(j, rtt) {
  var it = j && j.item;
  if (!it) { setNothing(); return; }
  var id = it.id || it.uri;
  np.playing = !!j.is_playing;
  np.progress = (j.progress_ms || 0) + (np.playing ? rtt / 2 : 0);
  np.at = performance.now();
  if (!np.item || np.item.id !== id) {
    var imgs = (it.album ? it.album.images : it.images) || [];
    np.item = {
      id: id, title: it.name || '',
      artist: it.artists ? it.artists.map(function (a) { return a.name; }).join(', ') : (it.show ? it.show.name : ''),
      album: it.album ? it.album.name : '', duration: it.duration_ms || 0,
      art: imgs.length ? imgs[0].url : '', thumb: imgs.length ? imgs[imgs.length - 1].url : ''
    };
    onTrackChange();
  }
  ui();
}

function onTrackChange() {
  lyricKey = '';
  loadArt(np.item.art);
  loadLyrics(np.item);
  queue = []; buildRows(); loadQueue();
}

function loadQueue() {
  lastQueueAt = Date.now();
  api('/me/player/queue').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
    if (!j || !j.queue) return;
    var seen = {}; queue = [];
    j.queue.forEach(function (it) {
      if (queue.length >= 3 || !it || seen[it.id]) return;
      seen[it.id] = true;
      var imgs = (it.album ? it.album.images : it.images) || [];
      queue.push({ id: it.id, title: it.name || '', artist: it.artists ? it.artists.map(function (a) { return a.name; }).join(', ') : (it.show ? it.show.name : ''),
        thumb: imgs.length ? imgs[imgs.length - 1].url : '' });
    });
    buildRows();
  }).catch(function () { /* queue is a nice-to-have; the fan just shows the current song */ });
}

function control(action) {
  if (DEMO && !token) {
    if (action === 'play' || action === 'pause') { np.progress = progressMs(); np.at = performance.now(); np.playing = action === 'play'; ui(); }
    else toast('Demo mode: skipping works once Spotify is connected.');
    return Promise.resolve(true);
  }
  if (!token) { connect(); return Promise.resolve(); }
  var map = { play: ['PUT', '/me/player/play'], pause: ['PUT', '/me/player/pause'], next: ['POST', '/me/player/next'], prev: ['POST', '/me/player/previous'] };
  var m = map[action];
  return api(m[1], { method: m[0] }).then(function (r) {
    if (r.status === 403) { toast('Play, pause and skip from here need Spotify Premium.'); return false; }
    if (r.status === 404) { toast('No active Spotify device. Start playing on your phone or TV first.'); return false; }
    if (!r.ok) { toast('Spotify did not accept that (' + r.status + ').'); return false; }
    if (action === 'play' || action === 'pause') { np.progress = progressMs(); np.at = performance.now(); np.playing = action === 'play'; ui(); }
    return true;
  }).catch(function () { toast('Could not reach Spotify.'); return false; })
    .then(function (ok) { setTimeout(poll, 450); return ok; });
}
function togglePlay() { return control(np.playing ? 'pause' : 'play'); }
function skipForward(n) {
  var p = Promise.resolve(true);
  for (var i = 0; i < n; i++) p = p.then(function (ok) { return ok ? control('next') : false; });
  return p;
}

/* ---------- lyrics (LRCLIB, free synced lyrics) ---------- */
function loadLyrics(item) {
  var key = item.id;
  if (lyricCache[key]) { lyrics = lyricCache[key]; return; }
  lyrics = { id: key, lines: null, loading: true };
  var artist = item.artist.split(', ')[0];
  var q = new URLSearchParams({ track_name: item.title, artist_name: artist, album_name: item.album, duration: String(Math.round(item.duration / 1000)) });
  fetch('https://lrclib.net/api/get?' + q.toString()).then(function (r) {
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
    lyricCache[key] = res;
    if (np.item && np.item.id === key) { lyrics = res; lyricKey = ''; }
  });
}

function currentLyric() {
  if (!connected()) return { key: 'connect', text: '*Connect* / *Spotify*', dur: 4000 };
  if (!np.item) return { key: 'idle', text: '*Play* something / on *Spotify*', dur: 4000 };
  var it = np.item;
  if (settings.lyrics && lyrics && lyrics.id === it.id && lyrics.lines) {
    var p = progressMs() + 250, i = lineIndexAt(lyrics.lines, p);
    if (i >= 0) {
      var L = lyrics.lines[i], nxt = lyrics.lines[i + 1];
      return { key: it.id + ':' + i, text: L.text, dur: nxt ? nxt.t - L.t : 4000 };
    }
  }
  var title = it.title.replace(/\s*[\(\[].*?[\)\]]\s*/g, ' ').trim() || it.title;
  var bigTitle = title.split(/\s+/).map(function (w) { return '*' + w.replace(/[*/]/g, '') + '*'; }).join(' ');
  return { key: it.id + ':title', text: bigTitle + ' / ' + it.artist.replace(/[*/]/g, ''), dur: 4000 };
}

function showLyric(text, dur) {
  var old = lyrEl.querySelector('.block:not(.out)');
  var rows = layoutLine(text, portrait ? 17 : 21);
  var count = rows.reduce(function (n, r) { return n + r.length; }, 0);
  lyrEl.classList.toggle('dense', count > 8);
  var blk = document.createElement('div'); blk.className = 'block';
  rows.forEach(function (r) {
    var row = document.createElement('div'); row.className = 'row';
    r.forEach(function (x) { var s = document.createElement('span'); s.className = 'w' + (x.big ? ' big' : ''); s.textContent = x.w; row.appendChild(s); });
    blk.appendChild(row);
  });
  if (!settings.motion) {
    var all = lyrEl.querySelectorAll('.block'); for (var i = 0; i < all.length; i++) all[i].remove();
    var ws = blk.querySelectorAll('.w'); for (var j = 0; j < ws.length; j++) ws[j].classList.add('on');
    lyrEl.appendChild(blk); return;
  }
  if (old) { old.classList.add('out'); setTimeout(function () { old.remove(); }, 420); }
  if (!count) return;
  lyrEl.appendChild(blk);
  var per = Math.min(110, (dur || 4000) * .45 / count);
  var words = blk.querySelectorAll('.w');
  Array.prototype.forEach.call(words, function (w, k) { setTimeout(function () { w.classList.add('on'); }, 120 + k * per); });
}

function tickLyrics() {
  var c = currentLyric();
  if (c.key !== lyricKey) { lyricKey = c.key; showLyric(c.text, c.dur); }
}

/* ---------- record art ---------- */
function makeDisc(img, px) {
  var c = document.createElement('canvas'); c.width = c.height = px;
  var g = c.getContext('2d'), R = px / 2;
  g.translate(R, R); g.beginPath(); g.arc(0, 0, R, 0, TAU); g.clip();
  if (img) {
    var s = Math.max(px / img.naturalWidth, px / img.naturalHeight), w = img.naturalWidth * s, h = img.naturalHeight * s;
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
function setDisc(img) {
  artImg = img;
  if (!W) return;
  discPrev = disc; discFade = settings.motion && discPrev ? 0 : 1;
  disc = img ? makeDisc(img, discPx()) : blankDisc;
}
function loadArt(url) {
  if (!url) { setDisc(null); return; }
  var img = new Image();
  img.onload = function () { if (np.item && np.item.art === url) setDisc(img); };
  img.onerror = function () { setDisc(null); };
  img.src = url;
}

/* ---------- song fan (part 1) ---------- */
function buildRows() {
  var items = [];
  if (np.item) items.push({ id: np.item.id, title: np.item.title, artist: np.item.artist, thumb: np.item.thumb, pos: 0 });
  queue.forEach(function (q, i) { items.push({ id: q.id, title: q.title, artist: q.artist, thumb: q.thumb, pos: i + 1 }); });
  var sig = items.map(function (x) { return x.id; }).join('|');
  if (sig === rowsSig) { markRows(); return; }
  rowsSig = sig; rowsEl.innerHTML = '';
  items.forEach(function (x) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'song' + (x.pos === 0 ? ' active' : ''); b.dataset.pos = String(x.pos);
    var pic;
    if (x.thumb) { pic = document.createElement('img'); pic.src = x.thumb; pic.alt = ''; } else { pic = document.createElement('span'); pic.className = 'ph'; }
    var meta = document.createElement('span'); meta.className = 'meta';
    var t = document.createElement('b'); t.textContent = x.title;
    var a = document.createElement('small'); a.textContent = x.pos === 0 ? x.artist : 'Up next · ' + x.artist;
    meta.appendChild(t); meta.appendChild(a);
    var eq = document.createElement('span'); eq.className = 'eq'; eq.setAttribute('aria-hidden', 'true'); eq.innerHTML = '<i></i><i></i><i></i>';
    b.appendChild(pic); b.appendChild(meta); b.appendChild(eq);
    b.setAttribute('aria-label', x.pos === 0 ? 'Now playing ' + x.title + '. Press to play or pause.' : 'Skip to ' + x.title);
    b.addEventListener('click', function () { if (x.pos === 0) togglePlay(); else skipForward(x.pos); });
    rowsEl.appendChild(b);
  });
  layoutPicker(); markRows();
}
function markRows() {
  Array.prototype.forEach.call(rowsEl.children, function (b) { b.classList.toggle('playing', b.dataset.pos === '0' && np.playing); });
}
function layoutPicker() {
  if (!W) return;
  var u = W / 100, P = portrait;
  var discD = P ? 26 * u : 11 * u, dcx = P ? 5 * u : 2 * u, dcy = H - (P ? 21 * u : 10 * u);
  geo.mini = { x: dcx, y: dcy, d: discD };
  mini.style.width = mini.style.height = discD + 'px';
  mini.style.left = (dcx - discD / 2) + 'px'; mini.style.top = (dcy - discD / 2) + 'px';
  mini.width = mini.height = Math.round(discD * DPR);
  var rowH = P ? clamp(10 * u, 40, 48) : clamp(3.3 * u, 30, 60);
  var fs = clamp(rowH * .36, 12, 22);
  var R = Math.max(P ? 30 * u : 8.5 * u, discD / 2 + 12);
  var rows = rowsEl.children, n = rows.length, k = (n - 1) * (P ? .7 : .6);
  for (var i = 0; i < n; i++) {
    var el = rows[i], dy = (i - k) * rowH * 1.12;
    var dx = Math.sqrt(Math.max(R * R - dy * dy, Math.pow(discD / 2 + 10, 2)));
    var ang = Math.atan2(dy, dx) * (P ? .25 : .75);
    el.style.height = rowH + 'px'; el.style.fontSize = fs + 'px';
    el.style.transform = 'translate(' + (dcx + dx) + 'px,' + (dcy + dy - rowH / 2) + 'px) rotate(' + ang + 'rad)';
  }
}

/* ---------- live TV audio from the Android app ---------- */
var nativeAudio = { arr: null, at: 0, lastSignal: 0 };
window.onNativeSpectrum = function (arr) {
  var t = performance.now(); nativeAudio.arr = arr; nativeAudio.at = t;
  for (var i = 0; i < arr.length; i++) if (arr[i] > .08) { nativeAudio.lastSignal = t; break; }
};
window.onNativeAudioStatus = function (s) {
  var note = $('audioNote');
  if (s === 'denied') note.textContent = 'Audio permission is off, so the bars follow a simulated beat.';
  else if (s === 'unavailable') note.textContent = 'This TV does not share its sound with apps, so the bars follow a simulated beat.';
  else if (s === 'on') note.textContent = 'Bars follow the sound playing on this TV. If Spotify plays on another device, they follow a simulated beat.';
  else note.textContent = '';
};
window.onNativeKey = function (name) {
  if (name === 'playpause') togglePlay();
  else if (name === 'next') control('next');
  else if (name === 'prev') control('prev');
  else if (name === 'menu') { if (panelOpen()) closePanel(); else openPanel(); }
};
window.handleBack = function () {
  if (panelOpen()) { closePanel(); return true; }
  if (stage.classList.contains('show-controls')) { hideControls(); return true; }
  return false;
};
function applyLiveAudio() {
  if (native && native.setLiveAudio) { try { native.setLiveAudio(!!settings.liveAudio); } catch (e) { window.onNativeAudioStatus('unavailable'); } }
}
function nativeLive() {
  var t = performance.now();
  return !!nativeAudio.arr && t - nativeAudio.at < 500 && t - nativeAudio.lastSignal < 2500;
}

/* ---------- bars (part 3) ---------- */
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
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  var cx = geo.cx, cy = geo.cy, r = geo.r, pulse = settings.motion ? bassSm : 0, sc = 1 + pulse * .045;

  var gr = ctx.createRadialGradient(cx, cy, r * .8, cx, cy, r * 3.2);
  gr.addColorStop(0, 'rgba(236,243,255,' + (.2 + pulse * .22) + ')');
  gr.addColorStop(.35, 'rgba(200,220,245,' + (.07 + pulse * .08) + ')');
  gr.addColorStop(1, 'rgba(200,220,245,0)');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);

  var r0 = r * sc * 1.08;
  ctx.lineWidth = Math.max(1, TAU * r0 / BARS * .5); ctx.lineCap = 'butt';
  for (var i = 0; i < BARS; i++) {
    var k = Math.min(HALF - 1, i <= HALF ? i : BARS - i), v = sm[k];
    var a = -Math.PI / 2 + i / BARS * TAU, ca = Math.cos(a), sa = Math.sin(a);
    var len = r * (.05 + Math.pow(v, 1.35) * .85);
    ctx.strokeStyle = 'rgba(255,255,255,' + (.45 + .55 * v) + ')';
    ctx.beginPath(); ctx.moveTo(cx + ca * r0, cy + sa * r0); ctx.lineTo(cx + ca * (r0 + len), cy + sa * (r0 + len)); ctx.stroke();
  }

  if (settings.motion) { angle += dt * (active ? 1.1 : .15); miniAngle += dt * (active ? 2.2 : .3); }
  if (discFade < 1) discFade = Math.min(1, discFade + dt * 2.5);
  var cur = disc || blankDisc;
  ctx.save(); ctx.translate(cx, cy); ctx.scale(sc, sc); ctx.rotate(angle);
  if (discPrev && discFade < 1) { ctx.globalAlpha = 1; ctx.drawImage(discPrev, -r, -r, r * 2, r * 2); ctx.globalAlpha = discFade; }
  if (cur) ctx.drawImage(cur, -r, -r, r * 2, r * 2);
  ctx.globalAlpha = 1; ctx.restore();
  drawSheen(ctx, cx, cy, r * sc);
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r * sc, 0, TAU);
  ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = Math.max(1.5, r * .016);
  ctx.shadowColor = 'rgba(255,255,255,.95)'; ctx.shadowBlur = r * .22; ctx.stroke(); ctx.restore();

  var md = mini.width;
  mctx.setTransform(1, 0, 0, 1, 0, 0); mctx.clearRect(0, 0, md, md);
  if (cur) { mctx.save(); mctx.translate(md / 2, md / 2); mctx.rotate(miniAngle); mctx.drawImage(cur, -md / 2, -md / 2, md, md); mctx.restore(); }
  drawSheen(mctx, md / 2, md / 2, md / 2);
  mctx.beginPath(); mctx.arc(md / 2, md / 2, md / 2 - DPR, 0, TAU);
  mctx.strokeStyle = 'rgba(255,255,255,.7)'; mctx.lineWidth = 1.5 * DPR; mctx.stroke();

  lyrEl.style.transform = settings.motion ? 'scale(' + (1 + pulse * .025) + ')' : '';
}

function loop(t) {
  var dt = Math.min(.05, (t - (last || t)) / 1000); last = t;
  if (W) draw(t, dt);
  tickLyrics();
  requestAnimationFrame(loop);
}

/* ---------- layout ---------- */
function resize() {
  W = window.innerWidth; H = window.innerHeight;
  if (!W || !H) return;
  DPR = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  portrait = H > W;
  stage.classList.toggle('portrait', portrait);
  geo = portrait ? { cx: W * .5, cy: H * .5, r: W * .18 } : { cx: W * .5, cy: H * .48, r: H * .17 };
  blankDisc = makeDisc(null, discPx());
  disc = artImg ? makeDisc(artImg, discPx()) : blankDisc; discPrev = null; discFade = 1;
  layoutPicker();
  lyricKey = '';
}

/* ---------- controls, settings, remote ---------- */
var ctlTimer = 0;
function panelOpen() { return !$('panel').hidden; }
function showControls() {
  stage.classList.add('show-controls'); stage.classList.remove('idle');
  clearTimeout(ctlTimer);
  ctlTimer = setTimeout(function () { if (!panelOpen() && connected()) hideControls(); }, 6000);
}
function hideControls() {
  stage.classList.remove('show-controls'); stage.classList.add('idle');
  if (document.activeElement && document.activeElement !== document.body && !panelOpen()) document.activeElement.blur();
}
function openPanel() {
  $('panel').hidden = false; showControls(); syncPanel();
  setTimeout(function () { $('spBtn').focus(); }, 30);
}
function closePanel() { $('panel').hidden = true; showControls(); $('btnSettings').focus(); }
function syncPanel() {
  $('spStatus').textContent = token ? 'Connected' : 'Not connected';
  $('spBtn').textContent = token ? 'Disconnect' : 'Connect Spotify';
  var baked = false; try { baked = !!(native && native.getClientId && native.getClientId()); } catch (e) { baked = false; }
  $('cidRow').hidden = baked;
  $('cid').value = store.get('clientId', '');
  $('redir').textContent = REDIRECT;
  $('togAudio').hidden = !native;
  Array.prototype.forEach.call(document.querySelectorAll('.tog'), function (b) { b.setAttribute('aria-pressed', String(!!settings[b.dataset.key])); });
}

function ui() {
  stage.classList.toggle('disconnected', !connected());
  stage.classList.toggle('is-playing', np.playing);
  stage.classList.toggle('no-clock', !settings.clock);
  stage.classList.toggle('still', !settings.motion);
  $('btnPlay').setAttribute('aria-label', np.playing ? 'Pause' : 'Play');
  markRows();
  if (!connected()) showControls();
}

function focusables() {
  var sel = panelOpen() ? '#panel button:not([hidden]), #panel input' : '#controls button, #rows button';
  return Array.prototype.filter.call(document.querySelectorAll(sel), function (el) {
    return el.getClientRects().length && !el.closest('[hidden]') && getComputedStyle(el).display !== 'none';
  });
}
function spatial(dir) {
  var items = focusables(), cur = document.activeElement;
  if (items.indexOf(cur) < 0) { if (items.length) items[0].focus(); return; }
  var a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2, best = null, bs = Infinity;
  items.forEach(function (el) {
    if (el === cur) return;
    var b = el.getBoundingClientRect(), dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay, main, cross;
    if (dir === 'ArrowRight') { main = dx; cross = dy; } else if (dir === 'ArrowLeft') { main = -dx; cross = dy; }
    else if (dir === 'ArrowDown') { main = dy; cross = dx; } else { main = -dy; cross = dx; }
    if (main <= 4) return;
    var s = main + Math.abs(cross) * 2;
    if (s < bs) { bs = s; best = el; }
  });
  if (best) best.focus();
}
function focusDefault() {
  var el = connected() ? $('btnPlay') : $('btnConnect');
  if (el && el.getClientRects().length) el.focus();
}

document.addEventListener('keydown', function (e) {
  var k = e.key, arrow = /^Arrow/.test(k), typing = e.target && e.target.tagName === 'INPUT';
  if (k === 'MediaPlayPause') { e.preventDefault(); togglePlay(); return; }
  if (k === 'MediaTrackNext') { e.preventDefault(); control('next'); return; }
  if (k === 'MediaTrackPrevious') { e.preventDefault(); control('prev'); return; }
  if (panelOpen()) {
    showControls();
    if (k === 'Escape') { e.preventDefault(); closePanel(); return; }
    if (arrow && !(typing && (k === 'ArrowLeft' || k === 'ArrowRight'))) { e.preventDefault(); spatial(k); }
    return;
  }
  var wasHidden = !stage.classList.contains('show-controls');
  showControls();
  if (wasHidden && (arrow || k === 'Enter')) { e.preventDefault(); focusDefault(); return; }
  if (arrow) { e.preventDefault(); spatial(k); return; }
  if (k === ' ' && !typing) { e.preventDefault(); togglePlay(); return; }
  if (k === 'Escape') hideControls();
});
['mousemove', 'touchstart', 'pointerdown'].forEach(function (ev) { document.addEventListener(ev, function () { showControls(); }, { passive: true }); });

$('btnPlay').addEventListener('click', togglePlay);
$('btnNext').addEventListener('click', function () { control('next'); });
$('btnPrev').addEventListener('click', function () { control('prev'); });
$('btnConnect').addEventListener('click', connect);
$('btnSettings').addEventListener('click', function () { if (panelOpen()) closePanel(); else openPanel(); });
$('closePanel').addEventListener('click', closePanel);
$('spBtn').addEventListener('click', function () { if (token) { disconnect(); syncPanel(); toast('Spotify disconnected.'); } else connect(); });
$('cidSave').addEventListener('click', function () {
  var v = $('cid').value.trim();
  if (!/^[0-9a-f]{32}$/i.test(v)) { toast('A Spotify Client ID is 32 letters and numbers.'); return; }
  store.set('clientId', v); toast('Client ID saved. Now press Connect Spotify.'); $('spBtn').focus();
});
Array.prototype.forEach.call(document.querySelectorAll('.tog'), function (b) {
  b.addEventListener('click', function () {
    var key = b.dataset.key; settings[key] = !settings[key];
    store.set('settings', settings); syncPanel(); ui();
    if (key === 'liveAudio') applyLiveAudio();
    lyricKey = '';
  });
});
document.addEventListener('visibilitychange', function () { if (!document.hidden && token) poll(); });

function tickClock() {
  $('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
}

var rt = 0;
window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(resize, 90); });
if (DEMO && !token) startDemo();
resize(); buildRows(); ui(); tickClock(); setInterval(tickClock, 10000);
applyLiveAudio();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { lyricKey = ''; });
handleCallback().then(function () { ui(); if (token) poll(); if (connected()) hideControls(); else showControls(); });
requestAnimationFrame(loop);
})();
