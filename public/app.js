'use strict';
/* Flix frontend — vanilla JS, no build step. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('flix.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('flix.' + k, JSON.stringify(v)); } catch {} },
};
const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z" fill="currentColor" stroke="none"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 4h3v16H7zM14 4h3v16h-3z" fill="currentColor" stroke="none"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  restart: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M17 9l5 6M22 9l-5 6"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
};

// ---------- formatting ----------
function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
}
function fmtDur(s) {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
function fmtSize(b) { return b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(0) + ' MB'; }
function resBadge(v) {
  if (!v) return '';
  const w = v.width || 0;
  const r = w >= 3200 ? '4K' : w >= 1800 ? 'HD 1080p' : w >= 1200 ? 'HD 720p' : 'SD';
  return `<span class="badge">${r}</span>` + (v.hdr ? '<span class="badge hdr">HDR</span>' : '');
}
const LANGS = { eng: 'English', ita: 'Italiano', spa: 'Español', fre: 'Français', fra: 'Français', ger: 'Deutsch', deu: 'Deutsch', jpn: '日本語', kor: '한국어', chi: '中文', zho: '中文', por: 'Português', rus: 'Русский', dut: 'Nederlands', pol: 'Polski', swe: 'Svenska', dan: 'Dansk', nor: 'Norsk', fin: 'Suomi', tur: 'Türkçe', ara: 'العربية', heb: 'עברית', gre: 'Ελληνικά', cze: 'Čeština', hun: 'Magyar', ukr: 'Українська', und: 'Unknown' };
const langName = (l) => LANGS[l] || (l ? l.toUpperCase() : '');
function trackLabel(t) {
  const lang = langName(t.lang);
  const title = t.title && !/^(galaxy|encoded|.*(rip|crew|team))/i.test(t.title) ? t.title : '';
  let s = [lang, title].filter(Boolean).join(' – ') || `Track ${t.n ?? t.index}`;
  if (t.channels) s += ` · ${t.channels > 6 ? '7.1' : t.channels > 2 ? '5.1' : t.channels === 1 ? 'mono' : 'stereo'}`;
  if (t.forced) s += ' (forced)';
  return s;
}

// ---------- data ----------
let LIB = { items: [], byId: new Map(), shows: new Map(), collections: new Map() };

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (!r.ok) {
    let msg = String(r.status);
    try { const j = await r.json(); if (j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

function displayTitle(it) {
  if (it.kind === 'movie' && it.meta && it.meta.name) return it.meta.name + (it.part ? ` (Part ${it.part})` : '');
  return it.title;
}
function img(it, n) { return it.thumb ? `/api/thumb/${it.id}${n > 1 ? '.' + n : ''}.jpg` : ''; }
const randShot = (it) => 1 + Math.floor(Math.random() * (it.shots || 1));
const imgRand = (it) => img(it, it.thumb ? randShot(it) : undefined);
function fmtVotes(n) { return !n ? '' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n); }
function imdbScore(m, votes) {
  if (!m || !m.rating) return '';
  const link = m.imdbId ? `https://www.imdb.com/title/${m.imdbId}/` : null;
  const inner = `<span class="imdb-logo">IMDb</span><b>${m.rating.toFixed(1)}</b>${votes && m.votes ? `<small>/10 · ${fmtVotes(m.votes)}</small>` : ''}`;
  return link ? `<a class="imdb" href="${link}" target="_blank" rel="noopener" title="Open on IMDb">${inner}</a>` : `<span class="imdb">${inner}</span>`;
}
function epName(e) { return e.ep && e.ep.title && !/^Episode #?\d/.test(e.ep.title) ? e.ep.title : `Episode ${e.episode}`; }

async function loadLibrary() {
  const data = await api('/api/library');
  const items = data.items;
  const byId = new Map(items.map((i) => [i.id, i]));
  const shows = new Map();
  for (const it of items.filter((i) => i.kind === 'episode')) {
    let s = shows.get(it.showKey);
    if (!s) shows.set(it.showKey, (s = { key: it.showKey, name: it.show, episodes: [], meta: it.meta, added: 0 }));
    s.episodes.push(it);
    s.added = Math.max(s.added, it.added);
    if (!s.meta && it.meta) s.meta = it.meta;
  }
  for (const s of shows.values()) {
    s.episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
    s.seasons = [...new Set(s.episodes.map((e) => e.season))];
    s.watchedCount = s.episodes.filter((e) => e.progress.watched).length;
    s.updated = Math.max(...s.episodes.map((e) => e.progress.updated || 0));
  }
  const collections = new Map();
  for (const it of items) {
    if (!it.collection) continue;
    if (!collections.has(it.collection)) collections.set(it.collection, []);
    collections.get(it.collection).push(it);
  }
  for (const list of collections.values()) list.sort((a, b) => (a.year || 9999) - (b.year || 9999) || a.title.localeCompare(b.title));
  LIB = { items, byId, shows, collections, scanning: data.scanning, imdb: data.imdb };
  SETTINGS = data.settings || SETTINGS;
  applyBranding();
  $('#rescan').classList.toggle('busy', !!data.scanning);
  if (data.scanning && !pollingScan) pollScan();
  return LIB;
}

function showImg(s) {
  const thumbs = s.episodes.filter((e) => e.thumb);
  if (!thumbs.length) return '';
  const e = thumbs[Math.floor(Math.random() * thumbs.length)];
  return img(e, randShot(e));
}
function nextUp(show) {
  // the episode after the most recently watched one, or the in-progress one
  let last = -1, lastT = 0;
  show.episodes.forEach((e, i) => { if (e.progress.updated > lastT) { lastT = e.progress.updated; last = i; } });
  if (last === -1) return show.episodes[0];
  const e = show.episodes[last];
  if (!e.progress.watched) return e;
  return show.episodes.slice(last + 1).find((x) => !x.progress.watched) || null;
}
function nextEpisode(it) {
  if (it.kind !== 'episode') return null;
  const s = LIB.shows.get(it.showKey);
  const i = s.episodes.indexOf(s.episodes.find((e) => e.id === it.id));
  return s.episodes[i + 1] || null;
}

// ---------- cards & rows ----------
function card(o) {
  // o: { title, sub, img, cyc: {id, shots, backN}, pct, watched, count, onclick-data }
  const pct = o.pct ? Math.min(100, Math.max(2, o.pct * 100)) : 0;
  const cyc = o.cyc ? `<img class="cyc" data-n="${o.cyc.backN}" style="opacity:0" src="/api/thumb/${o.cyc.id}${o.cyc.backN > 1 ? '.' + o.cyc.backN : ''}.jpg" loading="lazy" alt="" onerror="this.classList.add('off')">` : '';
  return `<div class="card ${pct ? 'has-bar' : ''}" tabindex="0" data-open="${esc(o.open)}" title="${esc(o.title)}">
    <div class="img" ${o.cyc ? `cyc data-cyc="${o.cyc.id}" data-shots="${o.cyc.shots}"` : ''}>${o.img ? `<img data-n="${o.cyc ? o.cyc.n : 1}" loading="lazy" src="${esc(o.img)}" alt="" onerror="this.remove()">` : ''}${cyc}<div class="ph" ${o.img ? 'style="z-index:-1"' : ''}>${esc(o.title)}</div></div>
    <div class="shade"></div>
    ${o.count ? `<span class="count">${esc(o.count)}</span>` : ''}
    ${o.watched ? `<span class="tick" title="Watched">${ICON.check}</span>` : ''}
    ${o.playable ? `<div class="playhint"><span>${ICON.play}</span></div>` : ''}
    <div class="label"><div class="t">${esc(o.title)}</div>${o.sub ? `<div class="s">${esc(o.sub)}</div>` : ''}</div>
    ${pct ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
  </div>`;
}
function itemCard(it, opts = {}) {
  const pct = it.progress.pos && it.duration ? it.progress.pos / it.duration : 0;
  let title = displayTitle(it), sub = [it.year, fmtDur(it.duration), it.meta && it.meta.rating ? `★ ${it.meta.rating.toFixed(1)}` : ''].filter(Boolean).join(' · ');
  if (it.kind === 'episode') { title = it.show; sub = `S${it.season} E${it.episode}` + (it.ep && it.ep.title ? ` · ${epName(it)}` : '') + (opts.resume && pct ? ` · ${fmtTime(it.duration - it.progress.pos)} left` : ''); }
  else if (opts.resume && pct) sub = `${fmtTime(it.duration - it.progress.pos)} left`;
  const shots = it.shots || 1;
  const n = it.thumb ? 1 + Math.floor(Math.random() * shots) : 0; // random start frame every render
  return card({
    title, sub,
    img: it.thumb ? `/api/thumb/${it.id}${n > 1 ? '.' + n : ''}.jpg` : '',
    cyc: it.thumb && shots > 1 ? { id: it.id, n, shots, backN: (n % shots) + 1 } : null,
    pct, watched: it.progress.watched, open: (opts.play ? 'play:' : 'item:') + it.id, playable: opts.play,
  });
}
function showCard(s) {
  const seasons = s.seasons.length;
  return card({ title: s.name, sub: `${seasons} season${seasons > 1 ? 's' : ''} · ${s.episodes.length} episodes` + (s.meta && s.meta.rating ? ` · ★ ${s.meta.rating.toFixed(1)}` : ''), img: showImg(s),
    open: 'show:' + s.key, watched: s.watchedCount === s.episodes.length, count: s.watchedCount && s.watchedCount < s.episodes.length ? `${s.episodes.length - s.watchedCount} new` : '' });
}
function collectionCard(name, list) {
  const first = list.find((i) => img(i)) || list[0];
  return card({ title: name, sub: `${list.length} titles`, img: first ? imgRand(first) || '' : '', open: 'coll:' + name, count: list.length });
}
function row(title, cardsHtml, link) {
  if (!cardsHtml.length) return '';
  return `<section class="row"><h2>${link ? `<a href="${link}">${esc(title)} ›</a>` : esc(title)}</h2>
    <div class="scroller"><button class="arrow l" aria-label="Scroll left">${ICON.left}</button>
    <div class="track">${cardsHtml.join('')}</div>
    <button class="arrow r" aria-label="Scroll right">${ICON.right}</button></div></section>`;
}

// ---------- discover (titles not in the library) ----------
let DISC = null, discPromise = null;
const DISC_BY_ID = new Map();
function loadDiscover(force) {
  if (discPromise && !force) return discPromise;
  discPromise = api('/api/discover').then((d) => {
    DISC = d;
    DISC_BY_ID.clear();
    const all = [...(d.kidsPicks || []), ...(d.movies || []), ...(d.series || []), ...(d.watchlist || []), ...(d.popularMovies || []), ...(d.popularSeries || []),
      ...(d.topMovies || []), ...(d.topSeries || []), ...(d.because || []).flatMap((b) => b.items)];
    for (const x of all) { const prev = DISC_BY_ID.get(x.imdbId); DISC_BY_ID.set(x.imdbId, prev && prev.because ? prev : x); }
    return d;
  }).catch((e) => { discPromise = null; throw e; });
  return discPromise;
}
function pcard(x) {
  const yrs = x.kind === 'series' ? `${x.year || ''}–${x.endYear || ''}` : x.year || '';
  return `<div class="pcard" tabindex="0" data-open="disc:${x.imdbId}" title="${esc(x.name)}">
    <div class="pimg">${x.image ? `<img loading="lazy" src="${esc(x.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<div class="ph">${esc(x.name)}</div></div>
    ${x.inList ? '<span class="ribbon" title="On your watchlist"></span>' : ''}
    ${x.rating ? `<span class="pr">★ ${x.rating.toFixed(1)}</span>` : ''}
    <div class="pt">${esc(x.name)}</div><div class="ps">${esc([yrs, x.kind === 'series' ? 'Series' : ''].filter(Boolean).join(' · '))}</div>
  </div>`;
}
function prow(title, list, sub) {
  if (!list || !list.length) return '';
  return section(title, list.map(pcard), sub);
}
function section(title, cards, sub) {
  if (!cards || !cards.length) return '';
  return row(title, cards).replace('</h2>', sub ? ` <small>${esc(sub)}</small></h2>` : '</h2>');
}
function openDisc(id) {
  const x = DISC_BY_ID.get(id);
  if (!x) return;
  const yrs = x.kind === 'series' ? `${x.year || ''}–${x.endYear || ''}` : x.year || '';
  openModal(`<div class="d-wrap">
    <div class="d-poster">${x.image ? `<img src="${esc(x.image.replace(/UX\d+/, 'UX600'))}" alt="" referrerpolicy="no-referrer">` : ''}</div>
    <div class="d-info">
      <div class="kicker">${KIDS.on ? 'Ask a grown-up!' : `${x.kind === 'series' ? 'Series' : 'Movie'} · not in your library`}</div>
      <h1>${esc(x.name)}</h1>
      <div class="metaline">${imdbScore(x, true)}${yrs ? `<span>${yrs}</span>` : ''}${x.runtime && x.kind !== 'series' ? `<span>${fmtDur(x.runtime)}</span>` : ''}</div>
      ${x.genres && x.genres.length ? `<div class="chips">${x.genres.map((g) => `<span>${esc(g)}</span>`).join('')}</div>` : ''}
      <p class="overview">${esc(x.plot || '')}</p>
      ${x.because && x.because.length ? `<p class="kv">Because you have <b>${x.because.map(esc).join('</b>, <b>')}</b></p>` : ''}
      <div class="btns">
        <button class="btn ${x.inList ? 'btn-ghost' : 'btn-play'}" data-act="wl" data-id="${x.imdbId}" data-v="${x.inList ? 0 : 1}">${x.inList ? ICON.check + (KIDS.on ? ' On the wish list' : ' On watchlist') : ICON.plus + (KIDS.on ? ' Add to wish list' : ' Add to watchlist')}</button>
        ${KIDS.on ? '' : `<button class="btn btn-ghost" data-act="torrent" data-id="${x.imdbId}" data-name="${esc(x.name)}" data-year="${x.year || ''}">Get torrent</button>`}
        ${KIDS.on ? '' : `<a class="btn btn-ghost" href="https://www.imdb.com/title/${x.imdbId}/" target="_blank" rel="noopener">View on IMDb</a>`}
        ${KIDS.on ? '' : `<button class="btn btn-ghost" data-act="dismiss" data-id="${x.imdbId}">Not interested</button>`}
      </div>
    </div></div>`, { type: 'disc', id });
}

// ---------- torrent download ----------
let torrentTimer = null;
function stopTorrentPoll() { if (torrentTimer) { clearInterval(torrentTimer); torrentTimer = null; } }
async function torrentTick() {
  const st = modalState;
  // Only render the downloads table while in 'watch' phase; picker lists must stay clickable.
  if (!modal.hidden && st && st.type === 'torrent' && st.id && st.phase === 'watch') renderTorrent(st.id);
  else stopTorrentPoll();
}
function torrentPoll() { stopTorrentPoll(); torrentTimer = setInterval(torrentTick, 2500); }
async function openTorrentPicker(id) {
  const x = DISC_BY_ID.get(id);
  if (!x) return;
  const q = [x.name, x.year].filter(Boolean).join(' ');
  openModal(`<div class="page" style="padding:16px 0"><div class="page-head"><h1>Get torrent</h1><span class="count-l">Searching 1337x for “${esc(q)}”…</span></div><div class="t-wait">Finding torrents… (first search may take a while — 1337x is behind Cloudflare)</div></div>`, { type: 'torrent', id });
  torrentPoll();
  let results = [];
  try { results = (await api('/api/torrents/search', { query: q })).results; } catch (e) {
    if (modalState && modalState.type === 'torrent') openModal(`<div class="page" style="padding:16px 0"><div class="empty">Search failed: ${esc(e.message)}<br><br><button class="btn btn-play" data-act="torrent-retry" data-id="${id}" data-name="${esc(x.name)}" data-year="${x.year || ''}">Try again</button></div></div>`, { type: 'torrent', id });
    stopTorrentPoll();
    return;
  }
  if (!results.length) {
    if (modalState && modalState.type === 'torrent') openModal(`<div class="page" style="padding:16px 0"><div class="empty">No torrents found for “${esc(q)}”.<br><br><button class="btn btn-play" data-act="torrent-retry" data-id="${id}" data-name="${esc(x.name)}" data-year="${x.year || ''}">Try again</button></div></div>`, { type: 'torrent', id, phase: 'pick' });
    stopTorrentPoll();
    return;
  }
  renderTorrentPick(id, q, results);
}
function renderTorrentPick(id, q, results) {
  const rows = results.slice(0, 15).map((r, i) => `<tr data-tor="${i}" class="t-row"><td>${esc(r.name)}</td><td>${esc(r.size)}</td><td>${esc(r.seeders)}</td></tr>`).join('');
  openModal(`<div class="page" style="padding:16px 0"><div class="page-head"><h1>Choose a torrent</h1><span class="count-l">${results.length} found for “${esc(q)}”</span></div>
  <table class="t-list"><thead><tr><th>Name</th><th>Size</th><th>Seeders</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="t-hint">Click a row to download it to the movies folder.</p></div>`, { type: 'torrent', id, q, results, phase: 'pick' });
}
function renderTorrent(id) {
  const x = DISC_BY_ID.get(id);
  if (!x) return;
  const keep = modalState && modalState.type === 'torrent' ? modalState.results : null;
  api('/api/torrents').then((d) => {
    if (modalState && modalState.type === 'torrent' && modalState.id === id) {
      const list = d.list || [];
      const rows = list.map((t) => `<tr><td>${esc(t.name)}</td><td>${t.progress.toFixed(1)}%</td><td>${t.down ? (t.down / 1024 / 1024).toFixed(1) + ' MB/s' : (t.progress >= 100 ? 'done' : (t.status === 6 ? 'seeding' : (t.status === 4 ? 'checking' : 'paused')))}</td></tr>`).join('') || '<tr><td colspan=3>No active downloads</td></tr>';
      openModal(`<div class="page" style="padding:16px 0"><div class="page-head"><h1>Downloads</h1><span class="count-l">Saving to the movies folder</span></div>
      <table class="t-list"><thead><tr><th>Name</th><th>Progress</th><th>Speed</th></tr></thead><tbody>${rows}</tbody></table></div>`, { type: 'torrent', id, phase: 'watch' });
    }
  }).catch(() => {});
}
let torrentBusy = false;
async function startTorrent(url, id, name, scheme) {
  console.log('[torrent-ui] start:', url.slice(0, 80));
  if (torrentBusy) return;
  torrentBusy = true;
  // Replace the list with a busy panel so double-clicks are impossible.
  const snap = modalState && modalState.type === 'torrent' && modalState.phase === 'pick' ? { q: modalState.q, results: modalState.results } : null;
  const busyMsg = scheme === 'magnet:' ? 'Adding magnet to Transmission…' : 'Getting magnet from 1337x…';
  const busyNote = scheme === 'magnet:' ? 'Should only take a few seconds.' : 'Can take up to ~1 minute (Cloudflare) — please wait.';
  if (snap) {
    openModal(`<div class="page t-busy"><div><span class="spin"></span><b>${busyMsg}</b>
      <div class="kv">${esc(name || '')}</div><small class="kv">${busyNote}</small></div></div>`,
      { type: 'torrent', id, q: snap.q, results: snap.results, phase: 'pick', busy: true });
  }
  modal.classList.add('busy');
  try {
    await api('/api/torrents/start', { url });
    console.log('[torrent-ui] start ok');
    toast('Download started');
    if (modalState && modalState.type === 'torrent') { modalState.phase = 'watch'; renderTorrent(id); }
    torrentPoll();
  } catch (e) {
    console.error('[torrent-ui] start failed:', e.message);
    toast('Could not start download: ' + e.message);
    if (snap && modalState && modalState.type === 'torrent' && modalState.id === id && modalState.busy && snap.results) renderTorrentPick(id, snap.q, snap.results);
  } finally { torrentBusy = false; modal.classList.remove('busy'); }
}
// ---------- subtitle download (OpenSubtitles) ----------
async function subSearchModal(id) {
  const it = LIB.byId.get(id);
  if (!it) return;
  openModal(`<div class="page" style="padding:16px 0"><div class="page-head"><h1>Download subtitles</h1><span class="count-l">Searching OpenSubtitles…</span></div><div class="t-wait">Finding subtitles for “${esc(displayTitle(it))}”…</div></div>`, { type: 'subs', id });
  let results = [];
  try {
    results = (await api('/api/subtitles/search', { id })).results || [];
  } catch (e) {
    openModal(`<div class="page" style="padding:16px 0"><div class="page-head"><h1>Download subtitles</h1></div><div class="empty">${esc(e.message)}</div></div>`, { type: 'subs', id });
    return;
  }
  const rows = results.map((s) => `<div class="sub-row"><div class="sub-info">
    <div class="sub-name">${esc(s.release || s.fileName || s.title || it.title)}</div>
    <div class="sub-meta"><b>${esc(langName(s.language) || s.language.toUpperCase())}</b>${s.trusted ? ' · ✅ trusted' : ''}${s.hd ? ' · HD' : ''}${s.hi ? ' · hearing impaired' : ''}${s.ai ? ' · AI-translated' : ''} · ${Number(s.downloads || 0).toLocaleString()} downloads</div>
  </div><button class="btn btn-ghost btn-sm" data-act="sub-dl" data-id="${it.id}" data-subid="${esc(s.subtitleId)}" data-fileid="${esc(s.fileId)}" data-lang="${esc(s.language || 'en')}">Download</button></div>`).join('');
  openModal(`<div class="page" style="padding:16px 0"><div class="page-head"><h1>Download subtitles</h1><span class="count-l">${results.length} for “${esc(displayTitle(it))}”</span></div>
    <div class="sub-list">${rows || `<div class="empty">No subtitles found.</div>`}</div>
    <p class="t-hint">Saved next to the video file. Works in the player next time you open it.</p></div>`, { type: 'subs', id });
}

async function subDownload(btn) {
  const { id, subid, fileid, lang } = btn.dataset;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const r = await api('/api/subtitles/download', { id, subtitleId: subid, fileId: fileid || undefined, lang: lang || 'en' });
    toast(`Subtitles saved: ${r.file}`);
    await loadLibrary();
    openItem(id); // fresh modal shows the new subs
  } catch (e) {
    toast('Subtitles download failed: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Download';
  }
}

// add a subtitle file from the user's disk as a sidecar next to the video
function subAddFile(id) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.srt,.vtt';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const ext = (f.name.match(/\.(srt|vtt)$/i) || [])[1];
    if (!ext) return toast('Only .srt or .vtt files');
    // language = last alphabetic 2–4 char token in the name (Movie.2021.eng.srt → en), else default en
    const toks = f.name.replace(/\.(srt|vtt)$/i, '').split(/[._\-\s]+/).reverse();
    let lang = 'en';
    for (const t of toks) {
      if (!t || !/^[a-z]{2,4}$/i.test(t) || /^(hi|sdh|cc|forced|full)$/i.test(t)) continue;
      lang = t.toLowerCase();
      break;
    }
    try {
      const data = await f.text();
      const r = await api('/api/subtitles/upload', { id, ext: ext.toLowerCase(), lang, data });
      toast(`Subtitles saved: ${r.file}`);
      await loadLibrary();
      openItem(id); // fresh modal shows the new subs
    } catch (e) { toast('Upload failed: ' + e.message); }
  };
  inp.click();
}

async function renderDiscover() {
  view.innerHTML = '<div class="page"><div class="page-head"><h1>Discover</h1><span class="count-l">Finding things you might like…</span></div></div>';
  let d;
  try { d = await loadDiscover(); } catch (e) { view.innerHTML = `<div class="empty" style="padding-top:120px">Could not load suggestions: ${esc(e.message)}</div>`; return; }
  if (d.disabled) { view.innerHTML = '<div class="empty" style="padding-top:120px">IMDb lookups are disabled (IMDB=0).</div>'; return; }
  if (location.hash !== '#/discover') return;
  let html = '<div class="page discover">';
  html += `<div class="page-head"><h1>Discover</h1><span class="count-l">Picked from IMDb based on what you watch and own</span></div>`;
  html += prow('My Watchlist', d.watchlist);
  html += prow('Top picks for you', d.movies.slice(0, 25), 'movies');
  html += prow('Series you might like', d.series.slice(0, 25));
  html += prow('Kids & family picks', d.kidsPicks, `for ${SETTINGS.kidsBrand}`);
  for (const b of d.because) html += prow(`Because you watched ${b.seed}`, b.items);
  html += prow('Popular movies right now', d.popularMovies);
  html += prow('Popular series right now', d.popularSeries);
  html += prow('IMDb Top 250 you don’t have', d.topMovies, 'movies');
  html += prow('Top rated series you don’t have', d.topSeries);
  html += prow('More picks for you', d.movies.slice(25).concat(d.series.slice(25)));
  html += '</div>';
  view.innerHTML = html;
}

// ---------- LOLOFLIX (kids mode) ----------
const KIDS = { on: store.get('kids', false) };
function setKids(on) {
  KIDS.on = on;
  store.set('kids', on);
  document.body.classList.toggle('kids', on);
  document.title = on ? SETTINGS.kidsBrand : SETTINGS.brand;
  $('#search').placeholder = on ? 'Find a movie…' : 'Titles, shows, years…';
  $('#search').value = '';
}
const kidItems = () => LIB.items.filter((i) => i.kidsSafe && (i.kind === 'movie' || i.kind === 'episode'));
const kidShows = () => [...LIB.shows.values()].filter((s) => s.episodes.some((e) => e.kidsSafe));

// ---------- branding / settings ----------
let SETTINGS = { brand: 'Flix', kidsBrand: 'KIDSFLIX', subLang: 'en' };
const letterSpans = (name) => [...name].map((c) => `<span>${esc(c)}</span>`).join('');
function applyBranding() {
  document.title = KIDS.on ? SETTINGS.kidsBrand : SETTINGS.brand;
  const logo = $('#logo');
  if (logo) logo.textContent = (SETTINGS.brand || 'Flix').toUpperCase();
  const kl = $('#kids-logo');
  if (kl) { kl.innerHTML = letterSpans(SETTINGS.kidsBrand || 'KIDSFLIX'); kl.setAttribute('aria-label', `${SETTINGS.kidsBrand} home`); }
  const klink = $('#kids-link');
  if (klink) klink.textContent = SETTINGS.kidsBrand;
}
const hasGenre = (it, g) => it.meta && (it.meta.genres || []).includes(g);

// ---------- hero carousel (home + kids) — cycles movies + their screenshots ----------
const HERO_SLOTS = 8, HERO_MS = 9000;
let heroTimer = null, heroSpin = 0;
function heroShell(cls) {
  return `<section class="hero ${cls}" id="hero">
    <div class="hero-img" id="hero-a"></div><div class="hero-img" id="hero-b" style="opacity:0"></div>
    <div class="hero-body" id="hero-body"></div><div class="hero-dots" id="hero-dots"></div></section>`;
}
function heroBodyHtml(m, kids) {
  if (kids) return `<div class="kicker">Let's watch!</div><h1>${esc(displayTitle(m))}</h1>
      ${m.meta && m.meta.overview ? `<p>${esc(m.meta.overview)}</p>` : ''}
      <div class="btns"><button class="btn btn-play" data-open="play:${m.id}">${ICON.play} ${m.progress.pos > 30 && !m.progress.watched ? 'Keep watching' : 'Play'}</button>
      <button class="btn btn-ghost" data-open="item:${m.id}">${ICON.info} What's it about?</button></div>`;
  const resume = m.progress.pos > 30 && !m.progress.watched;
  return `<div class="kicker">${m.collection ? esc(m.collection) : 'Featured'}</div><h1>${esc(displayTitle(m))}</h1>
      <div class="metaline">${imdbScore(m.meta)}${m.year ? `<span>${m.year}</span>` : ''}<span>${fmtDur(m.duration)}</span>${resBadge(m.video)}${m.meta && m.meta.genres.length ? `<span>${esc(m.meta.genres.slice(0, 3).join(' · '))}</span>` : ''}</div>
      <p>${m.meta && m.meta.overview ? esc(m.meta.overview) : ''}</p>
      <div class="btns"><button class="btn btn-play" data-open="play:${m.id}">${ICON.play} ${resume ? 'Resume' : 'Play'}</button>
      <button class="btn btn-ghost" data-open="item:${m.id}">${ICON.info} More Info</button></div>`;
}
function stopHero() { if (heroTimer) { clearInterval(heroTimer); heroTimer = null; } }
function startHeroCycle(pool, cls, kids) {
  stopHero();
  heroSpin = 0;
  const el = $('#hero');
  if (!el || !pool.length) return;
  // spread picks out of the pool, rotating hourly so each visit starts elsewhere
  const seed = Math.floor(Date.now() / 36e5) * 3;
  const heroes = [];
  const step = Math.max(1, Math.floor(pool.length / (HERO_SLOTS + 2)));
  for (let i = 0; heroes.length < Math.min(HERO_SLOTS, pool.length); i++) {
    const m = pool[(seed + i * step) % pool.length];
    if (m && !heroes.includes(m)) heroes.push(m);
    if (i > pool.length * 2) break; // safety
  }
  let idx = 0, paused = false, front = 'a';
  const body = $('#hero-body'), dots = $('#hero-dots');
  $('#hero-a').style.backgroundImage = `url('${esc(img(heroes[0], 1))}')`;
  body.innerHTML = heroBodyHtml(heroes[0], kids);
  dots.innerHTML = heroes.map((_, i) => `<button class="hero-dot${i ? '' : ' on'}" data-i="${i}" aria-label="Show title ${i + 1}"></button>`).join('');
  el.onmouseover = () => { paused = true; };
  el.onmouseout = () => { paused = false; };
  el.addEventListener('click', (e) => {
    const d = e.target.closest('.hero-dot');
    if (d) show(Number(d.dataset.i));
  });
  function show(i) {
    idx = (i + heroes.length) % heroes.length;
    const m = heroes[idx];
    heroSpin++;
    const n = 1 + (heroSpin % (m.shots || 1)); // each appearance gets a fresh screenshot
    const back = front === 'a' ? 'b' : 'a';
    const swapText = () => {
      if (!document.getElementById('hero-body')) return;
      body.innerHTML = heroBodyHtml(m, kids);
      body.style.opacity = 1;
    };
    const url = img(m, m.shots > 1 ? n : 1);
    const pre = new Image();
    pre.onload = () => {
      if (!document.getElementById('hero-a')) return;
      $('#hero-' + back).style.backgroundImage = `url('${esc(url)}')`;
      $('#hero-' + back).style.opacity = 1;
      $('#hero-' + front).style.opacity = 0;
      front = back;
      swapText();
    };
    pre.onerror = swapText;
    body.style.opacity = 0;
    setTimeout(swapText, 900); // fallback if image stalls
    pre.src = url;
    [ ...dots.children ].forEach((d, j) => d.classList.toggle('on', j === idx));
  }
  const tick = () => { if (!document.getElementById('hero')) return stopHero(); if (!paused) show(idx + 1); };
  heroTimer = setInterval(tick, HERO_MS);
}

function renderKids() {
  const movies = kidItems().filter((i) => i.kind === 'movie');
  const shows = kidShows();
  const pool = movies.filter((m) => img(m) && m.meta && m.meta.overview);
  let html = '';
  if (pool.length) html += heroShell('kids-hero');
  html += `<div class="rows" ${pool.length ? '' : 'style="margin-top:0;padding-top:90px"'}>`;
  const cw = continueWatching(true);
  html += row('▶️ Keep watching', cw);
  if (shows.length) html += row('📺 Shows', shows.map(showCard));
  html += row('🎨 Cartoons', movies.filter((m) => hasGenre(m, 'Animation')).sort((a, b) => b.added - a.added).map((i) => itemCard(i)));
  html += row('👨‍👩‍👧 Family movies', movies.filter((m) => !hasGenre(m, 'Animation')).sort((a, b) => (a.year || 0) - (b.year || 0)).map((i) => itemCard(i)));
  for (const [name, list] of LIB.collections) {
    const k = list.filter((i) => i.kidsSafe);
    if (k.length >= 2) html += row(`⭐ ${name}`, k.map((i) => itemCard(i)));
  }
  html += row('🔁 Watch again', movies.filter((m) => m.progress.watched).map((i) => itemCard(i)));
  html += row('🍿 Everything', movies.slice().sort((a, b) => displayTitle(a).localeCompare(displayTitle(b))).map((i) => itemCard(i)));
  html += '<div id="kids-recs"></div></div>';
  view.innerHTML = html;
  startHeroCycle(pool, 'kids-hero', true);
  if (LIB.imdb) api('/api/discover?kids=1').then((d) => {
    const el = $('#kids-recs');
    if (!el || !d.kids) return;
    for (const x of [...d.kids, ...d.popular, ...d.top]) if (!DISC_BY_ID.has(x.imdbId)) DISC_BY_ID.set(x.imdbId, x);
    el.outerHTML = prow('✨ Ask a grown-up for these', d.kids.slice(0, 25));
  }).catch(() => {});
}
function renderKidsSearch(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = kidItems().filter((i) => i.kind === 'movie' && words.every((w) => [displayTitle(i), i.title, i.collection].join(' ').toLowerCase().includes(w)));
  const shows = kidShows().filter((s) => words.every((w) => s.name.toLowerCase().includes(w)));
  view.innerHTML = `<div class="page"><div class="page-head"><h1>🔎 “${esc(q)}”</h1></div>
    ${list.length + shows.length ? `<div class="grid">${shows.map(showCard).join('')}${list.map((i) => itemCard(i)).join('')}</div>` : '<div class="empty">Nothing found. Try another word!</div>'}</div>`;
}
function kidsExitGate() {
  const a = 3 + Math.floor(Math.random() * 7), b = 3 + Math.floor(Math.random() * 7);
  openModal(`<div class="m-body gate"><h2>Grown-ups only</h2><p class="kv">To leave ${esc(SETTINGS.kidsBrand)}, answer this:</p>
    <form id="gate-form"><div class="gate-q">${a} × ${b} =</div><input id="gate-a" inputmode="numeric" autocomplete="off" aria-label="Answer">
    <div class="btns"><button class="btn btn-play" type="submit">Exit ${esc(SETTINGS.kidsBrand)}</button><button class="btn btn-ghost" type="button" data-close>Stay</button></div></form></div>`, { type: 'gate' });
  $('#gate-a').focus();
  $('#gate-form').onsubmit = (e) => {
    e.preventDefault();
    if (Number($('#gate-a').value) === a * b) { closeModal(); setKids(false); location.hash = '#/'; route(); }
    else { $('#gate-a').value = ''; $('#gate-a').classList.add('shake'); setTimeout(() => $('#gate-a').classList.remove('shake'), 500); }
  };
}
$('#kids-exit').onclick = kidsExitGate;

// ---------- settings page ----------
function renderSettings() {
  if (KIDS.on) return renderKids();
  const s = SETTINGS || {};
  view.innerHTML = `<div class="page"><div class="page-head"><h1>Settings</h1></div>
    <form id="set-form" class="set-form">
      <label>App name<input id="set-brand" value="${esc(s.brand || '')}" maxlength="18" autocomplete="off"></label>
      <label>Kids mode name<input id="set-kids" value="${esc(s.kidsBrand || '')}" maxlength="18" autocomplete="off"></label>
      <label>Default subtitle language<input id="set-lang" value="${esc(s.subLang || 'en')}" maxlength="10" autocomplete="off" placeholder="en"></label>
      <div class="btns"><button class="btn btn-play" type="submit">Save</button><button class="btn btn-ghost" type="button" id="set-rescan">Rescan library</button><span class="count-l" id="set-msg"></span></div>
      <p class="kv" style="margin-top:18px">Subtitles (online search) need OS_* keys in <b>.env</b> — see README. Kids-mode exit gate asks a multiplication question.</p>
    </form></div>`;
  $('#set-rescan').onclick = async () => {
    $('#set-msg').textContent = 'Rescanning…';
    await api('/api/rescan', {});
    const iv = setInterval(async () => {
      try { const d = await api('/api/library'); if (!d.scanning) { clearInterval(iv); await loadLibrary(); renderSettings(); } } catch {}
    }, 3000);
  };
  $('#set-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/settings', { brand: $('#set-brand').value, kidsBrand: $('#set-kids').value, subLang: $('#set-lang').value });
      SETTINGS = r;
      applyBranding();
      $('#set-msg').textContent = 'Saved ✓';
      setTimeout(el => { el.textContent = ''; }, 2500, $('#set-msg'));
    } catch (e) { $('#set-msg').textContent = e.message; }
  };
}

// ---------- card screenshot cycling (two-layer crossfade) ----------
const CYC_MS = 3600;
setInterval(() => {
  $$('.card .img[cyc]').forEach((box) => {
    const imgs = [...box.querySelectorAll('img')].filter((i) => !i.classList.contains('off'));
    if (imgs.length !== 2 || !(Number(box.dataset.shots) > 1)) return;
    const front = imgs[0].style.opacity === '0' ? imgs[1] : imgs[0];
    const back = front === imgs[0] ? imgs[1] : imgs[0];
    const shots = Number(box.dataset.shots);
    const next = (Number(back.dataset.n || 1) % shots) + 1;
    back.dataset.n = next;
    back.src = `/api/thumb/${box.dataset.cyc}${next > 1 ? '.' + next : ''}.jpg`;
    const flip = () => { back.style.opacity = 1; front.style.opacity = 0; };
    if (back.complete) flip(); else back.onload = flip;
  });
}, CYC_MS);

// ---------- views ----------
const view = $('#view');
function continueWatching(kidsOnly) {
  const out = [];
  const movies = LIB.items.filter((i) => i.kind !== 'episode' && i.progress.pos > 30 && !i.progress.watched && (!kidsOnly || i.kidsSafe));
  for (const m of movies) out.push({ t: m.progress.updated, html: itemCard(m, { resume: true, play: true }) });
  for (const s of LIB.shows.values()) {
    if (!s.updated || (kidsOnly && !s.episodes.some((e) => e.kidsSafe))) continue;
    const e = nextUp(s);
    if (e) out.push({ t: s.updated, html: itemCard(e, { resume: true, play: true }) });
  }
  return out.sort((a, b) => b.t - a.t).map((x) => x.html);
}

function renderHome() {
  const movies = LIB.items.filter((i) => i.kind === 'movie');
  let withImg = movies.filter((m) => img(m) && m.duration > 1800);
  if (withImg.some((m) => m.meta && m.meta.overview)) withImg = withImg.filter((m) => m.meta && m.meta.overview);
  let html = '';
  if (withImg.length) html += heroShell('');
  html += `<div class="rows" ${withImg.length ? '' : 'style="margin-top:0;padding-top:90px"'}>`;
  html += row('Continue Watching', continueWatching());
  html += '<div id="home-recs"></div>';
  // recently added: movies + shows as units
  const recent = [
    ...movies.map((m) => ({ t: m.added, html: itemCard(m) })),
    ...[...LIB.shows.values()].map((s) => ({ t: s.added, html: showCard(s) })),
  ].sort((a, b) => b.t - a.t).slice(0, 24).map((x) => x.html);
  html += row('Recently Added', recent);
  html += row('TV Shows', [...LIB.shows.values()].sort((a, b) => a.name.localeCompare(b.name)).map(showCard), '#/shows');
  const colls = [...LIB.collections.entries()].filter(([, l]) => l.length >= 2).sort((a, b) => b[1].length - a[1].length);
  for (const [name, list] of colls.slice(0, 4)) html += row(name, list.map((i) => itemCard(i)));
  const decades = new Map();
  for (const m of movies) {
    const d = m.year ? `${Math.floor(m.year / 10) * 10}s` : 'Undated';
    if (!decades.has(d)) decades.set(d, []);
    decades.get(d).push(m);
  }
  for (const d of [...decades.keys()].sort().reverse()) {
    const list = decades.get(d).sort((a, b) => (b.year || 0) - (a.year || 0));
    html += row(d === 'Undated' ? 'More Movies' : `From the ${d}`, list.map((i) => itemCard(i)));
  }
  html += row('Extras & Other', LIB.items.filter((i) => i.kind === 'extra' || i.kind === 'other').map((i) => itemCard(i)));
  html += row('Collections', colls.map(([n, l]) => collectionCard(n, l)), '#/collections');
  html += '</div>';
  view.innerHTML = html;
  startHeroCycle(withImg, '', false);
  if (LIB.imdb) loadDiscover().then((d) => {
    const el = $('#home-recs');
    if (!el || !d.movies) return;
    const mix = [];
    for (let i = 0; i < 12; i++) { if (d.movies[i]) mix.push(d.movies[i]); if (i % 2 === 0 && d.series[i / 2]) mix.push(d.series[i / 2]); }
    el.outerHTML = row('Recommended for you', mix.map(pcard), '#/discover').replace('</h2>', ' <small>not in your library</small></h2>');
  }).catch(() => {});
}

function sortItems(list, how) {
  const by = {
    added: (a, b) => b.added - a.added,
    title: (a, b) => displayTitle(a).localeCompare(displayTitle(b)),
    year: (a, b) => (b.year || 0) - (a.year || 0),
    size: (a, b) => b.size - a.size,
  }[how] || ((a, b) => b.added - a.added);
  return list.slice().sort(by);
}

// ---------- genre chips (shared by Movies / TV Shows) ----------
function genreList(list, kind) {
  const counts = {};
  for (const x of list) for (const g of (x.meta && x.meta.genres) || []) counts[g] = (counts[g] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
function genreChips(counts, active, key) {
  return `<div class="chips">${[`<button class="chip ${!active ? 'on' : ''}" data-genre="" data-gkey="${key}">All · ${counts.reduce((n, c) => n + c[1], 0)}</button>`]
    .concat(counts.map(([g, n]) => `<button class="chip ${active === g ? 'on' : ''}" data-genre="${esc(g)}" data-gkey="${key}">${esc(g)} · ${n}</button>`)).join('')}</div>`;
}
// vertical wheel over chip bar scrolls it horizontally
document.addEventListener('wheel', (e) => {
  const bar = e.target.closest('.chips');
  if (!bar || bar.scrollWidth <= bar.clientWidth) return;
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { bar.scrollLeft += e.deltaY; e.preventDefault(); }
}, { passive: false });
document.addEventListener('click', (e) => {
  const c = e.target.closest('.chip[data-genre]');
  if (!c) return;
  store.set('genre.' + c.dataset.gkey, c.dataset.genre);
  (c.dataset.gkey === 'movies' ? renderMovies : renderShows)();
});

function renderMovies() {
  const sort = store.get('sort.movies', 'added');
  const unwatched = store.get('unwatched.movies', false);
  const genre = store.get('genre.movies', '');
  const base = LIB.items.filter((i) => i.kind === 'movie' && (!unwatched || !i.progress.watched));
  const inGenre = (i) => (i.meta && i.meta.genres) || [];
  const matches = genre ? base.filter((i) => inGenre(i).includes(genre)) : base;
  const chips = genreChips(genreList(base), genre, 'movies');
  let body;
  if (genre) {
    body = matches.length ? `<div class="grid">${sortItems(matches, sort).map((i) => itemCard(i)).join('')}</div>` : `<div class="empty">Nothing in ${esc(genre)}.</div>`;
  } else {
    // All: one home-style row per genre (chip order)
    const loose = base.filter((i) => !inGenre(i).length);
    body = genreList(base).map(([g, n]) => section(g, sortItems(base.filter((i) => inGenre(i).includes(g)), sort).map((i) => itemCard(i)), `${n} titles`)).join('')
      + (loose.length ? section('Other', sortItems(loose, sort).map((i) => itemCard(i)), `${loose.length} titles`) : '');
  }
  view.innerHTML = `<div class="page"><div class="page-head"><h1>Movies</h1><span class="count-l">${matches.length}</span>
    <div class="tools"><label class="chk"><input type="checkbox" id="f-unw" ${unwatched ? 'checked' : ''}> Unwatched</label>
    <select id="f-sort">${['added:Recently added', 'title:Title', 'year:Year', 'size:File size'].map((o) => { const [v, l] = o.split(':'); return `<option value="${v}" ${v === sort ? 'selected' : ''}>${l}</option>`; }).join('')}</select></div></div>
    ${chips}
    ${body}</div>`;
  $('#f-sort').onchange = (e) => { store.set('sort.movies', e.target.value); renderMovies(); };
  $('#f-unw').onchange = (e) => { store.set('unwatched.movies', e.target.checked); renderMovies(); };
}
function renderShows() {
  const genre = store.get('genre.shows', '');
  const all = [...LIB.shows.values()].sort((a, b) => a.name.localeCompare(b.name));
  const inGenre = (s) => (s.meta && s.meta.genres) || [];
  const matches = genre ? all.filter((s) => inGenre(s).includes(genre)) : all;
  const chips = all.length ? genreChips(genreList(all), genre, 'shows') : '';
  let body;
  if (!all.length) body = `<div class="empty">No TV episodes found (files need SxxExx in the name).</div>`;
  else if (genre) body = matches.length ? `<div class="grid">${matches.map(showCard).join('')}</div>` : `<div class="empty">Nothing in ${esc(genre)}.</div>`;
  else {
    // All: one home-style row per genre (chip order)
    const loose = all.filter((s) => !inGenre(s).length);
    body = genreList(all).map(([g, n]) => section(g, all.filter((s) => inGenre(s).includes(g)).map(showCard), `${n} shows`)).join('')
      + (loose.length ? section('Other', loose.map(showCard), `${loose.length} shows`) : '');
  }
  view.innerHTML = `<div class="page"><div class="page-head"><h1>TV Shows</h1><span class="count-l">${matches.length}</span></div>
    ${chips}
    ${body}</div>`;
}
function renderCollections() {
  const colls = [...LIB.collections.entries()].filter(([, l]) => l.length >= 2).sort((a, b) => a[0].localeCompare(b[0]));
  view.innerHTML = `<div class="page"><div class="page-head"><h1>Collections</h1><span class="count-l">${colls.length}</span></div>
    <div class="grid">${colls.map(([n, l]) => collectionCard(n, l)).join('')}</div></div>`;
}

// ---------- downloads monitor ----------
let dlTimer = null;
function stopDlPoll() { if (dlTimer) { clearInterval(dlTimer); dlTimer = null; } }
function dlStatus(t) {
  if (t.error) return 'error';
  if (t.progress >= 1) return t.status === 6 ? 'seeding' : 'done';
  const m = { 0: 'stopped', 1: 'verifying', 2: 'verifying', 3: 'queued', 4: 'downloading', 5: 'queued' };
  return m[t.status] || 'downloading';
}
function dlRow(t) {
  const pct = Math.round((t.progress || 0) * 1000) / 10;
  const st = dlStatus(t);
  const speed = t.status === 4 && t.down > 0 ? (t.down / 1e6).toFixed(1) + ' MB/s' : '';
  const size = t.size ? ' · ' + fmtSize(t.size) : '';
  const err = t.error ? ` · <span class="dl-err" title="${esc(t.errorString)}">${esc(t.errorString.split('\n')[0].slice(0, 70))}</span>` : '';
  return `<div class="dl-row" data-dl-id="${t.id}">
    <div class="dl-main">
      <div class="dl-name" title="${esc(t.name)}">${esc(t.name)}</div>
      <div class="dl-meta"><span class="dl-tag dl-${esc(st.replace(/\s/g, ''))}">${st}</span>${size}${speed ? ` · <span class="dl-speed">${speed}</span>` : ''}${err}</div>
    </div>
    <div class="dl-bar"><div class="dl-fill" style="width:${pct}%"></div></div>
    <span class="dl-pct">${pct.toFixed(1)}%</span>
    <button class="btn btn-ghost dl-x" data-act="dl-x" data-id="${t.id}" title="Remove download">✕</button>
  </div>`;
}
async function renderDownloads() {
  view.innerHTML = `<div class="page"><div class="page-head"><h1>Downloads</h1><span class="count-l" id="dl-count"></span></div><div id="dl-list" class="dl-wrap"></div></div>`;
  const tick = async () => {
    if (location.hash.replace(/^#\/?/, '') !== 'downloads') { stopDlPoll(); return; }
    let list = [];
    try { list = (await api('/api/torrents')).list || []; } catch {}
    const el = $('#dl-list');
    if (!el) return;
    const head = $('#dl-count');
    if (head) head.textContent = list.length;
    el.innerHTML = list.length
      ? list.map(dlRow).join('')
      : '<div class="empty">No downloads yet — use “Get torrent” on a title.</div>';
  };
  stopDlPoll();
  await tick();
  dlTimer = setInterval(tick, 2500);
}
function renderSearch(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = (it) => [displayTitle(it), it.title, it.show, it.year, it.collection, it.file, it.meta && it.meta.genres && it.meta.genres.join(' '), it.meta && it.meta.directors.join(' '), it.meta && it.meta.stars.join(' ')].join(' ').toLowerCase();
  const match = (it) => words.every((w) => hay(it).includes(w));
  const items = LIB.items.filter((i) => i.kind !== 'episode' && match(i));
  const shows = [...LIB.shows.values()].filter((s) => words.every((w) => s.name.toLowerCase().includes(w)) || s.episodes.some(match));
  view.innerHTML = `<div class="page"><div class="page-head"><h1>Results for “${esc(q)}”</h1><span class="count-l">${items.length + shows.length}</span></div>
    ${items.length + shows.length ? `<div class="grid">${shows.map(showCard).join('')}${items.map((i) => itemCard(i)).join('')}</div>` : '<div class="empty">No matches.</div>'}</div>`;
}

// last browsed section — restored behind deep-link refreshes (#/item/…)
let LAST_VIEW = null;
try { LAST_VIEW = JSON.parse(sessionStorage.getItem('flix.view') || 'null'); } catch {}
function setLast(name, arg) {
  LAST_VIEW = { name, arg: arg ?? null };
  try { sessionStorage.setItem('flix.view', JSON.stringify(LAST_VIEW)); } catch {}
}
function restoreLast() {
  if (!LAST_VIEW) return false;
  const { name, arg } = LAST_VIEW;
  if (name === 'movies') renderMovies();
  else if (name === 'shows') renderShows();
  else if (name === 'collections') renderCollections();
  else if (name === 'discover') renderDiscover();
  else if (name === 'downloads') renderDownloads();
  else if (name === 'isearch') renderImdbSearch(arg);
  else if (name === 'search') renderSearch(arg);
  else return false;
  return true;
}

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, ...rest] = h.split('/');
  if (name === 'kids' && !KIDS.on) setKids(true);
  if (KIDS.on) {
    if (name !== 'kids') { location.replace('#/kids'); return; }
    if (rest[0] === 'search' && rest[1]) renderKidsSearch(decodeURIComponent(rest.slice(1).join('/')));
    else renderKids();
    return;
  }
  $$('.links a').forEach((a) => a.classList.toggle('active', a.dataset.route === (name || 'home')));
  stopDlPoll();
  if (name === 'movies') { setLast('movies'); renderMovies(); }
  else if (name === 'shows') { setLast('shows'); renderShows(); }
  else if (name === 'collections') { setLast('collections'); renderCollections(); }
  else if (name === 'search') { const q = decodeURIComponent(rest.join('/')); setLast('search', q); renderSearch(q); }
  else if (name === 'discover') { setLast('discover'); renderDiscover(); }
  else if (name === 'downloads') { setLast('downloads'); renderDownloads(); }
  else if (name === 'settings') { setLast('settings'); renderSettings(); }
  else if (name === 'isearch') { const q = decodeURIComponent(rest.join('/')); setLast('isearch', q); renderImdbSearch(q); }
  else if (name === 'item' && rest[0]) { if (!restoreLast()) renderHome(); openItem(decodeURIComponent(rest[0])); }
  else if (name === 'show' && rest[0]) { if (!restoreLast()) renderHome(); openShow(decodeURIComponent(rest[0]), Number(rest[1]) || undefined); }
  else { setLast(null); renderHome(); }
}

// ---------- modals ----------
const modal = $('#modal');
let modalState = null;
function openModal(html, st) {
  $('#modal-body').innerHTML = html;
  modal.hidden = false;
  modal.scrollTop = 0;
  document.body.classList.add('noscroll');
  modalState = st;
}
let NAV_CLOSE = false; // set by the hashchange handler so back/forward doesn't rewrite history
function closeModal() {
  const was = modalState && modalState.type;
  modal.hidden = true; document.body.classList.remove('noscroll'); modalState = null; stopTorrentPoll();
  const nav = NAV_CLOSE; NAV_CLOSE = false;
  if (!nav && (was === 'item' || was === 'show')) {
    const target = hashForLast();
    try { if (location.hash !== target) history.replaceState(null, '', target); } catch {}
  }
}
function hashForLast() {
  if (!LAST_VIEW || !LAST_VIEW.name) return '#/';
  return '#/' + (LAST_VIEW.name === 'search' ? 'search/' + encodeURIComponent(LAST_VIEW.arg || '') : LAST_VIEW.name);
}
function refreshModal() {
  if (!modalState) return;
  const st = modalState, top = modal.scrollTop;
  if (st.type === 'subs' && st.id) subSearchModal(st.id);
  else if (st.type === 'disc') openDisc(st.id); else if (st.type === 'item') openItem(st.id); else if (st.type === 'show') openShow(st.key, st.season); else if (st.type === 'coll') openCollection(st.name); else if (st.type === 'torrent' && st.id) { if (st.results) renderTorrentPick(st.id, st.q, st.results); else renderTorrent(st.id); }
  modal.scrollTop = top;
}

function techTable(it) {
  const v = it.video || {};
  const rows = [
    ['File', esc(it.file)], ['Size', fmtSize(it.size)], ['Duration', fmtTime(it.duration)],
    ['Video', v.codec ? `${esc(v.codec.toUpperCase())} ${v.width}×${v.height} ${esc(v.pix || '')}${v.hdr ? ' · HDR' : ''}` : '—'],
    ['Audio', it.audio.map((a) => `${esc(trackLabel(a))} (${esc(a.codec)})`).join('<br>') || '—'],
    ['Subtitles', it.subs.length ? it.subs.map((s) => esc(trackLabel(s)) + (s.text ? '' : ' <i>(image)</i>')).join(', ') : '—'],
  ];
  return `<details class="tech"><summary>Technical details</summary><table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table></details>`;
}

// ---------- IMDb search (from Discover) ----------
async function renderImdbSearch(q) {
  view.innerHTML = `<div class="page"><div class="page-head"><h1>IMDb results for “${esc(q)}”</h1><span class="count-l">Searching IMDb…</span></div></div>`;
  let results = [];
  try { results = ((await api('/api/imdbsearch?q=' + encodeURIComponent(q))).results) || []; } catch (e) {
    view.innerHTML = `<div class="page"><div class="page-head"><h1>IMDb results for “${esc(q)}”</h1></div><div class="empty">Search failed: ${esc(e.message)}</div></div>`;
    return;
  }
  if (!location.hash.startsWith('#/isearch/') || decodeURIComponent(location.hash.replace(/^#\/isearch\//, '')) !== q) return; // stale
  for (const x of results) { const prev = DISC_BY_ID.get(x.imdbId); DISC_BY_ID.set(x.imdbId, prev && prev.because ? prev : x); }
  view.innerHTML = `<div class="page discover">${results.length
    ? prow(`IMDb results for “${esc(q)}”`, results)
    : `<div class="empty">No IMDb matches for “${esc(q)}”.</div>`}</div>`;
}

// ---------- more like this ----------
function moreLike(meta, opts = {}) {
  if (!meta) return '';
  const genres = (meta.genres || []).map((v) => String(v).toLowerCase());
  const stars = new Set((meta.stars || []).map((v) => String(v).toLowerCase()));
  const dirs = new Set((meta.directors || []).map((v) => String(v).toLowerCase()));
  if (!genres.length && !stars.size && !dirs.size) return '';
  const score = (mm) => {
    let s = (mm.genres || []).filter((v) => genres.includes(String(v).toLowerCase())).length * 3;
    if (!s) return 0;
    if (stars.size) s += (mm.stars || []).filter((v) => stars.has(String(v).toLowerCase())).length * 2;
    if (dirs.size) s += (mm.directors || []).filter((v) => dirs.has(String(v).toLowerCase())).length;
    return s;
  };
  const out = [];
  const addMovie = (x) => {
    if (x.id === opts.excludeId) return;
    if (opts.excludeColl && x.collection === opts.excludeColl) return;
    const sd = score(x.meta || {});
    if (sd) out.push({ sd, html: itemCard(x) });
  };
  const addShow = (s) => {
    if (s.key === opts.excludeKey) return;
    const sd = score(s.meta || {});
    if (sd) out.push({ sd, html: showCard(s) });
  };
  if (KIDS.on) {
    kidItems().filter((x) => x.kind === 'movie').forEach(addMovie);
    kidShows().forEach(addShow);
  } else {
    LIB.items.filter((x) => x.kind === 'movie').forEach(addMovie);
    [...LIB.shows.values()].forEach(addShow);
  }
  const top = out.sort((a, b) => b.sd - a.sd).slice(0, 8).map((o) => o.html);
  return top.length ? `<div class="m-section"><h3>More like this</h3><div class="minigrid">${top.join('')}</div></div>` : '';
}

// ---------- shareable links ----------
const baseUrl = () => location.href.split('#')[0];
function setUrl(h) {
  try { if (location.hash !== '#/' + h) history.pushState(null, '', '#/' + h); } catch {}
}
function shareRow(kind, val) {
  const url = `${baseUrl()}#/${kind}/${encodeURIComponent(val)}`;
  return `<div>Link: <b><a class="sharelink" href="#/${kind}/${encodeURIComponent(val)}">#/${kind}/${esc(val)}</a></b>
    <button class="btn btn-ghost btn-sm" data-act="copy-link" data-url="${esc(url)}" title="Copy full link">Copy</button></div>`;
}

function openItem(id) {
  const it = LIB.byId.get(id);
  if (!it) return;
  if (it.kind === 'episode') return openShow(it.showKey, it.season);
  const resume = it.progress.pos > 30 && !it.progress.watched;
  const pct = resume ? it.progress.pos / it.duration : 0;
  const coll = it.collection && LIB.collections.get(it.collection);
  const langs = [...new Set(it.audio.map((a) => langName(a.lang)).filter(Boolean))];
  const bg = imgRand(it);
  openModal(`<div class="m-hero" style="${bg ? `background-image:url('${esc(bg)}')` : ''}"><div class="m-hero-body">
      <h1>${esc(displayTitle(it))}</h1>
      <div class="btns"><button class="btn btn-play" data-open="play:${it.id}">${ICON.play} ${resume ? 'Resume' : 'Play'}</button>
      ${resume ? `<button class="btn btn-ghost" data-act="restart" data-id="${it.id}">${ICON.restart} From start</button>` : ''}
      <button class="btn btn-ghost" data-act="watched" data-id="${it.id}" data-v="${it.progress.watched ? 0 : 1}">${it.progress.watched ? ICON.check + ' Watched' : ICON.plus + ' Mark watched'}</button></div>
    </div></div>
    <div class="m-body"><div class="m-cols"><div>
      <div class="metaline">${imdbScore(it.meta, true)}${it.year ? `<span>${it.year}</span>` : ''}${it.meta && it.meta.certificate ? `<span class="badge">${esc(it.meta.certificate)}</span>` : ''}<span>${fmtDur(it.duration)}</span>${resBadge(it.video)}</div>
      ${resume ? `<p class="kv"><span class="pbar"><i style="width:${pct * 100}%"></i></span> &nbsp;${fmtTime(it.duration - it.progress.pos)} remaining</p>` : ''}
      <p class="overview">${it.meta && it.meta.overview ? esc(it.meta.overview) : it.kind === 'movie' && LIB.imdb ? '<span class="kv">No IMDb match — use “Edit info” to set the IMDb ID.</span>' : ''}</p>
    </div><div class="kv">
      ${it.meta && it.meta.posterUrl ? `<img class="poster" src="${esc(it.meta.posterUrl)}" alt="">` : ''}
      ${it.meta && it.meta.genres && it.meta.genres.length ? `<div>Genres: <b>${esc(it.meta.genres.join(', '))}</b></div>` : ''}
      ${it.meta && it.meta.directors.length ? `<div>Director: <b>${esc(it.meta.directors.join(', '))}</b></div>` : ''}
      ${it.meta && it.meta.stars.length ? `<div>Starring: <b>${esc(it.meta.stars.join(', '))}</b></div>` : ''}
      ${langs.length ? `<div>Audio: <b>${esc(langs.join(', '))}</b></div>` : ''}
      ${it.subs.length ? `<div>Subtitles: <b>${esc([...new Set(it.subs.map((s) => langName(s.lang)).filter(Boolean))].slice(0, 8).join(', ')) || it.subs.length}</b></div>` : ''}
      ${KIDS.on ? '' : `<div class="sub-actions"><button class="btn btn-ghost btn-sm" data-act="sub-search" data-id="${it.id}">⬇ Find subtitles online…</button><button class="btn btn-ghost btn-sm" data-act="sub-add" data-id="${it.id}">⊕ Add from file…</button></div>`}
      ${it.collection && !KIDS.on ? `<div>Collection: <b><a href="javascript:void 0" data-open="coll:${esc(it.collection)}">${esc(it.collection)}</a></b></div>` : ''}
      ${shareRow('item', it.id)}
      ${KIDS.on ? '' : `<div><button class="btn btn-ghost btn-sm" data-act="edit" data-id="${it.id}" style="margin-top:8px">${ICON.edit} Edit info</button></div>`}
    </div></div>
    ${coll && coll.length > 1 ? `<div class="m-section"><h3>${esc(it.collection)}</h3><div class="minigrid">${coll.filter((x) => x.id !== it.id && (!KIDS.on || x.kidsSafe)).map((x) => itemCard(x)).join('')}</div></div>` : ''}
    ${moreLike(it.meta, { excludeId: it.id, excludeColl: it.collection })}
    ${KIDS.on || !(it.meta && it.meta.imdbId) ? '' : '<div class="m-section" id="mltd"><h3 class="kv">Loading more to download…</h3></div>'}
    ${KIDS.on ? '' : techTable(it)}</div>`, { type: 'item', id });
  if (!KIDS.on) setUrl('item/' + it.id);
  if (!KIDS.on && it.meta && it.meta.imdbId) loadMltd(it.meta.imdbId);
}

function openShow(key, season) {
  const s = LIB.shows.get(key);
  if (!s) return;
  const up = nextUp(s);
  season = season ?? (up ? up.season : s.seasons[0]);
  const eps = s.episodes.filter((e) => e.season === season);
  const started = s.episodes.some((e) => e.progress.updated);
  openModal(`<div class="m-hero" style="${showImg(s) ? `background-image:url('${esc(showImg(s))}')` : ''}"><div class="m-hero-body">
      <h1>${esc(s.name)}</h1>
      <div class="btns">${up ? `<button class="btn btn-play" data-open="play:${up.id}">${ICON.play} ${started ? 'Continue' : 'Play'} S${up.season} E${up.episode}</button>` : ''}</div>
    </div></div>
    <div class="m-body">
      <div class="metaline">${imdbScore(s.meta, true)}${s.meta && s.meta.year ? `<span>${s.meta.year}–${s.meta.endYear || ''}</span>` : ''}${s.meta && s.meta.certificate ? `<span class="badge">${esc(s.meta.certificate)}</span>` : ''}<span>${s.seasons.length} season${s.seasons.length > 1 ? 's' : ''} on disk</span><span>${s.episodes.length} episodes</span><span>${s.watchedCount} watched</span>${resBadge(s.episodes[0].video)}</div>
      <div class="m-cols"><div>${s.meta && s.meta.overview ? `<p class="overview">${esc(s.meta.overview)}</p>` : ''}</div><div class="kv">
        ${s.meta && s.meta.genres.length ? `<div>Genres: <b>${esc(s.meta.genres.join(', '))}</b></div>` : ''}
        ${s.meta && s.meta.directors.length ? `<div>Created by: <b>${esc(s.meta.directors.join(', '))}</b></div>` : ''}
        ${s.meta && s.meta.stars.length ? `<div>Starring: <b>${esc(s.meta.stars.join(', '))}</b></div>` : ''}
        ${shareRow('show', s.key)}
      </div></div>
      ${moreLike(s.meta, { excludeKey: s.key })}
      ${KIDS.on || !(s.meta && s.meta.imdbId) ? '' : '<div class="m-section" id="mltd"><h3 class="kv">Loading more to download…</h3></div>'}
      <div class="m-section"><h3>Episodes
        ${s.seasons.length > 1 ? `<select data-season="${esc(key)}">${s.seasons.map((n) => `<option value="${n}" ${n === season ? 'selected' : ''}>Season ${n}</option>`).join('')}</select>` : `<span class="kv">Season ${season}</span>`}
        <span class="grow"></span>
        <button class="btn btn-ghost btn-sm" data-act="season-watched" data-ids="${eps.map((e) => e.id).join(',')}" data-v="${eps.every((e) => e.progress.watched) ? 0 : 1}">${eps.every((e) => e.progress.watched) ? 'Mark season unwatched' : 'Mark season watched'}</button>
      </h3>
      ${eps.map((e) => {
        const pct = e.progress.pos && e.duration ? (e.progress.pos / e.duration) * 100 : 0;
        return `<div class="ep" data-open="play:${e.id}">
          <div class="n">${e.episode}</div>
          <div class="thumb">${e.thumb ? `<img loading="lazy" src="/api/thumb/${e.id}.jpg" alt="">` : ''}${pct ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}<div class="playhint">${ICON.play}</div></div>
          <div><div class="et"><span>${esc(epName(e))}</span><span>${e.progress.watched ? '<span class="watched">✓ Watched</span>' : ''} ${e.ep && e.ep.rating ? `<span class="ep-r">★ ${e.ep.rating.toFixed(1)}</span>` : ''} <span class="kv">${fmtDur(e.duration)}</span></span></div>
          <div class="ed">${pct ? `<b>${fmtTime(e.duration - e.progress.pos)} left</b> · ` : ''}${e.ep && e.ep.plot ? esc(e.ep.plot) : esc(e.file)}</div></div>
        </div>`;
      }).join('')}</div>
    </div>`, { type: 'show', key, season });
  if (!KIDS.on) setUrl('show/' + s.key + (season ? '/' + season : ''));
  if (!KIDS.on && s.meta && s.meta.imdbId) loadMltd(s.meta.imdbId, { allowSeries: true });
}

function openCollection(name) {
  const list = LIB.collections.get(name) || [];
  const bg = list.map(img).find(Boolean) || '';
  openModal(`<div class="m-hero" style="${bg ? `background-image:url('${esc(bg)}')` : ''}"><div class="m-hero-body"><div class="kicker">Collection</div><h1>${esc(name)}</h1>
    <div class="metaline"><span>${list.length} titles</span>${list[0] && list[0].year ? `<span>${list[0].year}–${list[list.length - 1].year || ''}</span>` : ''}</div></div></div>
    <div class="m-body"><div class="minigrid">${list.map((i) => itemCard(i)).join('')}</div></div>`, { type: 'coll', name });
}

function openEdit(id) {
  const it = LIB.byId.get(id);
  const kinds = ['movie', 'episode', 'extra', 'other'];
  openModal(`<div class="m-body" style="padding-top:30px"><h2 style="margin-top:0">Edit info</h2><p class="kv">${esc(it.file)}</p>
    <form class="form" id="edit-form">
      <label class="wide">Title<input name="title" value="${esc(it.title)}"></label>
      <label>Type<select name="kind">${kinds.map((k) => `<option ${k === it.kind ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      <label>Year<input name="year" type="number" min="1900" max="2100" value="${esc(it.year || '')}"></label>
      <label class="wide">IMDb ID or URL ${it.kind === 'episode' ? '(of the series)' : ''}<input name="imdb" value="${esc(it.imdb || (it.meta && it.meta.imdbId) || '')}" placeholder="tt0058150 — fix a wrong or missing match"></label>
      <label>Show in ${esc(SETTINGS.kidsBrand)}<select name="kids"><option value="auto" ${typeof it.kids !== 'boolean' ? 'selected' : ''}>Auto (${it.kidsSafe && typeof it.kids !== 'boolean' ? 'yes' : typeof it.kids === 'boolean' ? 'from IMDb' : 'no'})</option><option value="yes" ${it.kids === true ? 'selected' : ''}>Always</option><option value="no" ${it.kids === false ? 'selected' : ''}>Never</option></select></label>
      <label class="wide">Collection<input name="collection" list="coll-list" value="${esc(it.collection || '')}" placeholder="e.g. James Bond 007"></label>
      <datalist id="coll-list">${[...LIB.collections.keys()].map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <label>Show name (episodes)<input name="show" value="${esc(it.show || '')}"></label>
      <label>Season / Episode<span style="display:flex;gap:6px"><input name="season" type="number" min="0" value="${esc(it.season ?? '')}"><input name="episode" type="number" min="0" value="${esc(it.episode ?? '')}"></span></label>
      <div class="wide btns" style="grid-column:1/-1;margin-top:8px"><button class="btn btn-play" type="submit">Save</button>
      <button class="btn btn-ghost" type="button" data-act="edit-reset" data-id="${id}">Reset to filename</button>
      <button class="btn btn-ghost" type="button" data-open="item:${id}">Cancel</button></div>
    </form></div>`, { type: 'edit', id });
  $('#edit-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    if (f.kind === 'episode' && !f.show) return toast('Episodes need a show name');
    await api('/api/override', { id, ...f, collection: f.collection.trim() });
    await reload();
    openItem(id);
    toast('Saved');
  };
}

// ---------- more like this to download ----------
async function loadMltd(imdbId, opts = {}) {
  let list = [];
  try { list = ((await api('/api/similar/' + imdbId)).list) || []; } catch { return; }
  const box = document.getElementById('mltd');
  if (!box) return;
  const owned = new Set([...LIB.items].map((i) => i.meta && i.meta.imdbId).filter(Boolean));
  const okKind = opts.allowSeries ? (k) => k === 'series' : (k) => k === 'movie';
  const items = list.filter((x) => x && /^tt\d+$/.test(x.imdbId || '') && x.name && okKind(x.kind) && !owned.has(x.imdbId) && x.imdbId !== imdbId);
  if (!items.length) { box.remove(); return; }
  for (const x of items) { const prev = DISC_BY_ID.get(x.imdbId); DISC_BY_ID.set(x.imdbId, prev && prev.because ? prev : x); }
  box.innerHTML = `<h3>More like this to download</h3><div class="minigrid">${items.slice(0, 8).map(dlCard).join('')}</div>`;
}
function dlCard(x) {
  const yrs = x.kind === 'series' && x.endYear ? `${x.year || ''}–${x.endYear}` : x.year || '';
  return `<div class="pcard" tabindex="0" data-open="disc:${esc(x.imdbId)}" title="${esc(x.name)}">
    <div class="pimg">${x.image ? `<img loading="lazy" src="${esc(x.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<div class="ph">${esc(x.name)}</div></div>
    ${x.rating ? `<span class="pr">★ ${x.rating.toFixed(1)}</span>` : ''}
    <div class="pt">${esc(x.name)}</div><div class="ps">${esc(yrs)}</div>
    <button class="btn btn-ghost btn-sm mltd-btn" data-act="torrent" data-id="${esc(x.imdbId)}" data-name="${esc(x.name)}" data-year="${x.year || ''}">Get torrent</button>
  </div>`;
}

// ---------- global click handling ----------
document.addEventListener('click', async (e) => {
  const arrow = e.target.closest('.arrow');
  if (arrow) {
    const tr = arrow.parentElement.querySelector('.track');
    tr.scrollBy({ left: (arrow.classList.contains('l') ? -1 : 1) * tr.clientWidth * 0.85, behavior: 'smooth' });
    return;
  }
  if (e.target.closest('[data-close]')) return closeModal();
  const o = e.target.closest('[data-open]');
  if (o && !e.target.closest('[data-act]')) {
    e.preventDefault();
    const [kind, ...r] = o.dataset.open.split(':');
    const arg = r.join(':');
    if (kind === 'play') { const it = LIB.byId.get(arg); const resume = it.progress.watched ? 0 : it.progress.pos; Player.open(it, resume); }
    else if (kind === 'item') openItem(arg);
    else if (kind === 'show') openShow(arg);
    else if (kind === 'coll') openCollection(arg);
    else if (kind === 'disc') openDisc(arg);
    return;
  }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const act = a.dataset.act;
  if (act === 'restart') Player.open(LIB.byId.get(a.dataset.id), 0);
  else if (act === 'watched') { await api('/api/watched', { id: a.dataset.id, watched: a.dataset.v === '1' }); await reload(); }
  else if (act === 'season-watched') { await api('/api/watched', { ids: a.dataset.ids.split(','), watched: a.dataset.v === '1' }); await reload(); }
  else if (act === 'edit') openEdit(a.dataset.id);
  else if (act === 'wl' || act === 'dismiss') {
    const x = DISC_BY_ID.get(a.dataset.id);
    if (act === 'wl') { await api('/api/watchlist', { item: x, on: a.dataset.v === '1' }); toast(a.dataset.v === '1' ? 'Added to your watchlist' : 'Removed from watchlist'); }
    else { await api('/api/dismiss', { imdbId: a.dataset.id }); toast('Got it — we won’t suggest that again'); closeModal(); }
    await loadDiscover(true);
    if (modalState && modalState.type === 'disc') openDisc(a.dataset.id);
    const y = scrollY; route(); scrollTo(0, y);
  }
  else if (act === 'edit-reset') { await api('/api/override', { id: a.dataset.id, reset: true }); await reload(); openItem(a.dataset.id); }
  else if (act === 'sub-search') subSearchModal(a.dataset.id);
  else if (act === 'sub-add') subAddFile(a.dataset.id);
  else if (act === 'sub-dl') subDownload(a);
  else if (act === 'torrent' || act === 'torrent-retry') openTorrentPicker(a.dataset.id);
  else if (act === 'copy-link') {
    const url = a.dataset.url;
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Link copied'); } catch { toast('Copy failed — url: ' + url); }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(() => toast('Link copied')).catch(fallback);
    else fallback();
  }
  else if (act === 'dl-x') {
    await api('/api/torrents/remove', { id: Number(a.dataset.id) }).catch((e) => toast('Remove failed: ' + e.message));
    toast('Download removed');
    renderDownloads();
  }
  else if (act === 'torrent-close') closeModal();
});
document.addEventListener('click', (e) => {
  const r = e.target.closest('[data-tor]');
  if (r && !torrentBusy && modalState && modalState.type === 'torrent') {
    const res = modalState.results && modalState.results[Number(r.dataset.tor)];
    console.log('[torrent-ui] pick click:', r.dataset.tor, 'phase:', modalState.phase);
    const target = res && (res.magnet || res.url);
    if (target) startTorrent(target, modalState.id, res.name, /^[^:]+:/.exec(target || '')[0]);
  }
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.card, .pcard')) e.target.click();
  if (e.key === 'Escape' && !modal.hidden && $('#player').hidden) closeModal();
});
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-season]')) openShow(e.target.dataset.season, Number(e.target.value));
});

async function reload() {
  await loadLibrary();
  const y = scrollY;
  route();
  scrollTo(0, y);
  refreshModal();
}

// ---------- search / nav ----------
let searchT;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchT);
  searchT = setTimeout(() => {
    const q = e.target.value.trim();
    const cur = (location.hash.replace(/^#\//, '').split('/')[0]) || '';
    // On Discover / IMDb results the box searches IMDb; elsewhere it searches the library.
    const imdbSide = !KIDS.on && (cur === 'discover' || cur === 'isearch');
    if (KIDS.on) location.hash = q ? '#/kids/search/' + encodeURIComponent(q) : '#/kids';
    else if (imdbSide) location.hash = q ? '#/isearch/' + encodeURIComponent(q) : '#/discover';
    else location.hash = q ? '#/search/' + encodeURIComponent(q) : '#/';
  }, 200);
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && $('#player').hidden) { e.preventDefault(); $('#search').focus(); }
});
addEventListener('scroll', () => $('#nav').classList.toggle('solid', scrollY > 40), { passive: true });
addEventListener('hashchange', () => { NAV_CLOSE = true; closeModal(); route(); scrollTo(0, 0); });
$('#rescan').onclick = async () => {
  await api('/api/rescan', {});
  $('#rescan').classList.add('busy');
  toast('Rescanning library…');
  pollScan();
};
let pollingScan = false;
function pollScan() {
  if (pollingScan) return;
  pollingScan = true;
  const iv = setInterval(async () => {
    try { await reload(); } catch {}
    if (!LIB.scanning) { clearInterval(iv); pollingScan = false; }
  }, 4000);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.hidden = true), 2600);
}

// =====================================================================
// Player
// =====================================================================
const Player = (() => {
  const P = $('#player'), V = $('#video');
  const sid = Math.random().toString(36).slice(2, 10);
  let it = null, mode = 'direct', start = 0, audio = 0, quality = 'orig', subIndex = null;
  let cues = [], subWindows = new Map(), lastSave = 0, idleT, upNextT, loadingSeek = null, forceTranscode = false;
  const SUB_WIN = 120;
  let subsComplete = false;

  const now = () => (mode === 'direct' ? V.currentTime : start + V.currentTime);
  const dur = () => it.duration || V.duration || 0;

  function pickTracks() {
    const pa = store.get('audioLang', null);
    const a = (pa && it.audio.find((x) => x.lang === pa)) || it.audio.find((x) => x.default) || it.audio[0];
    audio = a ? a.n : 0;
    const ps = store.get('subLang', null); // null = off
    const s = ps && it.subs.find((x) => x.text && x.lang === ps && !x.forced);
    const forced = it.subs.find((x) => x.text && x.forced && (!a || x.lang === a.lang));
    subIndex = s ? s.index : forced ? forced.index : null;
  }

  async function open(item, t = 0) {
    it = item;
    quality = store.get('quality', 'orig');
    forceTranscode = false;
    pickTracks();
    P.hidden = false;
    document.body.classList.add('noscroll');
    $('#p-title').textContent = it.kind === 'episode' ? it.show : displayTitle(it);
    $('#p-sub').textContent = it.kind === 'episode' ? `Season ${it.season} · Episode ${it.episode}` + (it.ep && it.ep.title ? ` · ${epName(it)}` : '') : [it.year, fmtDur(it.duration)].filter(Boolean).join(' · ');
    $('#p-next').hidden = !nextEpisode(it);
    $('#upnext').hidden = true;
    cues = []; subWindows = new Map(); subsComplete = false; renderSubs();
    V.volume = store.get('volume', 1);
    V.muted = store.get('muted', false);
    paintVol();
    poke();
    try { await P.requestFullscreen?.(); } catch {}
    await load(t);
    if (subIndex != null) loadSubs(t);
  }

  let loadGen = 0;
  async function load(t) {
    const gen = ++loadGen;
    spin(true);
    const qs = new URLSearchParams({ t: t.toFixed(2), audio, q: quality, sid });
    if (forceTranscode) qs.set('force', 'transcode');
    const p = await api(`/api/play/${it.id}?${qs}`);
    if (gen !== loadGen) return;
    mode = p.mode;
    start = p.start || 0;
    $('#p-mode').textContent = { direct: 'Direct Play', remux: 'Direct Stream', transcode: `Transcode ${p.q}p` }[mode] || mode;
    loadingSeek = mode === 'direct' ? p.seekTo : null;
    V.src = p.url;
    V.load();
    const pl = V.play();
    if (pl) pl.catch(() => {});
  }

  V.addEventListener('loadedmetadata', () => {
    if (loadingSeek != null) { V.currentTime = loadingSeek; loadingSeek = null; }
  });
  V.addEventListener('error', () => {
    if (!it || !V.getAttribute('src')) return;
    if (!forceTranscode && mode !== 'transcode') {
      forceTranscode = true;
      const t = now();
      toast('Switching to transcoding…');
      load(t);
    } else { spin(false); toast('Playback failed — see server log'); }
  });
  V.addEventListener('waiting', () => spin(true));
  V.addEventListener('playing', () => spin(false));
  V.addEventListener('canplay', () => spin(false));
  V.addEventListener('play', paintPlay);
  V.addEventListener('pause', () => { paintPlay(); save(true); });
  V.addEventListener('timeupdate', () => {
    paintTime();
    renderSubs();
    if (Date.now() - lastSave > 10000) save();
    if (subIndex != null) ensureSubs(now());
    const nx = nextEpisode(it);
    if (nx && dur() - now() < 25 && dur() - now() > 0 && $('#upnext').hidden && !upNextT) showUpNext(nx);
  });
  V.addEventListener('ended', () => {
    save(true);
    const nx = nextEpisode(it);
    if (nx) { open(nx, 0); } else close();
  });

  function save(force) {
    if (!it || (!force && V.paused)) return;
    lastSave = Date.now();
    const pos = now();
    if (!Number.isFinite(pos) || pos < 1) return;
    api('/api/progress', { id: it.id, pos }).then((r) => { it.progress = { ...it.progress, ...r.progress }; }).catch(() => {});
  }

  function seek(t) {
    t = Math.max(0, Math.min(t, dur() - 1));
    if (mode === 'direct') { V.currentTime = t; return; }
    const rel = t - start;
    // within the already-transcoded buffer? seek locally
    for (let i = 0; i < V.buffered.length; i++) {
      if (rel >= V.buffered.start(i) && rel <= V.buffered.end(i) - 1) { V.currentTime = rel; return; }
    }
    load(t);
  }

  function close() {
    save(true);
    clearTimeout(upNextT); upNextT = null;
    V.pause();
    V.removeAttribute('src');
    V.load();
    P.hidden = true;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if ($('#modal').hidden) document.body.classList.remove('noscroll');
    it = null;
    setTimeout(reload, 400);
  }

  // ----- subtitles -----
  function parseVTT(text) {
    const out = [];
    const toS = (ts) => { const p = ts.trim().split(':').map(parseFloat); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
    for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
      const lines = block.split('\n');
      const i = lines.findIndex((l) => l.includes('-->'));
      if (i < 0) continue;
      const [a, b] = lines[i].split('-->');
      const txt = lines.slice(i + 1).join('\n').replace(/\{[^}]*\}/g, '').replace(/<(?!\/?[ib]>)[^>]+>/g, '').trim();
      if (txt) out.push({ s: toS(a), e: toS(b.trim().split(/\s/)[0]), t: txt });
    }
    return out;
  }
  async function loadSubs(t) {
    if (subIndex == null) return;
    await fetchWin(Math.floor(t / SUB_WIN));
  }
  function ensureSubs(t) {
    const w = Math.floor(t / SUB_WIN);
    if (!subWindows.has(w)) fetchWin(w);
    if (subsComplete) return;
    if (t % SUB_WIN > SUB_WIN - 40 && !subWindows.has(w + 1)) fetchWin(w + 1);
  }
  async function fetchWin(w) {
    const idx = subIndex;
    if (subWindows.has(w)) return subWindows.get(w);
    const p = fetch(`/api/subs/${it.id}/${idx}/${w}.vtt`).then((r) => {
      if (r.ok && r.headers.get('x-subs-complete')) subsComplete = true;
      return r.ok ? r.text() : '';
    }).then((txt) => {
      if (idx !== subIndex) return;
      const seen = new Set(cues.map((c) => c.s.toFixed(2) + c.t));
      for (const c of parseVTT(txt)) if (!seen.has(c.s.toFixed(2) + c.t)) cues.push(c);
      cues.sort((a, b) => a.s - b.s);
      renderSubs();
    }).catch(() => subWindows.delete(w));
    subWindows.set(w, p);
    return p;
  }
  let lastSubHtml = '';
  function renderSubs() {
    const el = $('#subs');
    let html = '';
    if (subIndex != null && it) {
      const t = now();
      html = cues.filter((c) => t >= c.s && t <= c.e).map((c) => `<span>${c.t.replace(/<(\/?)([ib])>/g, '\u0001$1$2\u0002').replace(/[&<>]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x])).replace(/\u0001(\/?)([ib])\u0002/g, '<$1$2>')}</span>`).join('<br>');
    }
    if (html !== lastSubHtml) { el.innerHTML = html; lastSubHtml = html; }
  }

  // ----- UI -----
  function spin(on) { $('#spinner').hidden = !on; }
  function paintPlay() { $('#p-play').innerHTML = V.paused ? ICON.play : ICON.pause; }
  function paintVol() {
    $('#p-mute').innerHTML = V.muted || V.volume === 0 ? ICON.mute : ICON.vol;
    $('#p-vol').value = V.muted ? 0 : V.volume;
  }
  function paintTime() {
    if (!it) return;
    const t = now(), d = dur();
    $('#p-time').textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
    const pct = d ? (t / d) * 100 : 0;
    $('#seek-fill').style.width = pct + '%';
    $('#seek-knob').style.left = pct + '%';
    let bufEnd = 0;
    for (let i = 0; i < V.buffered.length; i++) {
      const s = V.buffered.start(i), e = V.buffered.end(i);
      if (V.currentTime >= s - 0.5 && V.currentTime <= e + 0.5) bufEnd = e;
    }
    const abs = (mode === 'direct' ? 0 : start) + bufEnd;
    $('#seek-buf').style.width = (d ? Math.min(100, (abs / d) * 100) : 0) + '%';
  }
  function poke() {
    P.classList.remove('idle');
    clearTimeout(idleT);
    idleT = setTimeout(() => { if (!V.paused && $('#menu-cc').hidden && $('#menu-q').hidden) P.classList.add('idle'); }, 3000);
  }
  function toggle() { if (V.paused) V.play().catch(() => {}); else V.pause(); poke(); }

  function showUpNext(nx) {
    const box = $('#upnext');
    let n = 10;
    box.innerHTML = `<div class="un-t">Up next</div><strong>S${nx.season} E${nx.episode} · ${esc(epName(nx))}</strong>
      <div class="btns"><button class="btn btn-play btn-sm" id="un-play">${ICON.play} Play now</button><button class="btn btn-ghost btn-sm" id="un-cancel">Cancel</button></div>`;
    box.hidden = false;
    $('#un-play').onclick = () => { clearTimeout(upNextT); upNextT = null; save(true); open(nx, 0); };
    $('#un-cancel').onclick = () => { clearTimeout(upNextT); upNextT = 'cancelled'; box.hidden = true; };
    upNextT = 'shown';
  }

  function menuCC() {
    const m = $('#menu-cc');
    const audioBtns = it.audio.map((a) => `<button data-audio="${a.n}" class="${a.n === audio ? 'on' : ''}">${esc(trackLabel(a))}</button>`).join('') || '<button disabled>Default</button>';
    const subBtns = `<button data-sub="off" class="${subIndex == null ? 'on' : ''}">Off</button>` +
      it.subs.map((s) => `<button data-sub="${s.index}" class="${s.index === subIndex ? 'on' : ''}" ${s.text ? '' : 'disabled title="Image-based subtitles are not supported"'}>${esc(trackLabel(s))}${s.text ? '' : ' (image)'}</button>`).join('');
    m.innerHTML = `<div class="col"><h4>Audio</h4>${audioBtns}</div><div class="col"><h4>Subtitles</h4>${subBtns}</div>`;
  }
  function menuQ() {
    const m = $('#menu-q');
    const opts = [['orig', 'Original (best)'], ['1080', '1080p'], ['720', '720p'], ['480', '480p']];
    m.innerHTML = `<div class="col"><h4>Quality</h4>${opts.map(([v, l]) => `<button data-q="${v}" class="${String(quality) === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  }
  function toggleMenu(id, build) {
    const m = $(id);
    const other = id === '#menu-cc' ? '#menu-q' : '#menu-cc';
    $(other).hidden = true;
    if (m.hidden) { build(); m.hidden = false; } else m.hidden = true;
    poke();
  }
  $('#menu-cc').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.audio != null) {
      const n = Number(b.dataset.audio);
      if (n !== audio) {
        audio = n;
        const a = it.audio.find((x) => x.n === n);
        if (a && a.lang) store.set('audioLang', a.lang);
        load(now());
      }
    } else if (b.dataset.sub != null) {
      cues = []; subWindows = new Map(); subsComplete = false;
      if (b.dataset.sub === 'off') { subIndex = null; store.set('subLang', null); }
      else {
        subIndex = Number(b.dataset.sub);
        const s = it.subs.find((x) => x.index === subIndex);
        store.set('subLang', s && s.lang ? s.lang : null);
        loadSubs(now());
      }
      renderSubs();
    }
    menuCC();
  });
  $('#menu-q').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    quality = b.dataset.q;
    store.set('quality', quality);
    forceTranscode = false;
    $('#menu-q').hidden = true;
    load(now());
  });

  $('#p-play').onclick = toggle;
  $('#p-center').onclick = () => { if (!$('#menu-cc').hidden || !$('#menu-q').hidden) { $('#menu-cc').hidden = $('#menu-q').hidden = true; return; } toggle(); };
  $('#p-center').ondblclick = () => fs();
  $('#p-rew').onclick = () => { seek(now() - 10); poke(); };
  $('#p-fwd').onclick = () => { seek(now() + 10); poke(); };
  $('#p-back').onclick = close;
  $('#p-next').onclick = () => { const nx = nextEpisode(it); if (nx) { save(true); open(nx, 0); } };
  $('#p-cc').onclick = () => toggleMenu('#menu-cc', menuCC);
  $('#p-q').onclick = () => toggleMenu('#menu-q', menuQ);
  $('#p-fs').onclick = () => fs();
  $('#p-mute').onclick = () => { V.muted = !V.muted; store.set('muted', V.muted); paintVol(); };
  $('#p-vol').oninput = (e) => { V.volume = Number(e.target.value); V.muted = V.volume === 0; store.set('volume', V.volume); store.set('muted', V.muted); paintVol(); };
  function fs() { if (document.fullscreenElement) document.exitFullscreen(); else P.requestFullscreen?.().catch(() => {}); }
  P.addEventListener('mousemove', poke);
  P.addEventListener('touchstart', poke, { passive: true });

  // seek bar
  const bar = $('#seek');
  const posAt = (e) => { const r = bar.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  bar.addEventListener('mousemove', (e) => { const p = posAt(e); $('#seek-tip').style.left = p * 100 + '%'; $('#seek-tip').textContent = fmtTime(p * dur()); });
  let dragging = false;
  bar.addEventListener('pointerdown', (e) => { dragging = true; bar.setPointerCapture(e.pointerId); const p = posAt(e); $('#seek-fill').style.width = p * 100 + '%'; $('#seek-knob').style.left = p * 100 + '%'; });
  bar.addEventListener('pointermove', (e) => { if (!dragging) return; const p = posAt(e); $('#seek-fill').style.width = p * 100 + '%'; $('#seek-knob').style.left = p * 100 + '%'; $('#p-time').textContent = `${fmtTime(p * dur())} / ${fmtTime(dur())}`; poke(); });
  bar.addEventListener('pointerup', (e) => { if (!dragging) return; dragging = false; seek(posAt(e) * dur()); });

  document.addEventListener('keydown', (e) => {
    if (P.hidden || e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    const k = e.key;
    if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); }
    else if (k === 'ArrowLeft' || k === 'j') { e.preventDefault(); seek(now() - (k === 'j' ? 30 : 10)); poke(); }
    else if (k === 'ArrowRight' || k === 'l') { e.preventDefault(); seek(now() + (k === 'l' ? 30 : 10)); poke(); }
    else if (k === 'ArrowUp') { e.preventDefault(); V.volume = Math.min(1, V.volume + 0.05); store.set('volume', V.volume); paintVol(); poke(); }
    else if (k === 'ArrowDown') { e.preventDefault(); V.volume = Math.max(0, V.volume - 0.05); store.set('volume', V.volume); paintVol(); poke(); }
    else if (k === 'f') fs();
    else if (k === 'm') $('#p-mute').click();
    else if (k === 'n') $('#p-next').click();
    else if (k === 'c') toggleMenu('#menu-cc', menuCC);
    else if (k === 'Escape') { if (!$('#menu-cc').hidden || !$('#menu-q').hidden) { $('#menu-cc').hidden = $('#menu-q').hidden = true; } else if (!document.fullscreenElement) close(); }
  });
  addEventListener('beforeunload', () => { if (it) navigator.sendBeacon?.('/api/progress', new Blob([JSON.stringify({ id: it.id, pos: now() })], { type: 'application/json' })); });

  return { open, close };
})();

// ---------- boot ----------
(async function boot() {
  try {
    await loadLibrary();
  } catch (e) {
    view.innerHTML = `<div class="empty" style="padding-top:120px">Could not load library: ${esc(e.message)}</div>`;
    return;
  }
  setKids(KIDS.on || location.hash.startsWith('#/kids'));
  route();
  if (LIB.scanning || !LIB.items.length) pollScan();
})();
