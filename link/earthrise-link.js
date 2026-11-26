#!/usr/bin/env node
/* Earthrise Link: keeps the Spotify login on this laptop and hands paired TVs a short-lived access token.
   No dependencies. Start with start.cmd (Windows) or: node link/earthrise-link.js
   Contract v1 for the TV app is in link/README.md. */
'use strict';
const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 5173;            // http://127.0.0.1:5173/ is already a registered Spotify redirect URI
const DISCOVERY_PORT = 5198;
const REDIRECT = 'http://127.0.0.1:' + PORT + '/';
const SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state ' +
  'user-read-recently-played playlist-read-private user-library-read';
const WEB_ROOT = path.resolve(__dirname, '..', 'web');
const DATA_DIR = process.env.APPDATA ? path.join(process.env.APPDATA, 'Earthrise') : path.join(os.homedir(), '.earthrise');
const DATA_FILE = path.join(DATA_DIR, 'link.json');
const PAIR_TTL = 5 * 60 * 1000;
const MAX_PENDING = 10;
const LAPTOP_NAME = os.hostname();

/* ---------- small pure helpers (exported for tests) ---------- */
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function isLoopback(addr) { return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'; }
/* Only answer requests addressed to an IP or localhost, so a web page cannot reach this server through a
   domain it points at 127.0.0.1 (DNS rebinding). */
function hostAllowed(host) {
  if (!host) return false;
  const h = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
}
function bearer(req) {
  const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(req.headers.authorization || '');
  return m ? m[1].toLowerCase() : '';
}
function lanAddresses() {
  const out = [];
  Object.values(os.networkInterfaces()).forEach(list => (list || []).forEach(a => {
    if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) out.push(a.address);
  }));
  return out;
}
function clientIdFromEnv(envText) {
  const m = /^\s*SPOTIFY_CLIENT_ID\s*=\s*([0-9a-fA-F]{32})\s*$/m.exec(envText || '');
  return m ? m[1] : '';
}

/* ---------- saved state: Spotify login and paired devices ---------- */
function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { spotify: d.spotify || null, devices: Array.isArray(d.devices) ? d.devices : [] };
  } catch (e) {
    if (e.code !== 'ENOENT') log('Could not read ' + DATA_FILE + ' (' + e.message + '), starting fresh.');
    return { spotify: null, devices: [] };
  }
}
function saveData() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    log('Could not save ' + DATA_FILE + ': ' + e.message);
  }
}
function log(msg) {
  const t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  console.log('[' + t + '] ' + msg);
}

let data = { spotify: null, devices: [] };
let clientId = '';
let login = null;          // { state, verifier, at } while a Spotify login is in progress
let refreshing = null;     // the in-flight refresh, so parallel token requests share it
const pairs = new Map();   // pairId -> { code, device, at, status, secret }

/* ---------- Spotify ---------- */
async function spotifyToken(params) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.assign({ client_id: clientId }, params)).toString()
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(j.error_description || j.error || ('HTTP ' + r.status)); err.code = j.error; throw err; }
  return j;
}
function keepTokens(j) {
  const prev = data.spotify || {};
  data.spotify = {
    access: j.access_token,
    refresh: j.refresh_token || prev.refresh,
    exp: Date.now() + (j.expires_in || 3600) * 1000,
    scope: j.scope || prev.scope || SCOPES,
    user: prev.user || ''
  };
  saveData();
}
/* A token with at least 5 minutes left, refreshing when needed. Throws 'login_needed' when the laptop is not logged in. */
async function freshToken() {
  if (!data.spotify || !data.spotify.refresh) { const e = new Error('login_needed'); e.code = 'login_needed'; throw e; }
  if (data.spotify.access && data.spotify.exp - Date.now() > 5 * 60 * 1000) return data.spotify;
  if (!refreshing) {
    refreshing = spotifyToken({ grant_type: 'refresh_token', refresh_token: data.spotify.refresh })
      .then(j => { keepTokens(j); log('Refreshed the Spotify token.'); return data.spotify; })
      .catch(e => {
        if (e.code === 'invalid_grant') { data.spotify = null; saveData(); log('Spotify login expired. Log in again on the Earthrise Link page.'); const le = new Error('login_needed'); le.code = 'login_needed'; throw le; }
        throw e;
      })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}
async function loadUserName() {
  try {
    const r = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: 'Bearer ' + data.spotify.access } });
    if (r.ok) { const j = await r.json(); data.spotify.user = j.display_name || j.id || ''; saveData(); }
  } catch (e) { /* the name is only shown on the laptop page; skip it when offline */ }
}

