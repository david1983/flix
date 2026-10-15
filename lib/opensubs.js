// OpenSubtitles REST API client (https://api.opensubtitles.com/api/v1).
// Search needs OS_API_KEY (free: opensubtitles.org → API). Downloading a file
// additionally needs OS_LOGIN/OS_PASSWORD (Bearer token from /login).
'use strict';

const https = require('https');
const fs = require('fs');

const BASE = 'https://api.opensubtitles.com/api/v1';
const log = (...a) => console.log('[opensubs]', ...a);

const key = () => process.env.OS_API_KEY || '';
let token = '';
let tokenAt = 0;

function req(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const rq = https.request(url, {
      method,
      headers: { 'User-Agent': 'flix 1.0', Accept: 'application/json', 'Api-Key': key(), ...headers },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let j = null;
        try { j = d ? JSON.parse(d) : {}; } catch { j = {}; }
        if (res.statusCode >= 400) {
          const e = new Error(`HTTP ${res.statusCode}: ${(j && (j.error || j.message)) || String(d).slice(0, 120)}`);
          e.status = res.statusCode;
          return reject(e);
        }
        resolve(j || {});
      });
    });
    rq.on('error', reject);
    if (body) rq.write(typeof body === 'string' ? body : JSON.stringify(body));
    rq.end();
  });
}

// GET with redirects (subtitle file storage links are 302s).
function getRedirect(url, out, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 4) return reject(new Error('too many redirects'));
    const rq = https.get(url, { headers: { 'User-Agent': 'flix 1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return getRedirect(new URL(res.headers.location, url).href, out, depth + 1).then(resolve, reject);
      }
      if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} fetching file`));
      const f = fs.createWriteStream(out);
      res.pipe(f);
      f.on('finish', () => f.close(resolve));
    });
    rq.on('error', reject);
  });
}

function enabled() { return !!key(); }

async function ensureToken() {
  if (token && Date.now() - tokenAt < 6 * 3600 * 1000) return token;
  const user = process.env.OS_LOGIN, pass = process.env.OS_PASSWORD;
  if (!user || !pass) return '';
  const j = await req('POST', `${BASE}/login`, { 'Content-Type': 'application/json' }, { username: user, password: pass });
  token = j.token || '';
  tokenAt = Date.now();
  if (token) log('logged in');
  return token;
}

async function search(q, lang = 'en', type = '') {
  const p = new URLSearchParams({ languages: lang });
  if (/^tt\d+$/i.test(q)) p.set('imdb_id', q.replace(/^tt/i, ''));
  else p.set('query', q);
  if (type === 'movie' || type === 'episode') p.set('type', type);
  const j = await req('GET', `${BASE}/subtitles?${p}`);
  return (j.data || []).map((x) => {
    const a = x.attributes || {};
    const f = a.feature_details || {};
    const files = a.files || [];
    return {
      subtitleId: String(a.subtitle_id),
      fileId: files[0] && files[0].file_id != null ? String(files[0].file_id) : null,
      language: a.language || lang,
      release: a.release || f.movie_name || '',
      title: f.title || '',
      year: f.year || null,
      downloads: a.download_count || 0,
      rating: a.ratings || 0,
      hd: !!a.hd,
      hi: !!a.hearing_impaired,
      trusted: !!a.from_trusted,
      ai: !!a.ai_translated || !!a.machine_translated,
      fileName: (files[0] && files[0].file_name) || '',
    };
  });
}

// POST /subtitles/{id}/download → { link } → fetch link to a file.
async function downloadFile(subtitleId, fileId, out) {
  await ensureToken(); // downloads need a Bearer token (OS_LOGIN/OS_PASSWORD)
  const h = token ? { Authorization: `Bearer ${token}` } : {};
  const j = await req('POST', `${BASE}/subtitles/${subtitleId}/download`,
    { 'Content-Type': 'application/json', ...h }, fileId ? { file_id: fileId } : {});
  if (!j.link) throw new Error('no download link (check OS_LOGIN/OS_PASSWORD in .env?)');
  await getRedirect(j.link, out);
  log(`saved ${out}`);
  return out;
}

module.exports = { enabled, ensureToken, search, downloadFile };