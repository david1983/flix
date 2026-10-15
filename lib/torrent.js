// Search: torrent-search-api providers (chain, magnet-first) + legacy 1337x chrome fallback.
// Download: transmission JSON-RPC (TRANSMISSION_RPC_URL env).
// Npm dep: torrent-search-api (search).
'use strict';

const http = require('http');
const chrome = require('./chrome');

const SEARCH_URL = 'https://1337x.to/srch?search=';
const RPC_URL = process.env.TRANSMISSION_RPC_URL || 'http://127.0.0.1:9091/transmission/rpc';
const SEARCH_CACHE_MS = 15 * 60 * 1000;
const cache = {}; // query -> { at, results }

// The Chrome worker page is a single shared tab. Serialize every op that uses it,
// and drop it on failure so a dead/crashed tab self-heals on the next call.
let chromeQueue = null;
const log = (...a) => console.log('[torrent]', ...a);
const logErr = (...a) => console.error('[torrent]', ...a);
function withChrome(fn) {
  const prev = chromeQueue || Promise.resolve();
  const run = prev.then(fn).catch((e) => { chrome.dropWorker(); throw e; });
  chromeQueue = run.catch(() => {});
  return run;
}

// ---------- torrent search via torrent-search-api (npm) ----------
// Providers tried in order; first batch with enough magnet results wins. Legacy
// 1337x-over-Chrome crawl (chrome.js) kept as last-resort fallback.
let tsa = null;
function tsaInit() {
  if (tsa) return tsa;
  tsa = require('torrent-search-api');
  tsa.disableAllProviders();
  return tsa;
}
const TSA_PROVIDERS = ['ThePirateBay', 'Limetorrents', 'TorrentProject', 'Eztv', 'KickassTorrents', '1337x'];

function mapResults(raw, provider) {
  return (raw || []).filter((r) => r && r.title).map((r) => ({
    name: r.title,
    seeders: Number(r.seeds != null ? r.seeds : r.seeders) || 0,
    size: String(r.size || ''),
    magnet: (r.magnet && /^magnet:/.test(String(r.magnet))) ? String(r.magnet) : null,
    url: r.desc || '',
    provider,
  }));
}

async function searchProviders(q) {
  const api = tsaInit();
  const out = [];
  for (const p of TSA_PROVIDERS) {
    try {
      api.disableAllProviders();
      api.enableProvider(p);
      let rows = mapResults(await api.search(q, 'All', 25), p);
      if (rows.length && !rows.some((r) => r.magnet)) {
        // provider returned no magnets — fetch up to 8 from its detail pages
        for (const r of rows.slice(0, 8)) {
          try { const mg = await api.getMagnet(r); if (mg && /^magnet:/.test(mg)) r.magnet = mg; } catch {}
        }
      }
      log('provider', p, '→', rows.length, 'rows,', rows.filter((r) => r.magnet).length, 'magnets');
      out.push(...rows);
      if (out.filter((r) => r.magnet).length >= 10) break;
    } catch (e) {
      console.error('[torrent] provider', p, 'failed:', e.message.slice(0, 70));
    }
  }
  api.disableAllProviders();
  out.sort((a, b) => b.seeders - a.seeders);
  return out.slice(0, 30);
}

async function legacyParseRows(raw) {
  let out = [];
  try { out = JSON.parse(raw); } catch { return []; }
  return out
    .filter((r) => r && r.url)
    .map((r) => ({
      name: r.name || '',
      size: r.size || '',
      seeders: r.seeds || '',
      url: r.url,
    }))
    .slice(0, 30);
}

async function search1337x(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const key = q.toLowerCase();
  const hit = cache[key];
  if (hit && Date.now() - hit.at < SEARCH_CACHE_MS) return hit.results;
  log('search:', q);
  let results = await searchProviders(q).catch(() => []);
  if (!results.length) {
    log('providers empty — legacy 1337x chrome crawl');
    results = await legacy1337x(q);
  }
  cache[key] = { at: Date.now(), results };
  return results;
}

async function legacy1337x(query) {
  return withChrome(async () => {
    const sess = await chrome.getPage();
    await chrome.navigate(sess, SEARCH_URL + encodeURIComponent(query) + '&field=seeders&order=desc');
    const ok = await chrome.passChallenge(sess);
    log('search challenge ok:', ok);
    if (!ok) throw new Error('challenge timeout');
    let results = [];
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const raw = await sess.ev(`
      (() => {
        const out = [];
        const trs = document.querySelectorAll('table.table-list tbody tr');
        for (const tr of trs) {
          const a = tr.querySelector('a[href*="/torrent/"]');
          if (!a) continue;
          const c = [...tr.querySelectorAll('td')];
          const name = (a.innerText || '').trim().replace(/\\s+/g, ' ');
          const seeds = c[1] ? (c[1].innerText || '').trim() : '';
          const size = c[4] ? (c[4].innerText || '').trim().split(/\\s+/)[0] : '';
          out.push({ name, url: a.href, seeds, size });
        }
        return JSON.stringify(out);
      })()`);
      results = legacyParseRows(raw);
      if (results.length) break;
    }
    if (!results.length) throw new Error('no results parsed');
  log('legacy search results:', results.length);
  return results;
  });
}

