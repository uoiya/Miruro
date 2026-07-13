# Miruro Nuvio Plugin

A standalone [Nuvio](https://github.com/NuvioMedia/NuvioTV) local scraper that pulls anime streams
(sub + dub) from the [MiruroAPI](https://github.com/MiruroTV/MiruroAPI).

## Install

1. Open **Nuvio** → **Settings → Local Scrapers**
2. Add repo URL:
   ```
   https://raw.githubusercontent.com/<your-username>/<your-repo>/main/manifest.json
   ```
3. Enable **Miruro**

## How it works

Nuvio only gives a scraper a TMDB id, so this plugin bridges TMDB → AniList → stream:

```
TMDB id  ──(TMDB API)──▶  title/year
title    ──(Miruro /search)──▶  AniList id
AniList  ──(Miruro /episodes/:id)──▶  episode slug (per provider, sub/dub)
slug     ──(Miruro /watch/:provider/:id/:cat/:slug)──▶  direct .m3u8 stream(s)
```

It tries your preferred provider/audio first (from the plugin's Settings screen),
then automatically falls back through a few other Miruro-backed providers
(`kiwi`, `pewe`, `bee`, `bonk`, ...) if the first choice has no stream for that
specific episode.

## Known limitations

- **Season matching is heuristic.** Miruro/AniList track most multi-season anime as
  *separate* AniList entries (not "Season 2" of the same entry), so for season > 1
  the plugin searches `"<title> Season <n>"` and falls back to the plain title if that
  finds nothing. For long-running or oddly-split shows this can occasionally match the
  wrong entry.
- **TMDB key**: ships with a commonly-used public TMDB v3 key as a default. If it ever
  gets rate-limited, add your own free key from themoviedb.org in the plugin's settings.
- Only `hls` (m3u8) stream entries are surfaced; Miruro's `embed` entries are skipped
  since Nuvio needs direct playable URLs.

## Files

```
manifest.json          # scraper registry Nuvio reads
providers/miruro.js     # the scraper itself (Promise-based, no async/await —
                         # required by Nuvio's Hermes sandbox)
```

## Credits

- Streams via [MiruroAPI](https://github.com/MiruroTV/MiruroAPI)
- Plugin format based on Nuvio's local scraper spec (see D3adlyRocket/All-in-One-Nuvio
  for a reference multi-provider repo)
