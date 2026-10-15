#!/usr/bin/env node
// Flix — a small self-hosted Netflix/Plex-style server for a folder of video files.
// Npm dep: torrent-search-api (torrent search). Needs ffmpeg/ffprobe on PATH.
'use strict';

// Minimal .env loader (zero deps). Keys not already in the real environment win.
(() => {
  try {
    for (const line of require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
    }
  } catch {}
})();

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { parseName } = require('./lib/parse');
const imdb = require('./lib/imdb');
const torrent = require('./lib/torrent');
const opensubs = require('./lib/opensubs');

const MEDIA_DIR = process.env.MEDIA_DIR || '/mnt/nfs/movies';
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const IMDB = process.env.IMDB !== '0'; // set IMDB=0 to disable metadata lookups
const META_MAX_AGE = 14 * 24 * 3600 * 1000; // refresh ratings every two weeks
const RESCAN_MINUTES = Number(process.env.RESCAN_MINUTES || 15);

const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|mov|webm|wmv|mpg|mpeg|ts|m2ts|flv)$/i;
const TEXT_SUBS = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
const QUALITY = { 1080: { w: 1920, br: 8 }, 720: { w: 1280, br: 4 }, 480: { w: 854, br: 2 } };
const EXT_SUB_RE = /\.(srt|vtt)$/i;

const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
const IMG_DIR = path.join(DATA_DIR, 'img');
for (const d of [DATA_DIR, THUMB_DIR, IMG_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------- persistent JSON stores ----------
function loadJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); } catch { return fallback; }
}
const saveTimers = {};
function saveJSON(name, obj) {
  clearTimeout(saveTimers[name]);
  saveTimers[name] = setTimeout(() => {
    const tmp = path.join(DATA_DIR, name + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
    fs.renameSync(tmp, path.join(DATA_DIR, name));
  }, 300);
}

const probeCache = loadJSON('probe.json', {});     // file -> { sig, probe }
const state = loadJSON('state.json', {});          // file -> { pos, dur, watched, updated }
const overrides = loadJSON('overrides.json', null) || require('./lib/default-overrides.json');
const metaCache = loadJSON('imdb.json', {});       // lookup key -> { meta | null, at }
const discoverCache = loadJSON('discover.json', { mlt: {}, charts: {} }); // raw IMDb recommendation data
const lists = loadJSON('lists.json', { watchlist: [], dismissed: [] });  // user's watchlist + "not interested"
saveJSON('overrides.json', overrides);

// ---------- library ----------
let library = { items: [], byId: new Map(), scannedAt: 0 };
let scanning = false;
const idOf = (rel) => crypto.createHash('sha1').update(rel).digest('hex').slice(0, 12);

async function walk(dir, base = dir, out = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { console.error('readdir', dir, e.message); return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, base, out);
    else if (VIDEO_EXT.test(e.name)) out.push(path.relative(base, full));
  }
  return out;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 120000, killSignal: 'SIGKILL', encoding: opts.encoding || 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve(stdout);
    });
  });
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const it = items[i++]; try { await fn(it); } catch (e) { console.error(e.message); } }
  }));
}

function summarizeProbe(p) {
  const streams = p.streams || [];
  const vids = streams.filter((s) => s.codec_type === 'video');
  const main = vids.find((s) => !(s.disposition && s.disposition.attached_pic)) || null;
  const pic = vids.find((s) => s.disposition && s.disposition.attached_pic) || null;
  const tags = (s) => s.tags || {};
  return {
    duration: Number(p.format && p.format.duration) || Number(main && main.duration) || 0,
    container: (p.format && p.format.format_name) || '',
    bitrate: Number(p.format && p.format.bit_rate) || 0,
    video: main && {
      index: main.index, codec: main.codec_name, width: main.width, height: main.height, pix: main.pix_fmt,
      hdr: ['smpte2084', 'arib-std-b67'].includes(main.color_transfer),
      tenbit: /10|12/.test(main.pix_fmt || ''),
    },
    posterStream: pic ? pic.index : null,
    audio: streams.filter((s) => s.codec_type === 'audio').map((s, i) => ({
      n: i, index: s.index, codec: s.codec_name, channels: s.channels,
      lang: tags(s).language || '', title: tags(s).title || '', default: !!(s.disposition && s.disposition.default),
    })),
    subs: streams.filter((s) => s.codec_type === 'subtitle').map((s) => ({
      index: s.index, codec: s.codec_name, lang: tags(s).language || '', title: tags(s).title || '',
      text: TEXT_SUBS.has(s.codec_name), forced: !!(s.disposition && s.disposition.forced),
    })),
  };
}

async function probe(rel) {
  const full = path.join(MEDIA_DIR, rel);
  const st = await fsp.stat(full);
  const sig = `${st.size}:${Math.floor(st.mtimeMs)}`;
  const c = probeCache[rel];
  if (c && c.sig === sig) return { st, info: c.info };
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', full], { timeout: 60000 });
  const info = summarizeProbe(JSON.parse(out));
  probeCache[rel] = { sig, info };
  saveJSON('probe.json', probeCache);
  return { st, info };
}

