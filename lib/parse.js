'use strict';
// Turn messy release filenames into { kind, title, year, show, season, episode, collection, part }.

const RELEASE_JUNK = /[\s._\-\[(](2160p|1080p|720p|576p|480p|4k|uhd|bluray|blu-ray|brrip|bdrip|webrip|web-dl|web|hdtv|hdrip|hdts|dvdrip|dvd|xvid|x264|x265|h\.?264|h\.?265|hevc|av1|aac[\d.]*|ac3|ddp?[\d.]*|dts|truehd|atmos|10bit|hdr|remux|repack|proper|ita|eng|sub|subs|multi|yify|rarbg|mircrew)(?=$|[\s._\-\])]).*$/i;

const EXTRA = /\b(trailer|teaser|interview|menu art|featurette|behind the scenes|visual effects in|radio adaptation|deleted scenes?|making of|bloopers?|commentary)\b/i;

const BOND_TITLES = /^(dr\.? ?no|from russia with love|goldfinger|thunderball|you only live twice|on her majesty'?s secret service|diamonds are forever|live and let die|the man with the golden gun|the with the golden gun|the spy who loved me|moonraker|for your eyes only|octopussy|never say never again|a view to a kill|the living daylights|licence to kill|goldeneye|tomorrow never dies|the world is not enough|die another day|casino royale|quantum of solace|skyfall|spectre|no time to die)$/i;

const COLLECTIONS = [
  { name: 'James Bond 007', test: (t) => BOND_TITLES.test(t) },
  { name: 'Herbie', test: (t) => /\bherbie\b|love bug/i.test(t) },
  { name: 'Star Wars', test: (t) => /\bstar[\s._-]*wars\b|\brogue[\s._-]*one\b|\bphantom[\s._-]*menace\b|\bempire[\s._-]*strikes[\s._-]*back\b|\ba[\s._-]*new[\s._-]*hope\b|\breturn[\s._-]*of[\s._-]*the[\s._-]*jedi\b|\bforce[\s._-]*awakens\b|\blast[\s._-]*jedi\b|\brise[\s._-]*of[\s._-]*skywalker\b|\bmandalorian\b/i.test(t) },
  { name: 'Jurassic World', test: (t) => /^jurassic (world|park)/i.test(t) },
  { name: 'Rurouni Kenshin', test: (t) => /^rurouni kenshin/i.test(t) },
  { name: 'Red Dawn', test: (t) => /^red dawn$/i.test(t) },
  { name: 'Fast & Furious', test: (t) => /\bfast (and|&) furious\b|^furious \d/i.test(t) },
  { name: 'Mission: Impossible', test: (t) => /^mission:? impossible/i.test(t) },
  { name: 'John Wick', test: (t) => /^john wick/i.test(t) },
  { name: 'Marvel', test: (t) => /^(ant-man|venom|the fantastic four|avengers|thor|iron man|captain america|spider-man|guardians of the galaxy)/i.test(t) },
];

function tidy(s) {
  s = s.replace(/[._]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/[\s\-–:,(\[]+$/, '').replace(/^[\s\-–:,)\]]+/, '').trim();
  if (s && s === s.toLowerCase()) s = s.replace(/\b([a-z])/g, (c) => c.toUpperCase());
  return s;
}

function collectionFor(title) {
  const c = COLLECTIONS.find((c) => c.test(title));
  return c ? c.name : '';
}

function parseName(filename) {
  const name = filename.replace(/\.[^.]+$/, '');

  // TV episode: "Show.Name.S02E05...", "show name s1e5", "Show 1x05"
  let m = /^(.*?)[\s._\-]*\b[Ss](\d{1,2})[\s._\-]?[Ee](\d{1,3})\b/.exec(name) || /^(.*?)[\s._\-]+(\d{1,2})x(\d{2,3})\b/.exec(name);
  if (m && m[1].trim()) {
    const show = tidy(m[1].replace(/[\s._\-(]((19|20)\d{2})\)?$/, ''));
    return { kind: 'episode', show, season: Number(m[2]), episode: Number(m[3]), title: `${show} S${m[2].padStart(2, '0')}E${m[3].padStart(2, '0')}` };
  }

  // Anonymous dumps like "268793--c3eb...--streamwish"
  m = /^(\d+)--[0-9a-f]{8}-/.exec(name);
  if (m) return { kind: 'other', title: `Untitled ${m[1]}`, year: null, collection: '' };

  let base = name;
  let collection = '';
  // "007.James.Bond.Goldfinger", "James.Bond.007.Octopussy"
  const bond = /^(007[\s._-]*)?(james[\s._-]*bond[\s._-]*)(007[\s._-]*)?/i.exec(base);
  if (bond && bond[0]) { base = base.slice(bond[0].length); collection = 'James Bond 007'; }
  // Numbered series prefix "03 - Title"
  base = base.replace(/^\d{1,3}\s+-\s+/, '');

  // Split into parts: "Tarzan_1_di_2", "Movie CD1", "Movie Part 2"
  let part = null;
  m = /[\s._-]+(\d)[\s._-]+(?:di|of)[\s._-]+(\d)$/i.exec(base) || /[\s._-]+(?:cd|disc|part|pt)[\s._-]?(\d)$/i.exec(base);
  if (m) { part = Number(m[1]); base = base.slice(0, m.index); }

  // Year: last plausible 4-digit year that isn't at the very start
  const yearRe = /(?:^|[\s._(\[,])((?:19[2-9]|20[0-4])\d)(?=$|[\s._)\],])/g;
  let year = null, cut = -1, ym;
  while ((ym = yearRe.exec(base))) { if (ym.index > 0) { year = Number(ym[1]); cut = ym.index; } }

  if (EXTRA.test(base)) return { kind: 'extra', title: tidy(base), year: null, collection: '' };

  let title;
  if (year) {
    title = base.slice(0, cut).replace(/\s*[(\[][^)\]]*$/, '');
  } else {
    title = base.replace(RELEASE_JUNK, '').replace(/\(\d+\)$/, '');
  }
  // "Italian title - English title" → keep the last segment
  const segs = title.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  if (segs.length > 1 && year) title = segs[segs.length - 1];
  title = tidy(title) || tidy(name);

  if (!collection) collection = collectionFor(title);
  if (part) title = `${title} (Part ${part})`;
  return { kind: 'movie', title, year, collection, part };
}

module.exports = { parseName, COLLECTIONS };
