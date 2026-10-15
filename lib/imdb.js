'use strict';
// IMDb metadata: title search via the public suggestion endpoint, details via IMDb's GraphQL API.
// IMDb permits limited non-commercial use of this data (see the API's disclaimer) — fine for a personal library.

const GQL = 'https://caching.graphql.imdb.com/';
const HEADERS = { 'content-type': 'application/json', 'x-imdb-client-name': 'imdb-web-next', accept: 'application/json' };

const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

async function gql(query, variables) {
  const r = await fetch(GQL, { method: 'POST', headers: HEADERS, body: JSON.stringify({ query, variables }) });
  if (!r.ok) throw new Error(`IMDb GraphQL HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors && !j.data) throw new Error('IMDb GraphQL: ' + j.errors.map((e) => e.message).join('; '));
  return j.data;
}

async function search(title, year, kind) {
  const q = title.toLowerCase().replace(/\(part \d+\)/, '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!q) return null;
  const r = await fetch(`https://v2.sg.media-imdb.com/suggestion/${encodeURIComponent(q[0])}/${encodeURIComponent(q)}.json`);
  if (!r.ok) throw new Error(`IMDb search HTTP ${r.status}`);
  const d = (await r.json()).d || [];
  const types = kind === 'tv' ? ['tvSeries', 'tvMiniSeries'] : ['movie', 'tvMovie', 'video', 'tvSpecial'];
  const nt = norm(q);
  let best = null, bestScore = -Infinity;
  d.forEach((x, i) => {
    if (!x.id || !x.id.startsWith('tt') || !types.includes(x.qid)) return;
    let sc = i === 0 ? 1 : 0;
    if (year && x.y) sc += x.y === year ? 4 : Math.abs(x.y - year) <= 1 ? 2 : -4;
    const nl = norm(x.l);
    if (nl === nt) sc += 3; else if (nl.includes(nt) || nt.includes(nl)) sc += 1;
    if (sc > bestScore) { bestScore = sc; best = x; }
  });
  return best && bestScore >= 3 ? best.id : null;
}

const TITLE_FIELDS = `id titleText { text } releaseYear { year endYear } plot { plotText { plainText } }
  ratingsSummary { aggregateRating voteCount } genres { genres { text } } runtime { seconds }
  primaryImage { url } certificate { rating }
  principalCredits { category { text } credits(limit: 5) { name { nameText { text } } } }`;

function shapeTitle(t) {
  const credits = {};
  for (const pc of t.principalCredits || []) credits[pc.category.text] = pc.credits.map((c) => c.name.nameText.text);
  return {
    imdbId: t.id,
    name: t.titleText && t.titleText.text,
    year: t.releaseYear && t.releaseYear.year,
    endYear: t.releaseYear && t.releaseYear.endYear,
    overview: t.plot && t.plot.plotText ? t.plot.plotText.plainText : '',
    rating: t.ratingsSummary && t.ratingsSummary.aggregateRating,
    votes: t.ratingsSummary && t.ratingsSummary.voteCount,
    genres: t.genres ? t.genres.genres.map((g) => g.text) : [],
    runtime: t.runtime && t.runtime.seconds,
    certificate: t.certificate && t.certificate.rating,
    directors: credits.Director || credits.Directors || credits.Creator || credits.Creators || [],
    stars: credits.Stars || [],
    imageUrl: t.primaryImage && t.primaryImage.url,
  };
}

async function details(id, seasons) {
  const withEps = seasons && seasons.length;
  const query = `query ($id: ID!${withEps ? ', $seasons: [String!]' : ''}) { title(id: $id) { ${TITLE_FIELDS}
    ${withEps ? `episodes { episodes(first: 250, filter: { includeSeasons: $seasons }) { edges { node {
      id titleText { text } plot { plotText { plainText } } ratingsSummary { aggregateRating }
      series { displayableEpisodeNumber { displayableSeason { text } episodeNumber { text } } } } } } }` : ''} } }`;
  const data = await gql(query, withEps ? { id, seasons: seasons.map(String) } : { id });
  if (!data || !data.title) return null;
  const meta = shapeTitle(data.title);
  if (withEps && data.title.episodes) {
    meta.episodes = {};
    for (const { node: e } of data.title.episodes.episodes.edges) {
      const n = e.series && e.series.displayableEpisodeNumber;
      if (!n) continue;
      meta.episodes[`${Number(n.displayableSeason.text)}x${Number(n.episodeNumber.text)}`] = {
        imdbId: e.id, title: e.titleText && e.titleText.text,
        plot: e.plot && e.plot.plotText ? e.plot.plotText.plainText : '',
        rating: e.ratingsSummary && e.ratingsSummary.aggregateRating,
      };
    }
  }
  return meta;
}

// Amazon image URLs accept size modifiers: ..._V1_QL75_UX400_.jpg
const sizedImage = (url, w) => url && url.replace(/\._V1_.*$|\.jpg$/, `._V1_QL80_UX${w}_.jpg`);

// ---------- discovery ----------
const LITE = `id titleText { text } releaseYear { year endYear } titleType { id } ratingsSummary { aggregateRating voteCount }
  plot { plotText { plainText } } primaryImage { url } genres { genres { text } } runtime { seconds }`;
const SERIES_TYPES = new Set(['tvSeries', 'tvMiniSeries']);
const MOVIE_TYPES = new Set(['movie', 'tvMovie']);

function shapeLite(n) {
  const type = n.titleType && n.titleType.id;
  return {
    imdbId: n.id, name: n.titleText && n.titleText.text,
    year: n.releaseYear && n.releaseYear.year, endYear: n.releaseYear && n.releaseYear.endYear,
    kind: SERIES_TYPES.has(type) ? 'series' : MOVIE_TYPES.has(type) ? 'movie' : 'other',
    rating: n.ratingsSummary && n.ratingsSummary.aggregateRating, votes: n.ratingsSummary && n.ratingsSummary.voteCount,
    plot: n.plot && n.plot.plotText ? n.plot.plotText.plainText : '',
    image: n.primaryImage ? sizedImage(n.primaryImage.url, 300) : null,
    genres: n.genres ? n.genres.genres.map((g) => g.text) : [],
    runtime: n.runtime && n.runtime.seconds,
  };
}

// "More like this" for many titles at once, using GraphQL aliases (10 titles per request).
async function moreLikeThis(ids, n = 15) {
  const out = {};
  const valid = ids.filter((id) => /^tt\d+$/.test(id));
  for (let i = 0; i < valid.length; i += 10) {
    const chunk = valid.slice(i, i + 10);
    const q = '{ ' + chunk.map((id, j) => `t${j}: title(id: "${id}") { moreLikeThisTitles(first: ${n}) { edges { node { ${LITE} } } } }`).join(' ') + ' }';
    const data = await gql(q);
    chunk.forEach((id, j) => {
      const t = data && data[`t${j}`];
      out[id] = t && t.moreLikeThisTitles ? t.moreLikeThisTitles.edges.map((e) => shapeLite(e.node)) : [];
    });
  }
  return out;
}

// IMDb charts: MOST_POPULAR_MOVIES, MOST_POPULAR_TV_SHOWS, TOP_RATED_MOVIES, TOP_RATED_TV_SHOWS
async function chart(type, n = 100) {
  const data = await gql(`{ chartTitles(first: ${n}, chart: { chartType: ${type} }) { edges { node { ${LITE} } } } }`);
  return data.chartTitles.edges.map((e) => shapeLite(e.node));
}

// IMDb public suggestion endpoint: many results (typeahead), unlike search() which picks one.
async function suggest(q) {
  const s = String(q || '').toLowerCase().replace(/[^(part \d+)]$/i, '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!s) return [];
  const r = await fetch(`https://v2.sg.media-imdb.com/suggestion/${encodeURIComponent(s[0])}/${encodeURIComponent(s)}.json`);
  if (!r.ok) throw new Error(`IMDb suggestion HTTP ${r.status}`);
  const SERIES = new Set(['tvSeries', 'tvMiniSeries']);
  const MOVIES = new Set(['movie', 'tvMovie', 'video', 'tvSpecial']);
  const out = [];
  for (const x of (await r.json()).d || []) {
    if (!x.id || !x.id.startsWith('tt') || (!SERIES.has(x.qid) && !MOVIES.has(x.qid))) continue;
    out.push({
      imdbId: x.id,
      name: x.l,
      year: x.y || null,
      kind: SERIES.has(x.qid) ? 'series' : 'movie',
      image: x.i && x.i.imageUrl ? x.i.imageUrl.replace(/\._V1_.*$/, '._V1_QL75_UX300_.jpg') : null,
    });
  }
  return out.slice(0, 30);
}

module.exports = { search, details, sizedImage, moreLikeThis, chart, suggest };