/* ---------- HTTP helpers ---------- */
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json', png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon', webp: 'image/webp', jpg: 'image/jpeg' };
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '600');
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) { resolve({}); return; }
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}
/* Laptop-page actions: only from this laptop, only from our own page (custom header blocks cross-site posts). */
function laptopAction(req) {
  if (!isLoopback(req.socket.remoteAddress) || req.headers['x-earthrise'] !== '1') return false;
  const origin = req.headers.origin;
  return !origin || /^http:\/\/(127\.0\.0\.1|localhost):5173$/.test(origin);
}
function deviceFor(secret) {
  if (!secret) return null;
  const h = Buffer.from(sha256(secret), 'hex');
  return data.devices.find(d => {
    const s = Buffer.from(d.secretHash || '', 'hex');
    return s.length === h.length && crypto.timingSafeEqual(s, h);
  }) || null;
}
function prunePairs() {
  const now = Date.now();
  pairs.forEach((p, id) => {
    if (p.status === 'pending' && now - p.at > PAIR_TTL) p.status = 'expired';
    if (now - p.at > PAIR_TTL * 2) pairs.delete(id);
  });
}

/* ---------- routes ---------- */
async function handle(req, res) {
  if (!hostAllowed(req.headers.host)) { res.writeHead(403); res.end('Forbidden'); return; }
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  const p = url.pathname;
  const local = isLoopback(req.socket.remoteAddress);

  if (p.startsWith('/link/') && ['/link/status', '/link/pair', '/link/token'].some(x => p === x || p.startsWith('/link/pair/'))) cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Spotify sends the laptop login back to http://127.0.0.1:5173/?code=...&state=link-...
  if (p === '/' && (url.searchParams.get('state') || '').startsWith('link-')) { await finishLogin(url, res, local); return; }

  if (p === '/link/status' && req.method === 'GET') {
    json(res, 200, { app: 'earthrise-link', v: 1, name: LAPTOP_NAME, spotify: !!(data.spotify && data.spotify.refresh) });
    return;
  }
  if (p === '/link/pair' && req.method === 'POST') {
    prunePairs();
    let body;
    try { body = await readBody(req, 1024); } catch (e) { json(res, 400, { error: 'bad_request' }); return; }
    if ([...pairs.values()].filter(x => x.status === 'pending').length >= MAX_PENDING) { json(res, 429, { error: 'too_many_requests' }); return; }
    const id = crypto.randomBytes(8).toString('hex'), code = String(crypto.randomInt(1000, 10000));
    const device = String(body.device || 'TV').replace(/[^\w .'-]/g, '').slice(0, 40) || 'TV';
    pairs.set(id, { code, device, at: Date.now(), status: 'pending', secret: '', from: req.socket.remoteAddress });
    log(device + ' asked to connect (code ' + code + '). Allow it on the Earthrise Link page.');
    json(res, 200, { pairId: id, code });
    return;
  }
  if (p.startsWith('/link/pair/') && req.method === 'GET') {
    prunePairs();
    const pr = pairs.get(p.slice('/link/pair/'.length));
    if (!pr) { json(res, 404, { status: 'expired' }); return; }
    if (pr.status === 'approved') { json(res, 200, { status: 'approved', secret: pr.secret }); pairs.delete(p.slice(11)); return; }
    json(res, 200, { status: pr.status });
    return;
  }
  if (p === '/link/token' && req.method === 'GET') {
    const dev = deviceFor(bearer(req));
    if (!dev && !local) { json(res, 401, { error: 'unpaired' }); return; }
    try {
      const t = await freshToken();
      if (dev) { dev.lastSeen = Date.now(); }
      json(res, 200, { access_token: t.access, expires_at: t.exp, scope: t.scope });
    } catch (e) {
      if (e.code === 'login_needed') json(res, 409, { error: 'spotify_login_needed' });
      else { log('Token refresh failed: ' + e.message); json(res, 502, { error: 'spotify_unreachable' }); }
    }
    return;
  }

  // ----- the laptop page and its actions -----
  if (p === '/link' || p === '/link/') {
    if (!local) { res.writeHead(403); res.end('Open this page on the laptop itself.'); return; }
    res.writeHead(200, { 'Content-Type': TYPES.html, 'Cache-Control': 'no-store' });
    res.end(PAGE);
    return;
  }
  if (p === '/link/login' && req.method === 'GET') {
    if (!local) { res.writeHead(403); res.end('Log in on the laptop itself.'); return; }
    if (!clientId) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('No Spotify Client ID. Fill SPOTIFY_CLIENT_ID in the .env file next to the web folder.'); return; }
    const verifier = crypto.randomBytes(48).toString('base64url');
    login = { state: 'link-' + crypto.randomBytes(12).toString('hex'), verifier, at: Date.now() };
    const q = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: REDIRECT, scope: SCOPES,
      state: login.state, code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url') });
    res.writeHead(302, { Location: 'https://accounts.spotify.com/authorize?' + q.toString() });
    res.end();
    return;
  }
  if (p === '/link/state' && req.method === 'GET') {
    if (!local) { res.writeHead(403); res.end(); return; }
    prunePairs();
    json(res, 200, {
      name: LAPTOP_NAME, addresses: lanAddresses(), port: PORT,
      spotify: data.spotify && data.spotify.refresh ? { user: data.spotify.user || '' } : null,
      pending: [...pairs.entries()].filter(e => e[1].status === 'pending').map(e => ({ pairId: e[0], code: e[1].code, device: e[1].device, from: e[1].from })),
      devices: data.devices.map(d => ({ id: d.id, name: d.name, added: d.added, lastSeen: d.lastSeen || 0 }))
    });
    return;
  }
  if (req.method === 'POST' && ['/link/approve', '/link/deny', '/link/forget', '/link/logout'].includes(p)) {
    if (!laptopAction(req)) { res.writeHead(403); res.end(); return; }
    let body;
    try { body = await readBody(req, 1024); } catch (e) { json(res, 400, { error: 'bad_request' }); return; }
    if (p === '/link/approve' || p === '/link/deny') {
      const pr = pairs.get(String(body.pairId || ''));
      if (!pr || pr.status !== 'pending') { json(res, 404, { error: 'not_pending' }); return; }
      if (p === '/link/deny') { pr.status = 'denied'; log('Denied ' + pr.device + '.'); json(res, 200, { ok: true }); return; }
      pr.secret = crypto.randomBytes(32).toString('hex');
      pr.status = 'approved';
      data.devices.push({ id: crypto.randomBytes(6).toString('hex'), name: pr.device, secretHash: sha256(pr.secret), added: Date.now(), lastSeen: 0 });
      saveData(); log('Paired ' + pr.device + '.');
      json(res, 200, { ok: true });
      return;
    }
    if (p === '/link/forget') {
      const before = data.devices.length;
      data.devices = data.devices.filter(d => d.id !== String(body.id || ''));
      if (data.devices.length !== before) { saveData(); log('Removed a paired device.'); }
      json(res, 200, { ok: true });
      return;
    }
    data.spotify = null; saveData(); log('Logged out of Spotify.');
    json(res, 200, { ok: true });
    return;
  }

  serveStatic(p, req, res);
}

async function finishLogin(url, res, local) {
  const back = (msg) => { res.writeHead(302, { Location: '/link' + (msg ? '?msg=' + encodeURIComponent(msg) : '') }); res.end(); };
  if (!local || !login || url.searchParams.get('state') !== login.state || Date.now() - login.at > 10 * 60 * 1000) { back('That login link is old. Press Log in again.'); return; }
  if (url.searchParams.get('error')) { login = null; back('Spotify login was cancelled.'); return; }
  const code = url.searchParams.get('code') || '';
  const verifier = login.verifier; login = null;
  try {
    keepTokens(await spotifyToken({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }));
    await loadUserName();
    log('Logged in to Spotify' + (data.spotify.user ? ' as ' + data.spotify.user : '') + '.');
    back('');
  } catch (e) {
    log('Spotify login failed: ' + e.message);
    back('Spotify login failed: ' + e.message);
  }
}

function serveStatic(p, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  let rel;
  try { rel = decodeURIComponent(p); } catch (e) { res.writeHead(400); res.end(); return; }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(WEB_ROOT, '.' + rel);
  if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' }); res.end(err.code === 'ENOENT' ? 'Not found' : 'Error'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

/* ---------- the laptop page ---------- */
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Earthrise Link</title><style>
:root{--bg:#07080b;--card:#12141a;--line:rgba(255,255,255,.1);--fg:#f4f5f7;--dim:#9aa0ab;--acc:#7cc4ff;--ok:#5ee6a0;--bad:#ff7a7a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,Segoe UI,sans-serif}
main{max-width:640px;margin:0 auto;padding:40px 20px 60px}h1{font-size:28px;margin:0 0 4px}.lead{color:var(--dim);margin:0 0 28px}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:16px}
h2{font-size:15px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:0 0 12px}
.row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.grow{flex:1 1 auto}
button,a.btn{font:600 15px system-ui,Segoe UI,sans-serif;border:0;border-radius:10px;padding:10px 16px;cursor:pointer;background:#2a2e38;color:var(--fg);text-decoration:none}
button.primary,a.btn.primary{background:var(--acc);color:#04121f}button:focus-visible,a.btn:focus-visible{outline:3px solid var(--acc);outline-offset:2px}
.code{font:700 34px/1 ui-monospace,Consolas,monospace;letter-spacing:.12em;color:var(--acc)}.ok{color:var(--ok)}.small{color:var(--dim);font-size:14px}
.item{padding:12px 0;border-top:1px solid var(--line)}.item:first-child{border-top:0;padding-top:0}.msg{color:var(--bad);margin:0 0 16px}
</style></head><body><main>
<h1>Earthrise Link</h1><p class="lead">Keeps your Spotify login on this laptop so the TV app does not need its own. Leave this running while you use the TV.</p>
<p class="msg" id="msg" hidden></p>
<section><h2>Spotify</h2><div class="row" id="sp"></div></section>
<section><h2>TVs asking to connect</h2><div id="pending"></div></section>
<section><h2>Paired TVs</h2><div id="devices"></div></section>
<p class="small" id="addr"></p>
</main><script>
var $=function(i){return document.getElementById(i)};
var m=new URLSearchParams(location.search).get('msg');if(m){$('msg').textContent=m;$('msg').hidden=false;history.replaceState(null,'','/link')}
function post(path,body){return fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Earthrise':'1'},body:JSON.stringify(body||{})}).then(load)}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function btn(text,cls,fn){var b=el('button',cls,text);b.type='button';b.onclick=fn;return b}
function ago(t){if(!t)return 'not used yet';var s=Math.round((Date.now()-t)/60000);return s<1?'used just now':s<60?'used '+s+' min ago':'used '+new Date(t).toLocaleString([],{dateStyle:'medium',timeStyle:'short'})}
function load(){return fetch('/link/state',{cache:'no-store'}).then(function(r){return r.json()}).then(function(s){
var sp=$('sp');sp.innerHTML='';
if(s.spotify){sp.appendChild(el('span','grow ok','Logged in'+(s.spotify.user?' as '+s.spotify.user:'')+'.'));sp.appendChild(btn('Log out','',function(){post('/link/logout')}))}
else{sp.appendChild(el('span','grow','Not logged in yet.'));var a=el('a','btn primary','Log in with Spotify');a.href='/link/login';sp.appendChild(a)}
var pe=$('pending');pe.innerHTML='';
if(!s.pending.length)pe.appendChild(el('p','small','None right now. On the TV, open Earthrise and choose Connect to laptop.'));
s.pending.forEach(function(p){var it=el('div','item row');var t=el('div','grow');t.appendChild(el('div','',p.device+' wants to connect'));t.appendChild(el('div','small','Check the TV shows this code'));it.appendChild(t);it.appendChild(el('div','code',p.code));
it.appendChild(btn('Allow','primary',function(){post('/link/approve',{pairId:p.pairId})}));it.appendChild(btn('Deny','',function(){post('/link/deny',{pairId:p.pairId})}));pe.appendChild(it)});
var de=$('devices');de.innerHTML='';
if(!s.devices.length)de.appendChild(el('p','small','No TVs paired yet.'));
s.devices.forEach(function(d){var it=el('div','item row');var t=el('div','grow');t.appendChild(el('div','',d.name));t.appendChild(el('div','small',ago(d.lastSeen)));it.appendChild(t);
it.appendChild(btn('Remove','',function(){post('/link/forget',{id:d.id})}));de.appendChild(it)});
$('addr').textContent='This laptop: '+s.name+(s.addresses.length?' at '+s.addresses.map(function(a){return a+':'+s.port}).join(', '):'')+'. The TV finds it by itself on the same Wi-Fi; type this address on the TV only if it does not.';
}).catch(function(){$('msg').textContent='Earthrise Link stopped. Start it again with start.cmd.';$('msg').hidden=false})}
load();setInterval(load,2000);
</script></body></html>`;

/* ---------- start ---------- */
function start() {
  try { clientId = clientIdFromEnv(fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8')); } catch (e) { clientId = ''; }
  clientId = process.env.SPOTIFY_CLIENT_ID || clientId;
  if (!clientId) log('No SPOTIFY_CLIENT_ID found in .env, so logging in will not work until it is filled.');
  data = loadData();

  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => { log('Request failed: ' + e.message); if (!res.headersSent) json(res, 500, { error: 'server_error' }); else res.end(); });
  });
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') log('Port ' + PORT + ' is already in use. Close the other Earthrise window (or the preview server) and start again.');
    else log('Server error: ' + e.message);
    process.exit(1);
  });
  server.listen(PORT, '0.0.0.0', () => {
    log('Earthrise Link is running. Laptop page: http://127.0.0.1:' + PORT + '/link');
    lanAddresses().forEach(a => log('TVs on your Wi-Fi can reach it at http://' + a + ':' + PORT));
    log(data.spotify && data.spotify.refresh ? 'Spotify login found' + (data.spotify.user ? ' (' + data.spotify.user + ')' : '') + '.' : 'Not logged in to Spotify yet: open the laptop page and press Log in.');
  });

  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('message', (msg, rinfo) => {
    if (msg.toString('utf8').trim() !== 'EARTHRISE_DISCOVER') return;
    const reply = Buffer.from(JSON.stringify({ app: 'earthrise-link', v: 1, port: PORT, name: LAPTOP_NAME }));
    udp.send(reply, rinfo.port, rinfo.address, err => { if (err) log('Discovery reply failed: ' + err.message); });
  });
  udp.on('error', e => { log('TV discovery is off (' + e.message + '). Type the laptop address on the TV instead.'); try { udp.close(); } catch (x) { /* already closed */ } });
  udp.bind(DISCOVERY_PORT);
}

if (require.main === module) start();
module.exports = { hostAllowed, isLoopback, clientIdFromEnv, sha256, lanAddresses };
