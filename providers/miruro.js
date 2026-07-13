/**
 * Miruro provider for Nuvio
 * ---------------------------------------------------------
 * Flow:
 *   TMDB id -> title/year (TMDB)   [Nuvio only gives us a TMDB id]
 *   title   -> AniList id          (MiruroAPI /search)
 *   AniList -> episode slug        (MiruroAPI /episodes/:id)
 *   slug    -> stream urls         (MiruroAPI /watch/:provider/:id/:cat/:slug)
 *
 * IMPORTANT (Hermes / Nuvio sandbox): no async/await, Promises + .then() only.
 */

var MIRURO_BASE = 'https://mirurotvapi.vercel.app/api';

// Public, widely-used TMDB v3 read key (same one used by most local scrapers
// in this ecosystem). Override it from the plugin's settings screen if it
// ever stops working, or swap in your own free key from themoviedb.org.
var DEFAULT_TMDB_KEY = '439c478a771f35c05022f9feabcca01';

var ALL_PROVIDERS = ['kiwi', 'pewe', 'bee', 'bonk', 'bun', 'ally', 'nun', 'twin', 'cog', 'moo', 'hop', 'telli'];

function getSettings() {
  try {
    if (typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS) return SCRAPER_SETTINGS;
    if (typeof globalThis !== 'undefined' && globalThis.SCRAPER_SETTINGS) return globalThis.SCRAPER_SETTINGS;
  } catch (e) {}
  return {};
}

function fetchJson(url, options) {
  return fetch(url, options).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return res.json();
  });
}

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---------- Step 1: TMDB id -> title/year ----------
function getTmdbDetails(tmdbId, mediaType) {
  var settings = getSettings();
  var apiKey = settings.tmdbApiKey || DEFAULT_TMDB_KEY;
  var type = mediaType === 'movie' ? 'movie' : 'tv';
  var url = 'https://api.themoviedb.org/3/' + type + '/' + tmdbId + '?api_key=' + apiKey;

  return fetchJson(url).then(function (data) {
    var title = data.title || data.name || '';
    var dateStr = data.release_date || data.first_air_date || '';
    var year = dateStr ? parseInt(dateStr.substring(0, 4), 10) : null;
    return { title: title, year: year };
  });
}

// ---------- Step 2: title -> AniList id (via Miruro search) ----------
function searchMiruro(query) {
  var url = MIRURO_BASE + '/search?query=' + encodeURIComponent(query) + '&per_page=10';
  return fetchJson(url).then(function (json) {
    return (json && json.results && json.results.results) || [];
  });
}

function pickBestMatch(results, meta) {
  if (!results || !results.length) return null;
  var target = normalize(meta.title);
  var best = null;
  var bestScore = -1;

  results.forEach(function (r) {
    var titles = [];
    if (r.title) {
      if (r.title.romaji) titles.push(r.title.romaji);
      if (r.title.english) titles.push(r.title.english);
      if (r.title.native) titles.push(r.title.native);
    }
    var score = 0;
    titles.forEach(function (t) {
      var nt = normalize(t);
      if (!nt) return;
      if (nt === target) score += 100;
      else if (nt.indexOf(target) !== -1 || target.indexOf(nt) !== -1) score += 40;
    });
    if (meta.year && r.seasonYear && Math.abs(r.seasonYear - meta.year) <= 1) score += 20;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  });

  return bestScore > 0 ? best : results[0];
}

// ---------- Step 3: AniList id -> episode slug ----------
function getEpisodeProviders(anilistId) {
  return fetchJson(MIRURO_BASE + '/episodes/' + anilistId).then(function (json) {
    return (json && json.results && json.results.providers) || {};
  });
}

function findEpisodeSlug(providersData, providerName, category, epNum) {
  var p = providersData[providerName];
  if (!p || !p.episodes) return null;
  var list = p.episodes[category];
  if (!list || !list.length) return null;
  var match = list.filter(function (e) {
    return Number(e.number) === Number(epNum);
  })[0];
  if (!match) return null;
  var parts = String(match.id).split('/');
  return parts[parts.length - 1]; // last segment is the slug Miruro expects
}

// ---------- Step 4: slug -> stream urls ----------
function getWatchStreams(provider, anilistId, category, slug) {
  var url = MIRURO_BASE + '/watch/' + provider + '/' + anilistId + '/' + category + '/' + slug;
  return fetchJson(url).then(function (json) {
    return (json && json.results && json.results.streams) || [];
  });
}

// ---------- Orchestration: try a handful of provider/category combos ----------
function buildCombos(providersData, preferredProvider, preferredCategory) {
  var available = Object.keys(providersData);
  if (!available.length) return [];

  var providerOrder = [];
  if (available.indexOf(preferredProvider) !== -1) providerOrder.push(preferredProvider);
  available.forEach(function (p) {
    if (providerOrder.indexOf(p) === -1) providerOrder.push(p);
  });

  var categoryOrder = preferredCategory === 'dub' ? ['dub', 'sub'] : ['sub', 'dub'];

  var combos = [];
  providerOrder.slice(0, 4).forEach(function (p) {
    categoryOrder.forEach(function (c) {
      combos.push([p, c]);
    });
  });
  return combos;
}