async function getMagnet(url) {
  log('getMagnet:', url);
  return withChrome(async () => {
    const sess = await chrome.getPage();
    await chrome.navigate(sess, url);
    const ok = await chrome.passChallenge(sess);
    log('magnet page challenge ok:', ok);
    if (!ok) throw new Error('challenge timeout');
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const raw = await sess.ev(`
      (() => {
        const a = document.querySelector('a[href*="magnet"]');
        return a ? a.getAttribute('href') : '';
      })()`);
      if (i % 5 === 0) log(`getMagnet attempt ${i}:`, raw ? `found (${String(raw).slice(0, 40)}…)` : 'nothing yet');
      if (raw && raw.startsWith('magnet:')) return raw;
    }
    logErr('getMagnet: magnet not found after retries');
    throw new Error('magnet not found');
  });
}

// ---------- transmission JSON-RPC ----------
let session = '';
// Transmission requires Basic auth (rpc-username + rpc-password) when a password is set.
const txAuth = process.env.TRANSMISSION_PASSWORD
  ? 'Basic ' + Buffer.from((process.env.TRANSMISSION_USER || 'transmission') + ':' + process.env.TRANSMISSION_PASSWORD).toString('base64')
  : '';
function rpc(method, args = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ method, arguments: args, filename: '...', version: '16' });
    const req = http.request(RPC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-json-rpc',
        'Content-Length': Buffer.byteLength(body),
        ...(txAuth ? { Authorization: txAuth } : {}),
        ...(session ? { 'X-Transmission-Session-Id': session } : {}),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        const sid = res.headers['x-transmission-session-id'];
        if (sid) session = String(sid);
        let j = null;
        try { j = JSON.parse(d); } catch {}
        if (!j) resolve({ error: new Error('bad rpc response'), result: {} });
        else if (j.result !== 'success') { logErr(`${method} → ${res.statusCode} ${String(j.result).slice(0, 100)}`); resolve({ error: new Error(String(j.result || 'rpc failure')), result: j.arguments || {} }); }
        else resolve({ result: j.arguments || {}, error: null });
      });
    });
    req.on('error', (e) => { logErr(`${method} transport error:`, e.message); resolve({ error: e, result: {} }); });
    req.write(body);
    req.end();
  });
}

async function daemonUp() {
  for (let i = 0; i < 20; i++) {
    const out = await rpc('session-get');
    if (!out.error && out.result && out.result.version) return true;
    await new Promise((r) => setTimeout(r, 750));
  }
  return false;
}

async function startDownload(magnet, destDir) {
  if (!await daemonUp()) throw new Error('transmission-daemon not reachable on 127.0.0.1:9091');
  log('torrent-add →', destDir);
  const out = await rpc('torrent-add', { filename: magnet, 'download-dir': destDir });
  if (out.error) { logErr('torrent-add failed:', out.error.message); throw out.error; }
  const id = (out.result['torrent-added'] || out.result['torrent-duplicate'] || {}).id || null;
  if (!id) { logErr('torrent-add: no id in response'); throw new Error('add failed'); }
  log('torrent-add ok, id', id);
  return id;
}

async function listTorrents() {
  // NOTE: Transmission 4.0.5 silently returns [] for ids:'all' (string) — omit ids instead.
  const out = await rpc('torrent-get', { 'fields': ['id', 'name', 'status', 'percentDone', 'rateDownload', 'rateUpload', 'sizeWhenDone', 'uploadedEverBytes', 'downloadedEverBytes', 'addedDate', 'error', 'errorString'] });
  if (out.error) return [];
  // Hide only finished-and-stopped torrents; show active, errored, queued and seeding.
  return ((out.result && out.result.torrents) || []).filter((t) => t.status !== 0 || t.percentDone >= 1 || t.error !== 0).map((t) => ({
    id: t.id,
    name: t.name,
    status: t.status, // 0 stopped 1/2 verifying 3 dl-wait 4 downloading 5 seed-wait 6 seeding
    error: t.error || 0,
    errorString: t.errorString || '',
    progress: Math.round((t.percentDone || 0) * 100) / 100,
    down: t.rateDownload || 0,
    up: t.rateUpload || 0,
    size: t.sizeWhenDone || 0,
    added: t.addedDate || 0,
  }));
}

async function removeTorrent(id) {
  const out = await rpc('torrent-remove', { id, 'remove-data': false });
  return !out.error;
}

module.exports = { search1337x, getMagnet, startDownload, listTorrents, removeTorrent, daemonUp };