function buildItem(rel, st, info) {
  const parsed = parseName(path.basename(rel));
  const ov = overrides[rel] || overrides[path.basename(rel)] || {};
  const it = { id: idOf(rel), file: rel, ...parsed, ...ov, size: st.size, added: Math.floor(st.mtimeMs), ...info };
  if (it.kind === 'episode') it.showKey = (it.show || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  it.thumb = fs.existsSync(path.join(THUMB_DIR, it.id + '.jpg'));
  it.poster = fs.existsSync(path.join(THUMB_DIR, it.id + '.poster.jpg'));
  const extSubs = findSidecarSubs(rel);
  if (extSubs.length) it.subs = (it.subs || []).concat(extSubs);
  it.shots = [1, 2, 3, 4].filter((n) => fs.existsSync(path.join(THUMB_DIR, it.id + (n > 1 ? '.' + n : '') + '.jpg'))).length;
  return it;
}

// Sidecar subtitle files next to a video: "Movie.2021.mkv" → "Movie.2021.srt",
// "Movie.2021.eng.srt", "Show S01E02.srt" etc. Indexes 9000+ never collide with container streams.
function findSidecarSubs(rel) {
  const dir = path.join(MEDIA_DIR, path.dirname(rel));
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const base = path.basename(rel).replace(VIDEO_EXT, '').toLowerCase();
  const out = [];
  for (const n of names) {
    if (!EXT_SUB_RE.test(n)) continue;
    const stem = n.replace(EXT_SUB_RE, '');
    if (!stem.toLowerCase().startsWith(base)) continue;
    const rem = stem.slice(base.length).replace(/^[.\-_\s]+/, '');
    out.push({
      index: 9000 + out.length, codec: n.toLowerCase().split('.').pop(),
      lang: (rem.split(/[.\-_\s]/)[0] || '').slice(0, 10),
      title: rem ? `External: ${rem}` : 'External',
      text: true, forced: /forced/i.test(rem),
      ext: path.posix.join(path.dirname(rel), n),
    });
  }
  return out;
}

async function scan() {
  if (scanning) return;
  scanning = true;
  const t0 = Date.now();
  try {
    const files = await walk(MEDIA_DIR);
    const items = [];
    await pool(files, 4, async (rel) => {
      const { st, info } = await probe(rel);
      items.push(buildItem(rel, st, info));
    });
    setLibrary(items);
    console.log(`scan: ${items.length} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await makeThumbs();
    if (IMDB) { await enrichIMDb(); refreshDiscover().catch((e) => console.error('discover:', e.message)); }
  } catch (e) { console.error('scan failed', e); }
  finally { scanning = false; }
}

function setLibrary(items) {
  items.sort((a, b) => a.file.localeCompare(b.file));
  items.forEach(applyMeta);
  library = { items, byId: new Map(items.map((i) => [i.id, i])), scannedAt: Date.now() };
}

function rebuildItem(it) {
  const c = probeCache[it.file];
  const fresh = buildItem(it.file, { size: it.size, mtimeMs: it.added }, c ? c.info : {});
  Object.assign(it, fresh);
  for (const k of Object.keys(it)) if (!(k in fresh)) delete it[k];
  applyMeta(it);
}

// ---------- thumbnails ----------
// Each title gets SHOT_COUNT screenshots: base `id.jpg` (also used as og/poster fallback)
// plus `id.N.jpg` stills at spread seek points. Cards + hero cycle through them so the
// same artwork doesn't repeat.
const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
const SHOT_COUNT = 4;
const SHOT_FRAC = { 1: { ep: 0.3, m: 0.2 }, 2: 0.5, 3: 0.7, 4: 0.88 };

async function grabFrame(full, at, mapIndex, vf, out) {
  // Damaged files can make ffmpeg exit 0 without writing a frame, so fall back to earlier seek points.
  for (const t of [at, at / 3, 60, 30, 1].map((t) => Math.max(1, Math.round(t)))) {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(t), '-i', full,
      '-map', `0:${mapIndex}`, '-frames:v', '1', '-vf', vf, '-q:v', '4', '-y', out], { timeout: 120000 }).catch(() => {});
    if (fs.existsSync(out)) return true;
  }
  return false;
}

async function makeThumbs() {
  const todo = library.items.filter((i) => i.video && (i.thumb || (i.shots || 0) < SHOT_COUNT) && (i.shots || 0) < SHOT_COUNT);
  await pool(todo, 2, async (it) => {
    const full = path.join(MEDIA_DIR, it.file);
    const dur = it.duration || 0;
    let vf = 'scale=1280:-2';
    if (it.video.hdr) vf = 'scale=1280:-2,' + TONEMAP;
    for (let n = 1; n <= SHOT_COUNT; n++) {
      const out = path.join(THUMB_DIR, it.id + (n > 1 ? '.' + n : '') + '.jpg');
      if (fs.existsSync(out)) continue;
      const frac = typeof SHOT_FRAC[n] === 'number' ? SHOT_FRAC[n] : (it.kind === 'episode' ? SHOT_FRAC[1].ep : SHOT_FRAC[1].m);
      const at = Math.max(1, Math.min(dur * frac, dur - 1 || 1));
      const ok = await grabFrame(full, at, it.video.index, vf, out);
      if (!ok && n === 1) throw new Error(`thumb failed: ${it.file}`);
      if (!ok) console.warn(`shot ${it.id}.${n} failed: ${it.file}`);
    }
    it.shots = SHOT_COUNT;
    it.thumb = true;
    if (it.posterStream != null) {
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', full, '-map', `0:${it.posterStream}`, '-frames:v', '1',
        '-vf', 'scale=500:-2', '-y', path.join(THUMB_DIR, it.id + '.poster.jpg')], { timeout: 30000 }).then(() => { it.poster = true; }, () => {});
    }
  });
}

// ---------- IMDb metadata ----------
function metaKey(it) {
  if (it.kind === 'movie') return it.imdb ? `id:${it.imdb}` : `movie:${it.title}:${it.year || ''}`;
  if (it.kind === 'episode') return it.imdb ? `tvid:${it.imdb}` : `tv:${it.showKey}`;
  return null;
}
async function imdbPoster(meta) {
  if (!meta || !meta.imageUrl) return;
  const name = `imdb_${meta.imdbId}.jpg`;
  const dest = path.join(IMG_DIR, name);
  if (!fs.existsSync(dest)) {
    const r = await fetch(imdb.sizedImage(meta.imageUrl, 400));
    if (!r.ok) return;
    await fsp.writeFile(dest, Buffer.from(await r.arrayBuffer()));
  }
  meta.posterUrl = '/img/' + name;
}
let enriching = false;
async function enrichIMDb() {
  if (enriching) return;
  enriching = true;
  try {
    const jobs = new Map();
    for (const it of library.items) {
      const k = metaKey(it);
      if (!k) continue;
      if (!jobs.has(k)) jobs.set(k, { it, seasons: new Set() });
      if (it.kind === 'episode') jobs.get(k).seasons.add(it.season);
    }
    const stale = [...jobs].filter(([k, j]) => {
      const c = metaCache[k];
      if (!c || Date.now() - c.at > META_MAX_AGE) return true;
      // a new season showed up on disk → fetch its episode info
      return c.meta && j.it.kind === 'episode' && [...j.seasons].some((n) => !(c.meta.seasons || []).includes(n));
    });
    let n = 0;
    await pool(stale, 2, async ([k, { it, seasons }]) => {
      const tv = it.kind === 'episode';
      let meta = null;
      try {
        const id = it.imdb || await imdb.search(tv ? it.show : it.title, tv ? null : it.year, tv ? 'tv' : 'movie');
        if (id) meta = await imdb.details(id, tv ? [...seasons].sort((a, b) => a - b) : null);
        if (meta && tv) meta.seasons = [...seasons];
        await imdbPoster(meta);
      } catch (e) {
        console.error(`IMDb lookup failed for "${tv ? it.show : it.title}": ${e.message}`);
        if (metaCache[k]) return; // keep the old data on transient errors
      }
      metaCache[k] = { meta, at: Date.now() };
      n++;
      saveJSON('imdb.json', metaCache);
    });
    if (stale.length) console.log(`IMDb: updated ${n} of ${stale.length} titles`);
    library.items.forEach(applyMeta);
  } finally { enriching = false; }
}
function applyMeta(it) {
  const k = metaKey(it);
  const m = (k && metaCache[k] && metaCache[k].meta) || null;
  if (it.kind === 'episode' && m) {
    const { episodes, ...series } = m;
    it.meta = series;
    it.ep = (episodes && episodes[`${it.season}x${it.episode}`]) || null;
  } else {
    it.meta = m;
    delete it.ep;
  }
}

// ---------- LOLOFLIX (kids) ----------
// Kid-friendly = IMDb genre Family or Animation, and rated no higher than PG / TV-PG. A per-file override wins.
const ADULT_CERT = /^(PG-13|R|NC-17|X|TV-14|TV-MA|M|MA|MA15\+|R18\+|1[2-8]\+?|VM1[48]|T)$/i;
function isKids(it) {
  if (typeof it.kids === 'boolean') return it.kids;
  const m = it.meta;
  if (!m || !(m.genres || []).some((g) => g === 'Family' || g === 'Animation')) return false;
  return !(m.certificate && ADULT_CERT.test(m.certificate));
}
const kidFriendlyRec = (x) => (x.genres || []).includes('Family') && !(x.genres || []).some((g) => ['Horror', 'Crime', 'Thriller', 'War'].includes(g));

// ---------- discover: recommendations for titles you don't own ----------
const DISCOVER_MAX_AGE = 7 * 24 * 3600 * 1000;
const CHARTS = { popularMovies: 'MOST_POPULAR_MOVIES', popularSeries: 'MOST_POPULAR_TV_SHOWS', topMovies: 'TOP_RATED_MOVIES', topSeries: 'TOP_RATED_TV_SHOWS' };
let discoverJob = null;

// One seed per IMDb title in the library (movies, and series rather than episodes)
function seeds(filter = () => true) {
  const map = new Map();
  for (const it of library.items) {
    if (!filter(it)) continue;
    if (!it.meta || !it.meta.imdbId || (it.kind !== 'movie' && it.kind !== 'episode')) continue;
    const id = it.meta.imdbId;
    let sd = map.get(id);
    if (!sd) map.set(id, (sd = { id, name: it.meta.name, rating: it.meta.rating || 0, watched: 0, started: 0, last: 0, files: 0 }));
    const st = state[it.file] || {};
    sd.files++;
    if (st.watched) sd.watched++;
    if (st.pos > 60 || st.watched) sd.started++;
    sd.last = Math.max(sd.last, st.updated || 0);
  }
  return [...map.values()];
}

function refreshDiscover() {
  if (discoverJob) return discoverJob;
  discoverJob = (async () => {
    const ids = seeds().map((s) => s.id).filter((id) => !discoverCache.mlt[id] || Date.now() - discoverCache.mlt[id].at > DISCOVER_MAX_AGE);
    if (ids.length) {
      const res = await imdb.moreLikeThis(ids, 20);
      for (const [id, list] of Object.entries(res)) discoverCache.mlt[id] = { at: Date.now(), list };
    }
    for (const [key, type] of Object.entries(CHARTS)) {
      const c = discoverCache.charts[key];
      if (c && Date.now() - c.at < DISCOVER_MAX_AGE / 7) continue; // charts change daily
      discoverCache.charts[key] = { at: Date.now(), list: await imdb.chart(type, key.startsWith('top') ? 250 : 100) };
    }
    saveJSON('discover.json', discoverCache);
    if (ids.length) console.log(`discover: fetched recommendations for ${ids.length} titles`);
  })().finally(() => { discoverJob = null; });
  return discoverJob;
}

function buildDiscover(kidsOnly = false) {
  const owned = new Set(library.items.map((i) => i.meta && i.meta.imdbId).filter(Boolean));
  const dismissed = new Set(lists.dismissed);
  const listed = new Set(lists.watchlist.map((w) => w.imdbId));
  const fresh = (x) => x.kind !== 'other' && !owned.has(x.imdbId) && !dismissed.has(x.imdbId) && (!kidsOnly || kidFriendlyRec(x));
  const decorate = (x) => ({ ...x, inList: listed.has(x.imdbId) });

  // Score: titles you watched count most, started next, merely owned least; highly rated seeds count a bit more.
  const scored = new Map();
  const sd = seeds(kidsOnly ? isKids : undefined);
  for (const seed of sd) {
    const rec = discoverCache.mlt[seed.id];
    if (!rec) continue;
    const engaged = seed.watched / seed.files;
    let w = 1 + 2 * engaged + (seed.started ? 1 : 0) + (seed.rating >= 7.5 ? 0.5 : 0);
    if (seed.last && Date.now() - seed.last < 30 * 864e5) w += 1; // watched recently
    rec.list.forEach((x, rank) => {
      if (!fresh(x) || (x.votes || 0) < 3000) return;
      let e = scored.get(x.imdbId);
      if (!e) scored.set(x.imdbId, (e = { ...x, score: 0, because: [] }));
      const contrib = w * (1 - rank / 25);
      e.score += contrib;
      e.because.push({ name: seed.name, c: contrib });
    });
  }
  const ranked = [...scored.values()].map((e) => {
    e.score *= Math.pow((e.rating || 6) / 7, 2) * (1 + Math.log10(Math.max(1, e.votes || 1)) / 12);
    e.because = e.because.sort((a, b) => b.c - a.c).slice(0, 3).map((b) => b.name);
    return e;
  }).sort((a, b) => b.score - a.score);

  const chart = (k) => ((discoverCache.charts[k] && discoverCache.charts[k].list) || []).filter(fresh).map(decorate);

  // "Because you watched X" rows for the most recently watched/started titles
  const recent = sd.filter((x) => x.last && discoverCache.mlt[x.id]).sort((a, b) => b.last - a.last).slice(0, 4);
  const because = recent.map((seed) => ({
    seed: seed.name,
    items: discoverCache.mlt[seed.id].list.filter((x) => fresh(x) && (x.votes || 0) >= 1000).map(decorate),
  })).filter((r) => r.items.length >= 3);

  if (kidsOnly) {
    return {
      kids: ranked.slice(0, 40).map(decorate),
      popular: [...chart('popularMovies'), ...chart('popularSeries')].slice(0, 30),
      top: [...chart('topMovies'), ...chart('topSeries')].slice(0, 30),
      because,
    };
  }
  return {
    ready: Object.keys(discoverCache.mlt).length > 0,
    kidsPicks: buildDiscover(true).kids.slice(0, 25),
    movies: ranked.filter((x) => x.kind === 'movie').slice(0, 40).map(decorate),
    series: ranked.filter((x) => x.kind === 'series').slice(0, 40).map(decorate),
    because,
    watchlist: lists.watchlist.slice().reverse().map((x) => ({ ...x, inList: true, owned: owned.has(x.imdbId) })),
    popularMovies: chart('popularMovies').slice(0, 40),
    popularSeries: chart('popularSeries').slice(0, 40),
    topMovies: chart('topMovies').slice(0, 60),
    topSeries: chart('topSeries').slice(0, 60),
  };
}

// ---------- playback decisions ----------
function plan(it, { audio = null, q = 'orig' } = {}) {
  const v = it.video;
  if (!v) return { mode: 'none' };
  const ext = path.extname(it.file).toLowerCase();
  const h264ok = v.codec === 'h264' && (v.pix === 'yuv420p' || v.pix === 'yuvj420p');
  const a0 = it.audio.find((a) => a.default) || it.audio[0];
  const wantAudio = audio == null ? (a0 ? a0.n : 0) : Number(audio);
  const defaultAudio = !it.audio.length || wantAudio === (it.audio[0] && it.audio[0].n);
  const audioOk = !it.audio.length || ['aac', 'mp3'].includes(it.audio[0].codec);
  if (q === 'orig' && h264ok && ['.mp4', '.m4v', '.mov'].includes(ext) && audioOk && defaultAudio && v.width <= 1920) return { mode: 'direct', audio: wantAudio };
  if (q === 'orig' && h264ok && v.width <= 1920) return { mode: 'remux', audio: wantAudio };
  return { mode: 'transcode', audio: wantAudio, q: q === 'orig' ? 1080 : Number(q) };
}

async function keyframeBefore(full, vindex, t) {
  if (t <= 0) return 0;
  try {
    const out = await run('ffprobe', ['-v', 'error', '-select_streams', String(vindex), '-skip_frame', 'nokey',
      '-show_entries', 'frame=best_effort_timestamp_time', '-read_intervals', `${t}%+#1`, '-of', 'csv=p=0', full], { timeout: 15000 });
    const k = parseFloat(out.trim().split('\n')[0]);
    return Number.isFinite(k) && k <= t + 0.5 ? Math.max(0, k) : t;
  } catch { return t; }
}

let encoder = 'h264_nvenc';
execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=d=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-'], (err) => {
  if (err) { encoder = 'libx264'; console.log('NVENC unavailable, using libx264'); } else console.log('using NVENC hardware encoding');
});

