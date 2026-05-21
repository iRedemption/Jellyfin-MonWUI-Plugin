import { requestArrEpisode, requestArrMovie } from "./api.js";

function text(value, fallback = "") {
  const out = String(value ?? "").trim();
  return out || fallback;
}

function providerId(item, ...keys) {
  const ids = item?.ProviderIds || item?.providerIds || {};
  for (const key of keys) {
    const value =
      item?.[key] ??
      ids?.[key] ??
      ids?.[key?.toUpperCase?.()] ??
      ids?.[key?.toLowerCase?.()];
    const clean = text(value);
    if (clean) return clean;
  }
  return "";
}

function tmdbId(item) {
  const direct = Number(item?.__tmdbId || item?.tmdbId || item?.TmdbId || 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const id = Number(providerId(item, "Tmdb", "TMDb", "tmdb", "MovieDb", "TheMovieDb"));
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function tvdbId(item) {
  const id = Number(providerId(item, "Tvdb", "TVDB", "tvdb"));
  return Number.isFinite(id) && id > 0 ? id : 0;
}

export async function requestSingleEpisodeFromArr({ series, episode } = {}) {
  const seasonNumber = Number(episode?.ParentIndexNumber);
  const episodeNumber = Number(episode?.IndexNumber);
  if (!Number.isFinite(seasonNumber) || seasonNumber < 0 || !Number.isFinite(episodeNumber) || episodeNumber < 0) {
    throw new Error("Arr episode fallback needs valid season and episode numbers.");
  }

  return requestArrEpisode({
    tmdbId: tmdbId(series) || undefined,
    tvdbId: tvdbId(series) || undefined,
    seasonNumber,
    episodeNumber,
    title: text(series?.Name || series?.OriginalTitle || series?.OriginalName)
  });
}

export async function requestMovieFromArr(movie = {}, options = {}) {
  const id = Number(options.tmdbId || tmdbId(movie));
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("Arr movie fallback needs a valid TMDb id.");
  }

  return requestArrMovie({
    tmdbId: id,
    title: text(options.title || movie?.Name || movie?.Title || movie?.OriginalTitle || movie?.OriginalName),
    year: Number(options.year || movie?.ProductionYear || movie?.Year || 0) || undefined
  });
}