function tryCombos(combos, index, providersData, anilistId, epNum, meta, type) {
  if (index >= combos.length) return Promise.resolve([]);

  var provider = combos[index][0];
  var category = combos[index][1];
  var slug = findEpisodeSlug(providersData, provider, category, epNum);

  if (!slug) return tryCombos(combos, index + 1, providersData, anilistId, epNum, meta, type);

  return getWatchStreams(provider, anilistId, category, slug)
    .then(function (streams) {
      if (!streams || !streams.length) {
        return tryCombos(combos, index + 1, providersData, anilistId, epNum, meta, type);
      }
      return mapStreams(streams, provider, category, meta, type, epNum);
    })
    .catch(function () {
      return tryCombos(combos, index + 1, providersData, anilistId, epNum, meta, type);
    });
}

function mapStreams(streams, provider, category, meta, type, epNum) {
  var qualityRank = { '1080p': 4, '720p': 3, '480p': 2, '360p': 1 };
  var episodeLabel = type === 'movie' ? 'Movie' : 'Episode ' + epNum;

  var mapped = streams
    .filter(function (s) {
      return s.type === 'hls' && s.url;
    })
    .map(function (s) {
      var headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' };
      if (s.referer) headers['Referer'] = s.referer;

      return {
        name: 'Miruro - ' + provider + ' (' + (s.quality || 'auto') + ' ' + category.toUpperCase() + ')',
        title: meta.title + ' - ' + episodeLabel,
        url: s.url,
        quality: s.quality || 'auto',
        provider: 'miruro',
        format: 'm3u8',
        headers: headers
      };
    });

  mapped.sort(function (a, b) {
    return (qualityRank[b.quality] || 0) - (qualityRank[a.quality] || 0);
  });

  return mapped;
}

// ---------- Entry point ----------
function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var settings = getSettings();
  var preferredProvider = settings.preferredProvider || 'kiwi';
  var preferredCategory = settings.preferredAudio || 'sub';
  var type = mediaType === 'movie' ? 'movie' : 'tv';
  var epNum = type === 'movie' ? 1 : (episodeNum || 1);

  return getTmdbDetails(tmdbId, type)
    .then(function (meta) {
      if (!meta.title) return [];

      var query = meta.title;
      if (type === 'tv' && seasonNum && Number(seasonNum) > 1) {
        query = meta.title + ' Season ' + seasonNum;
      }

      return searchMiruro(query).then(function (results) {
        var best = pickBestMatch(results, meta);
        if (!best) {
          // retry with the plain title if the "Season N" query found nothing
          if (query !== meta.title) {
            return searchMiruro(meta.title).then(function (fallbackResults) {
              return { best: pickBestMatch(fallbackResults, meta), meta: meta };
            });
          }
          return { best: null, meta: meta };
        }
        return { best: best, meta: meta };
      });
    })
    .then(function (payload) {
      if (!payload || !payload.best) return [];
      var anilistId = payload.best.id;
      var meta = payload.meta;

      return getEpisodeProviders(anilistId).then(function (providersData) {
        var combos = buildCombos(providersData, preferredProvider, preferredCategory);
        if (!combos.length) return [];
        return tryCombos(combos, 0, providersData, anilistId, epNum, meta, type);
      });
    })
    .catch(function (err) {
      console.error('[Miruro] getStreams error:', err && err.message);
      return [];
    });
}

// ---------- Settings screen ----------
function onSettings() {
  return Promise.resolve([
    { type: 'header', label: 'Miruro Settings' },
    {
      type: 'select',
      key: 'preferredProvider',
      label: 'Preferred embed provider',
      description: 'Tried first; the plugin automatically falls back to other providers if this one has no stream for the episode.',
      options: ALL_PROVIDERS.map(function (p) {
        return { label: p, value: p };
      }),
      defaultValue: 'kiwi'
    },
    {
      type: 'select',
      key: 'preferredAudio',
      label: 'Preferred audio',
      description: 'Sub or dub. Falls back to the other if unavailable for an episode.',
      options: [
        { label: 'Sub', value: 'sub' },
        { label: 'Dub', value: 'dub' }
      ],
      defaultValue: 'sub'
    },
    {
      type: 'text',
      key: 'tmdbApiKey',
      label: 'TMDB API key (optional)',
      description: 'Leave blank to use the built-in shared key. Set your own free key from themoviedb.org if lookups start failing.'
    }
  ]);
}

typeof module !== 'undefined' && module.exports
  ? (module.exports = { getStreams: getStreams, onSettings: onSettings })
  : ((global.getStreams = getStreams), (global.onSettings = onSettings));