function ffArgs(it, { mode, start, audio, q }) {
  const full = path.join(MEDIA_DIR, it.file);
  const v = it.video;
  const a = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  const gpuDecode = mode === 'transcode' && encoder === 'h264_nvenc' && ['hevc', 'h264', 'av1', 'vp9'].includes(v.codec);
  const hdrGpu = gpuDecode && v.hdr;
  if (gpuDecode) a.push('-hwaccel', 'cuda');
  if (hdrGpu) a.push('-hwaccel_output_format', 'cuda');
  if (start > 0) a.push('-ss', start.toFixed(3));
  a.push('-i', full, '-map', `0:${v.index}`);
  const aud = it.audio.find((x) => x.n === audio) || it.audio[0];
  if (aud) a.push('-map', `0:${aud.index}`);
  if (mode === 'remux') {
    a.push('-c:v', 'copy');
  } else {
    const Q = QUALITY[q] || QUALITY[1080];
    const w = Math.min(Q.w, v.width || Q.w);
    let vf;
    if (hdrGpu) vf = `scale_cuda=${w}:-2,hwdownload,format=p010le,${TONEMAP}`;
    else if (v.hdr) vf = `scale=${w}:-2,${TONEMAP}`;
    else vf = `scale=${w}:-2,format=yuv420p`;
    a.push('-vf', vf);
    if (encoder === 'h264_nvenc') a.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23');
    else a.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22');
    a.push('-b:v', `${Q.br}M`, '-maxrate', `${Q.br * 1.5}M`, '-bufsize', `${Q.br * 2}M`, '-profile:v', 'high', '-g', '48');
  }
  if (aud) a.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
  a.push('-sn', '-dn', '-map_metadata', '-1', '-max_muxing_queue_size', '2048',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return a;
}

const activeStreams = new Map(); // client session id -> ffmpeg process

// ---------- subtitles ----------
// MKV interleaves subtitles with video, so extracting a track means reading the whole file.
// We answer immediately with a short window around the playhead, and meanwhile extract the
// full track once in the background (cached on disk) so later requests are instant.
const SUB_WIN = 120;
const SUB_DIR = path.join(DATA_DIR, 'subs');
fs.mkdirSync(SUB_DIR, { recursive: true });
const subCache = new Map();
const fullSubJobs = new Map();
const fullSubPath = (it, sIndex) => path.join(SUB_DIR, `${it.id}.${sIndex}.vtt`);

function extractFullSubs(it, sIndex) {
  const key = `${it.id}:${sIndex}`;
  if (fullSubJobs.has(key) || fs.existsSync(fullSubPath(it, sIndex))) return;
  const tmp = fullSubPath(it, sIndex) + '.tmp';
  const job = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path.join(MEDIA_DIR, it.file),
    '-map', `0:${sIndex}`, '-f', 'webvtt', '-y', tmp], { timeout: 30 * 60000 })
    .then(() => fsp.rename(tmp, fullSubPath(it, sIndex)))
    .catch((e) => { console.error(`subtitle extraction failed ${it.file}#${sIndex}: ${e.message}`); fsp.unlink(tmp).catch(() => {}); })
    .finally(() => fullSubJobs.delete(key));
  fullSubJobs.set(key, job);
}

async function subsWindow(it, sIndex, w) {
  const key = `${it.id}:${sIndex}:${w}`;
  if (subCache.has(key)) return subCache.get(key);
  const p = (async () => {
    const from = w * SUB_WIN;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-copyts'];
    if (from > 0) args.push('-ss', String(Math.max(0, from - 5)));
    args.push('-i', path.join(MEDIA_DIR, it.file), '-map', `0:${sIndex}`, '-to', String(from + SUB_WIN + 5), '-f', 'webvtt', 'pipe:1');
    return run('ffmpeg', args, { timeout: 120000 });
  })();
  subCache.set(key, p);
  p.catch(() => subCache.delete(key));
  if (subCache.size > 400) subCache.delete(subCache.keys().next().value);
  return p;
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska' };

function send(res, code, body, type = 'application/json') {
  if (type === 'application/json' && typeof body !== 'string') body = JSON.stringify(body);
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
async function readBody(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 1e6) throw new Error('body too large'); }
  return s ? JSON.parse(s) : {};
}
function serveFile(req, res, file, { cache = 'public, max-age=86400', type } = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'not found' });
    const ct = type || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    const m = range && /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : st.size - parseInt(m[2], 10);
      let end = m[1] && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (!m[1]) end = st.size - 1;
      end = Math.min(end, st.size - 1);
      if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { 'content-type': ct, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${st.size}`,
        'content-length': end - start + 1, 'cache-control': cache });
      fs.createReadStream(file, { start, end, highWaterMark: 1 << 20 }).pipe(res);
    } else {
      res.writeHead(200, { 'content-type': ct, 'accept-ranges': 'bytes', 'content-length': st.size, 'cache-control': cache });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file, { highWaterMark: 1 << 20 }).pipe(res);
    }
  });
}

function publicItem(it) {
  const s = state[it.file] || {};
  return { ...it, kidsSafe: isKids(it), progress: { pos: s.pos || 0, watched: !!s.watched, updated: s.updated || 0 } };
}

const routes = [];
const route = (method, re, fn) => routes.push({ method, re, fn });

// ---------- settings (server-side, shared by all clients) ----------
const settings = Object.assign({ brand: 'Flix', kidsBrand: 'KIDSFLIX', subLang: 'en' }, loadJSON('settings.json', {}));
route('GET', /^\/api\/settings$/, (req, res) => send(res, 200, settings));
route('POST', /^\/api\/settings$/, async (req, res) => {
  const b = await readBody(req);
  const word = (s, max) => String(s || '').trim().replace(/^[^A-Za-z0-9'’\- ]+/, '').replace(/[^A-Za-z0-9'’\- ]+$/, '').slice(0, max);
  if (b.brand) settings.brand = word(b.brand, 18) || settings.brand;
  if (b.kidsBrand) settings.kidsBrand = word(b.kidsBrand, 18) || settings.kidsBrand;
  if (b.subLang) settings.subLang = String(b.subLang).toLowerCase().replace(/[^a-z-]/g, '').slice(0, 10) || settings.subLang;
  saveJSON('settings.json', settings);
  console.log(`settings updated: brand=${settings.brand} kidsBrand=${settings.kidsBrand}`);
  send(res, 200, settings);
});

route('GET', /^\/api\/library$/, (req, res) => send(res, 200, {
  items: library.items.map(publicItem), scanning, scannedAt: library.scannedAt, imdb: IMDB, settings,
}));

route('GET', /^\/api\/discover$/, async (req, res, m, url) => {
  if (!IMDB) return send(res, 200, { disabled: true });
  if (!Object.keys(discoverCache.mlt).length || Object.keys(discoverCache.charts).length < 4) {
    try { await refreshDiscover(); } catch (e) { console.error('discover:', e.message); }
  }
  send(res, 200, buildDiscover(url.searchParams.get('kids') === '1'));
});

route('POST', /^\/api\/watchlist$/, async (req, res) => {
  const b = await readBody(req);
  if (!b.item || !/^tt\d+$/.test(b.item.imdbId || '')) return send(res, 400, { error: 'bad item' });
  lists.watchlist = lists.watchlist.filter((x) => x.imdbId !== b.item.imdbId);
  if (b.on) {
    const { imdbId, name, year, endYear, kind, rating, votes, plot, image, genres, runtime } = b.item;
    lists.watchlist.push({ imdbId, name, year, endYear, kind, rating, votes, plot, image, genres, runtime, added: Date.now() });
  }
  saveJSON('lists.json', lists);
  send(res, 200, { ok: true });
});

route('POST', /^\/api\/dismiss$/, async (req, res) => {
  const b = await readBody(req);
  if (!/^tt\d+$/.test(b.imdbId || '')) return send(res, 400, { error: 'bad id' });
  lists.dismissed = lists.dismissed.filter((x) => x !== b.imdbId);
  if (b.on !== false) lists.dismissed.push(b.imdbId);
  lists.watchlist = lists.watchlist.filter((x) => x.imdbId !== b.imdbId);
  saveJSON('lists.json', lists);
  send(res, 200, { ok: true });
});

route('POST', /^\/api\/rescan$/, (req, res) => { scan(); send(res, 202, { ok: true }); });

route('GET', /^\/api\/thumb\/([0-9a-f]{12})(?:\.([2-8]))?(\.poster)?\.jpg$/, (req, res, m) =>
  serveFile(req, res, path.join(THUMB_DIR, m[1] + (m[2] ? '.' + m[2] : '') + (m[3] || '') + '.jpg')));

route('GET', /^\/img\/([\w.-]+)$/, (req, res, m) => serveFile(req, res, path.join(IMG_DIR, m[1])));

route('GET', /^\/api\/play\/([0-9a-f]{12})$/, async (req, res, m, url) => {
  const it = library.byId.get(m[1]);
  if (!it) return send(res, 404, { error: 'unknown item' });
  const t = Math.max(0, parseFloat(url.searchParams.get('t')) || 0);
  const p = plan(it, { audio: url.searchParams.get('audio'), q: url.searchParams.get('q') || 'orig' });
  if (url.searchParams.get('force') === 'transcode') { p.mode = 'transcode'; p.q = p.q || 1080; }
  if (p.mode === 'none') return send(res, 415, { error: 'no video stream' });
  const sid = (url.searchParams.get('sid') || 'x').replace(/[^\w-]/g, '');
  if (p.mode === 'direct') return send(res, 200, { mode: 'direct', url: `/media/${it.id}`, start: 0, seekTo: t, duration: it.duration });
  const start = p.mode === 'remux' ? await keyframeBefore(path.join(MEDIA_DIR, it.file), it.video.index, t) : t;
  const qs = new URLSearchParams({ mode: p.mode, start: String(start), audio: String(p.audio), q: String(p.q || ''), sid });
  send(res, 200, { mode: p.mode, url: `/stream/${it.id}?${qs}`, start, seekTo: 0, duration: it.duration, q: p.q || 'orig' });
});

route('GET', /^\/media\/([0-9a-f]{12})$/, (req, res, m) => {
  const it = library.byId.get(m[1]);
  if (!it) return send(res, 404, { error: 'unknown item' });
  serveFile(req, res, path.join(MEDIA_DIR, it.file), { cache: 'no-store' });
});

route('GET', /^\/stream\/([0-9a-f]{12})$/, (req, res, m, url) => {
  const it = library.byId.get(m[1]);
  if (!it) return send(res, 404, { error: 'unknown item' });
  const opts = {
    mode: url.searchParams.get('mode') === 'remux' ? 'remux' : 'transcode',
    start: Math.max(0, parseFloat(url.searchParams.get('start')) || 0),
    audio: Number(url.searchParams.get('audio')) || 0,
    q: Number(url.searchParams.get('q')) || 1080,
  };
  const sid = (url.searchParams.get('sid') || '').replace(/[^\w-]/g, '');
  if (sid && activeStreams.has(sid)) { try { activeStreams.get(sid).kill('SIGKILL'); } catch {} }
  const args = ffArgs(it, opts);
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (sid) activeStreams.set(sid, ff);
  let errText = '';
  ff.stderr.on('data', (d) => { errText += d; if (errText.length > 4000) errText = errText.slice(-4000); });
  ff.on('close', (code) => {
    if (sid && activeStreams.get(sid) === ff) activeStreams.delete(sid);
    if (code && code !== 255 && errText && !res.writableEnded) console.error(`ffmpeg ${it.file} exited ${code}: ${errText.trim().slice(-600)}`);
    res.end();
  });
  res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store', 'accept-ranges': 'none' });
  ff.stdout.pipe(res);
  const kill = () => { try { ff.kill('SIGKILL'); } catch {} };
  req.on('close', kill);
  res.on('close', kill);
  console.log(`${opts.mode} ${it.file} @${opts.start.toFixed(1)}s audio=${opts.audio} q=${opts.mode === 'remux' ? 'orig' : opts.q}`);
});

route('GET', /^\/api\/subs\/([0-9a-f]{12})\/(\d+)\/(\d+)\.vtt$/, async (req, res, m) => {
  const it = library.byId.get(m[1]);
  const sIndex = Number(m[2]);
  const sub = it && it.subs.find((s) => s.index === sIndex && s.text);
  if (!it || !sub) return send(res, 404, { error: 'no such subtitle' });
  // external sidecar (downloaded or user-supplied) — convert once to vtt, cache like tracks
  if (sub.ext) {
    const full = fullSubPath(it, sIndex);
    if (!fs.existsSync(full)) {
      const tmp = full + '.tmp';
      const src = path.join(MEDIA_DIR, sub.ext);
      if (!fs.existsSync(src)) return send(res, 404, { error: 'subtitle file missing' });
      try {
        if (/\.vtt$/i.test(sub.ext)) await fsp.copyFile(src, tmp);
        else await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', src, '-map', '0:s', '-f', 'webvtt', '-y', tmp], { timeout: 60000 });
        await fsp.rename(tmp, full);
      } catch (e) { console.error(`sidecar subtitle convert failed ${sub.ext}: ${e.message}`); return send(res, 500, { error: 'subtitle convert failed' }); }
    }
    res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8', 'x-subs-complete': '1', 'cache-control': 'no-store' });
    return fs.createReadStream(full).pipe(res);
  }
  const full = fullSubPath(it, sIndex);
  if (fs.existsSync(full)) {
    res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8', 'x-subs-complete': '1', 'cache-control': 'no-store' });
    return fs.createReadStream(full).pipe(res);
  }
  extractFullSubs(it, sIndex);
  try { send(res, 200, await subsWindow(it, sIndex, Number(m[3])), 'text/vtt; charset=utf-8'); }
  catch (e) { send(res, 500, { error: 'subtitle extraction failed' }); }
});

// ---------- subtitle search/download (OpenSubtitles) ----------
route('POST', /^\/api\/subtitles\/search$/, async (req, res) => {
  if (!opensubs.enabled()) return send(res, 400, { error: 'Set OS_API_KEY in .env — free key at opensubtitles.org (API section)' });
  const b = await readBody(req);
  const it = library.byId.get(b.id);
  const imdb = it && it.meta && /^tt\d+$/.test(it.meta.imdbId) ? it.meta.imdbId : '';
  // episode items carry series meta; title already contains "Show S01E02" → text search beats imdb_id
  const query = (it && it.kind === 'episode') || !imdb
    ? (it ? [it.title || it.show, it.kind === 'movie' ? it.year || '' : ''].filter(Boolean).join(' ') : b.query || '')
    : imdb;
  try {
    const list = await opensubs.search(query, b.lang || 'en');
    send(res, 200, { results: list.slice(0, 12), query });
  } catch (e) { send(res, 502, { error: e.message }); }
});

route('POST', /^\/api\/subtitles\/download$/, async (req, res) => {
  if (!opensubs.enabled()) return send(res, 400, { error: 'Set OS_API_KEY in .env — free key at opensubtitles.org (API section)' });
  const b = await readBody(req);
  const it = library.byId.get(b.id);
  if (!it || !b.subtitleId) return send(res, 400, { error: 'bad request' });
  const lang = String(b.lang || 'en').slice(0, 10).replace(/[^a-z-]/gi, '') || 'en';
  const outRel = it.file.replace(VIDEO_EXT, '') + `.${lang}.srt`;
  try {
    await opensubs.downloadFile(b.subtitleId, b.fileId, path.join(MEDIA_DIR, outRel));
    rebuildItem(it);
    console.log(`subtitle saved ${outRel}`);
    send(res, 200, { ok: 1, file: outRel, subs: it.subs.filter((s) => s.index >= 9000) });
  } catch (e) { send(res, 502, { error: e.message }); }
});

// upload a subtitle file from the browser; saved as a sidecar next to the video
route('POST', /^\/api\/subtitles\/upload$/, async (req, res) => {
  const b = await readBody(req);
  const it = library.byId.get(b.id);
  if (!it) return send(res, 400, { error: 'bad request' });
  const ext = String(b.ext || '').toLowerCase();
  if (ext !== 'srt' && ext !== 'vtt') return send(res, 400, { error: 'only .srt / .vtt files' });
  if (typeof b.data !== 'string' || b.data.length < 8) return send(res, 400, { error: 'empty file' });
  if (b.data.length > 8 * 1024 * 1024) return send(res, 400, { error: 'file too large (max 8 MB)' });
  const lang = String(b.lang || 'en').slice(0, 10).replace(/[^a-z0-9-]/gi, '') || 'en';
  const outRel = `${it.file.replace(VIDEO_EXT, '')}.${lang}.${ext}`;
  try {
    await fsp.writeFile(path.join(MEDIA_DIR, outRel), b.data, 'utf8');
    rebuildItem(it);
    console.log(`subtitle saved ${outRel}`);
    send(res, 200, { ok: 1, file: outRel });
  } catch (e) { send(res, 500, { error: e.message }); }
});

route('POST', /^\/api\/progress$/, async (req, res) => {
  const b = await readBody(req);
  const it = library.byId.get(b.id);
  if (!it) return send(res, 404, { error: 'unknown item' });
  const dur = it.duration || b.dur || 0;
  const s = state[it.file] || (state[it.file] = {});
  s.pos = Math.max(0, Number(b.pos) || 0);
  s.updated = Date.now();
  if (dur && s.pos / dur > 0.93) { s.watched = true; s.pos = 0; }
  saveJSON('state.json', state);
  send(res, 200, { ok: true, progress: s });
});

route('POST', /^\/api\/watched$/, async (req, res) => {
  const b = await readBody(req);
  const ids = Array.isArray(b.ids) ? b.ids : [b.id];
  for (const id of ids) {
    const it = library.byId.get(id);
    if (!it) continue;
    state[it.file] = { pos: 0, watched: !!b.watched, updated: Date.now() };
  }
  saveJSON('state.json', state);
  send(res, 200, { ok: true });
});

route('POST', /^\/api\/override$/, async (req, res) => {
  const b = await readBody(req);
  const it = library.byId.get(b.id);
  if (!it) return send(res, 404, { error: 'unknown item' });
  const allowed = ['title', 'year', 'kind', 'show', 'season', 'episode', 'collection', 'imdb'];
  const ov = {};
  for (const k of allowed) {
    if (b[k] === undefined || b[k] === '' || b[k] === null) continue;
    ov[k] = ['year', 'season', 'episode'].includes(k) ? Number(b[k]) : String(b[k]).slice(0, 200);
  }
  if (!['movie', 'episode', 'extra', 'other'].includes(ov.kind)) delete ov.kind;
  if (b.kids === 'yes' || b.kids === true) ov.kids = true; else if (b.kids === 'no' || b.kids === false) ov.kids = false;
  if (ov.imdb) { const m = /tt\d{5,}/.exec(ov.imdb); if (m) ov.imdb = m[0]; else delete ov.imdb; }
  if (b.reset) delete overrides[it.file]; else overrides[it.file] = ov;
  if (b.collection === '') { if (overrides[it.file]) overrides[it.file].collection = ''; }
  saveJSON('overrides.json', overrides);
  rebuildItem(it);
  if (IMDB) await enrichIMDb().catch((e) => console.error(e));
  send(res, 200, { ok: true, item: publicItem(it) });
});

route('GET', /^\/api\/similar\/(tt\d+)$/, async (req, res, m) => {
  if (!IMDB) return send(res, 200, { disabled: true });
  const id = m[1];
  let entry = discoverCache.mlt[id];
  if ((!entry || Date.now() - entry.at > DISCOVER_MAX_AGE) && !discoverJob) {
    try {
      const r = await imdb.moreLikeThis([id], 20);
      discoverCache.mlt[id] = { at: Date.now(), list: r[id] || [] };
      saveJSON('discover.json', discoverCache);
      entry = discoverCache.mlt[id];
    } catch (e) { console.error('similar:', e.message); }
  }
  send(res, 200, { list: entry ? entry.list : [] });
});

const _imdbSearchCache = new Map(); // q → { at, list }
route('GET', /^\/api\/imdbsearch$/, async (req, res, m, url) => {
  if (!IMDB) return send(res, 200, { disabled: true });
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
  if (!q) return send(res, 200, { results: [] });
  const key = q.toLowerCase();
  const hit = _imdbSearchCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return send(res, 200, { results: hit.list });
  try {
    const list = await imdb.suggest(q);
    _imdbSearchCache.set(key, { at: Date.now(), list });
    send(res, 200, { results: list });
  } catch (e) {
    console.error('imdbsearch:', e.message);
    send(res, 502, { error: e.message });
  }
});

// ---------- torrents (1337x search + transmission) ----------
route('GET', /^\/api\/torrents$/, async (req, res) => {
  const list = await torrent.listTorrents().catch(() => []);
  const active = list.length > 0;
  send(res, 200, { list, active });
});

route('POST', /^\/api\/torrents\/search$/, async (req, res) => {
  const b = await readBody(req);
  const q = String(b.query || '').slice(0, 200);
  if (!q) return send(res, 400, { error: 'query required' });
  try {
    const results = await torrent.search1337x(q);
    send(res, 200, { results });
  } catch (e) {
    send(res, 502, { error: e.message });
  }
});

route('POST', /^\/api\/torrents\/start$/, async (req, res) => {
  const b = await readBody(req);
  const url = String(b.url || '');
  console.log('[start] url:', url.slice(0, 90));
  const t0 = Date.now();
  const isMagnet = /^magnet:/.test(url);
  if (!isMagnet && !/\//.test(url)) { console.error('[start] bad url, 400'); return send(res, 400, { error: 'url required' }); }
  try {
    const magnet = isMagnet ? url : await torrent.getMagnet(url);
    if (!isMagnet) console.log('[start] magnet ok in', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    const id = await torrent.startDownload(magnet, MEDIA_DIR);
    console.log('[start] added id', id, 'in', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    send(res, 200, { ok: true, id });
  } catch (e) {
    console.error('[start] failed after', ((Date.now() - t0) / 1000).toFixed(1) + 's:', e.message);
    send(res, 502, { error: e.message });
  }
});

route('POST', /^\/api\/torrents\/remove$/, async (req, res) => {
  const b = await readBody(req);
  const ok = await torrent.removeTorrent(Number(b.id)).catch(() => false);
  send(res, 200, { ok });
});

const PUBLIC = path.join(__dirname, 'public');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    for (const r of routes) {
      if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
      const m = r.re.exec(url.pathname);
      if (m) return await r.fn(req, res, m, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p === '/' || !path.extname(p)) p = '/index.html';
    const file = path.join(PUBLIC, p);
    if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
    serveFile(req, res, file, { cache: 'no-cache' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Flix on http://localhost:${PORT}  (media: ${MEDIA_DIR})`);
  scan();
  setInterval(scan, RESCAN_MINUTES * 60 * 1000);
});
