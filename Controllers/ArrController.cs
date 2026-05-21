using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JMSFusion.Controllers
{
    [ApiController]
    [Route("MonWUI/arr")]
    [Route("Plugins/MonWUI/arr")]
    public class ArrController : ControllerBase
    {
        private static readonly HttpClient Http = new();
        private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
        {
            WriteIndented = false
        };

        private readonly IUserManager _users;

        public ArrController(IUserManager users)
        {
            _users = users;
        }

        public sealed class ArrSettingsRequest
        {
            public bool? Enabled { get; set; }
            public bool? SonarrEnabled { get; set; }
            public string? SonarrBaseUrl { get; set; }
            public string? SonarrApiKey { get; set; }
            public string? SonarrRootFolderPath { get; set; }
            public int? SonarrQualityProfileId { get; set; }
            public int? SonarrLanguageProfileId { get; set; }
            public bool? SonarrSeasonFolder { get; set; }
            public bool? SonarrSearchOnRequest { get; set; }
            public bool? RadarrEnabled { get; set; }
            public string? RadarrBaseUrl { get; set; }
            public string? RadarrApiKey { get; set; }
            public string? RadarrRootFolderPath { get; set; }
            public int? RadarrQualityProfileId { get; set; }
            public bool? RadarrSearchOnRequest { get; set; }
        }

        public sealed class ArrEpisodeRequest
        {
            public int? TmdbId { get; set; }
            public int? TvdbId { get; set; }
            public int? SeasonNumber { get; set; }
            public int? EpisodeNumber { get; set; }
            public string? Title { get; set; }
        }

        public sealed class ArrMovieRequest
        {
            public int? TmdbId { get; set; }
            public string? Title { get; set; }
            public int? Year { get; set; }
        }

        [HttpGet("settings")]
        public IActionResult GetSettings()
        {
            var adminCheck = TryGetAdminUser();
            if (adminCheck.Result is not null)
            {
                return adminCheck.Result;
            }

            NoCache();
            return Ok(new
            {
                ok = true,
                settings = BuildSettingsPayload(GetConfig(), includeSensitive: true)
            });
        }

        [HttpPost("settings")]
        public IActionResult SaveSettings([FromBody] ArrSettingsRequest? request)
        {
            var adminCheck = TryGetAdminUser();
            if (adminCheck.Result is not null)
            {
                return adminCheck.Result;
            }

            var plugin = JMSFusionPlugin.Instance ?? throw new InvalidOperationException("Plugin not available.");
            var cfg = plugin.Configuration;

            if (request?.Enabled.HasValue == true) cfg.EnableArrIntegration = request.Enabled.Value;
            if (request?.SonarrEnabled.HasValue == true) cfg.ArrSonarrEnabled = request.SonarrEnabled.Value;
            if (request?.SonarrBaseUrl is not null) cfg.ArrSonarrBaseUrl = NormalizeBaseUrlForStorage(request.SonarrBaseUrl);
            if (request?.SonarrApiKey is not null) cfg.ArrSonarrApiKey = NormalizeSecret(request.SonarrApiKey);
            if (request?.SonarrRootFolderPath is not null) cfg.ArrSonarrRootFolderPath = CleanText(request.SonarrRootFolderPath, 500);
            if (request?.SonarrQualityProfileId.HasValue == true) cfg.ArrSonarrQualityProfileId = Math.Max(0, request.SonarrQualityProfileId.Value);
            if (request?.SonarrLanguageProfileId.HasValue == true) cfg.ArrSonarrLanguageProfileId = Math.Max(0, request.SonarrLanguageProfileId.Value);
            if (request?.SonarrSeasonFolder.HasValue == true) cfg.ArrSonarrSeasonFolder = request.SonarrSeasonFolder.Value;
            if (request?.SonarrSearchOnRequest.HasValue == true) cfg.ArrSonarrSearchOnRequest = request.SonarrSearchOnRequest.Value;
            if (request?.RadarrEnabled.HasValue == true) cfg.ArrRadarrEnabled = request.RadarrEnabled.Value;
            if (request?.RadarrBaseUrl is not null) cfg.ArrRadarrBaseUrl = NormalizeBaseUrlForStorage(request.RadarrBaseUrl);
            if (request?.RadarrApiKey is not null) cfg.ArrRadarrApiKey = NormalizeSecret(request.RadarrApiKey);
            if (request?.RadarrRootFolderPath is not null) cfg.ArrRadarrRootFolderPath = CleanText(request.RadarrRootFolderPath, 500);
            if (request?.RadarrQualityProfileId.HasValue == true) cfg.ArrRadarrQualityProfileId = Math.Max(0, request.RadarrQualityProfileId.Value);
            if (request?.RadarrSearchOnRequest.HasValue == true) cfg.ArrRadarrSearchOnRequest = request.RadarrSearchOnRequest.Value;

            plugin.UpdateConfiguration(cfg);
            NoCache();
            return Ok(new
            {
                ok = true,
                settings = BuildSettingsPayload(cfg, includeSensitive: true)
            });
        }

        [HttpPost("test")]
        public async Task<IActionResult> Test(CancellationToken cancellationToken)
            => await TestSonarr(cancellationToken);

        [HttpPost("sonarr/test")]
        public async Task<IActionResult> TestSonarr(CancellationToken cancellationToken)
        {
            var adminCheck = TryGetAdminUser();
            if (adminCheck.Result is not null)
            {
                return adminCheck.Result;
            }

            var cfg = GetConfig();
            var guard = EnsureSonarrConnectionConfigured(cfg);
            if (guard is not null) return guard;

            var status = await SendSonarrAsync(cfg, HttpMethod.Get, "/system/status", null, cancellationToken);
            if (!status.Ok)
            {
                return StatusCode(502, new { ok = false, error = status.Error, status = status.StatusCode });
            }

            var options = await FetchSonarrOptions(cfg, cancellationToken);
            NoCache();
            return Ok(new { ok = true, sonarr = status.Payload, options });
        }

        [HttpPost("radarr/test")]
        public async Task<IActionResult> TestRadarr(CancellationToken cancellationToken)
        {
            var adminCheck = TryGetAdminUser();
            if (adminCheck.Result is not null)
            {
                return adminCheck.Result;
            }

            var cfg = GetConfig();
            var guard = EnsureRadarrConnectionConfigured(cfg);
            if (guard is not null) return guard;

            var status = await SendRadarrAsync(cfg, HttpMethod.Get, "/system/status", null, cancellationToken);
            if (!status.Ok)
            {
                return StatusCode(502, new { ok = false, error = status.Error, status = status.StatusCode });
            }

            var options = await FetchRadarrOptions(cfg, cancellationToken);
            NoCache();
            return Ok(new { ok = true, radarr = status.Payload, options });
        }

        [HttpGet("sonarr/options")]
        public async Task<IActionResult> GetSonarrOptions(CancellationToken cancellationToken)
        {
            var adminCheck = TryGetAdminUser();
            if (adminCheck.Result is not null)
            {
                return adminCheck.Result;
            }

            var cfg = GetConfig();
            var guard = EnsureSonarrConnectionConfigured(cfg);
            if (guard is not null) return guard;

            var options = await FetchSonarrOptions(cfg, cancellationToken);
            NoCache();
            return Ok(new { ok = true, options });
        }

        [HttpGet("radarr/options")]
        public async Task<IActionResult> GetRadarrOptions(CancellationToken cancellationToken)
        {
            var adminCheck = TryGetAdminUser();
            if (adminCheck.Result is not null)
            {
                return adminCheck.Result;
            }

            var cfg = GetConfig();
            var guard = EnsureRadarrConnectionConfigured(cfg);
            if (guard is not null) return guard;

            var options = await FetchRadarrOptions(cfg, cancellationToken);
            NoCache();
            return Ok(new { ok = true, options });
        }

        [HttpPost("episode")]
        public async Task<IActionResult> RequestEpisode([FromBody] ArrEpisodeRequest? request, CancellationToken cancellationToken)
        {
            var adminCheck = TryGetAdminUser();
            if (adminCheck.Result is not null)
            {
                return adminCheck.Result;
            }

            var cfg = GetConfig();
            var guard = EnsureSonarrRequestConfigured(cfg);
            if (guard is not null) return guard;

            var seasonNumber = request?.SeasonNumber ?? -1;
            var episodeNumber = request?.EpisodeNumber ?? -1;
            if (seasonNumber < 0 || seasonNumber > 1000 || episodeNumber < 0 || episodeNumber > 10000)
            {
                return BadRequest(new { ok = false, error = "Valid seasonNumber and episodeNumber are required." });
            }

            if ((request?.TvdbId ?? 0) <= 0 && (request?.TmdbId ?? 0) <= 0 && string.IsNullOrWhiteSpace(request?.Title))
            {
                return BadRequest(new { ok = false, error = "tvdbId, tmdbId or title is required." });
            }

            var result = await RequestSonarrEpisode(cfg, request!, cancellationToken);
            if (!result.Ok)
            {
                return StatusCode(502, new { ok = false, error = result.Error, status = result.StatusCode });
            }

            NoCache();
            return Ok(new
            {
                ok = true,
                service = "sonarr",
                seriesId = result.SeriesId,
                episodeId = result.EpisodeId,
                commandId = result.CommandId,
                addedSeries = result.AddedSeries
            });
        }

        [HttpPost("movie")]
        public async Task<IActionResult> RequestMovie([FromBody] ArrMovieRequest? request, CancellationToken cancellationToken)
        {
            var adminCheck = TryGetAdminUser();
            if (adminCheck.Result is not null)
            {
                return adminCheck.Result;
            }

            var cfg = GetConfig();
            var guard = EnsureRadarrRequestConfigured(cfg);
            if (guard is not null) return guard;

            if ((request?.TmdbId ?? 0) <= 0 && string.IsNullOrWhiteSpace(request?.Title))
            {
                return BadRequest(new { ok = false, error = "tmdbId or title is required." });
            }

            var result = await RequestRadarrMovie(cfg, request!, cancellationToken);
            if (!result.Ok)
            {
                return StatusCode(502, new { ok = false, error = result.Error, status = result.StatusCode });
            }

            NoCache();
            return Ok(new
            {
                ok = true,
                service = "radarr",
                movieId = result.MovieId,
                commandId = result.CommandId,
                addedMovie = result.AddedMovie
            });
        }

        private async Task<object> FetchSonarrOptions(JMSFusionConfiguration cfg, CancellationToken cancellationToken)
        {
            var qualityProfiles = await ReadSonarrOptionList(
                cfg,
                "/qualityprofile",
                cancellationToken,
                item => new
                {
                    id = ReadIntValue(item, "id"),
                    name = ReadString(item, "name")
                });

            var rootFolders = await ReadSonarrOptionList(
                cfg,
                "/rootfolder",
                cancellationToken,
                item => new
                {
                    id = ReadIntValue(item, "id"),
                    path = ReadString(item, "path"),
                    freeSpace = ReadLongValue(item, "freeSpace")
                });

            var languageProfiles = await ReadSonarrOptionList(
                cfg,
                "/languageprofile",
                cancellationToken,
                item => new
                {
                    id = ReadIntValue(item, "id"),
                    name = ReadString(item, "name")
                });

            return new
            {
                qualityProfiles,
                rootFolders,
                languageProfiles
            };
        }

        private async Task<List<T>> ReadSonarrOptionList<T>(
            JMSFusionConfiguration cfg,
            string path,
            CancellationToken cancellationToken,
            Func<JsonElement, T> map)
        {
            var response = await SendSonarrAsync(cfg, HttpMethod.Get, path, null, cancellationToken);
            if (!response.Ok || response.Payload.ValueKind != JsonValueKind.Array) return new List<T>();
            return response.Payload.EnumerateArray()
                .Where(item => item.ValueKind == JsonValueKind.Object)
                .Select(map)
                .ToList();
        }

        private async Task<object> FetchRadarrOptions(JMSFusionConfiguration cfg, CancellationToken cancellationToken)
        {
            var qualityProfiles = await ReadRadarrOptionList(
                cfg,
                "/qualityprofile",
                cancellationToken,
                item => new
                {
                    id = ReadIntValue(item, "id"),
                    name = ReadString(item, "name")
                });

            var rootFolders = await ReadRadarrOptionList(
                cfg,
                "/rootfolder",
                cancellationToken,
                item => new
                {
                    id = ReadIntValue(item, "id"),
                    path = ReadString(item, "path"),
                    freeSpace = ReadLongValue(item, "freeSpace")
                });

            return new
            {
                qualityProfiles,
                rootFolders
            };
        }

        private async Task<List<T>> ReadRadarrOptionList<T>(
            JMSFusionConfiguration cfg,
            string path,
            CancellationToken cancellationToken,
            Func<JsonElement, T> map)
        {
            var response = await SendRadarrAsync(cfg, HttpMethod.Get, path, null, cancellationToken);
            if (!response.Ok || response.Payload.ValueKind != JsonValueKind.Array) return new List<T>();
            return response.Payload.EnumerateArray()
                .Where(item => item.ValueKind == JsonValueKind.Object)
                .Select(map)
                .ToList();
        }

        private async Task<SonarrEpisodeResult> RequestSonarrEpisode(JMSFusionConfiguration cfg, ArrEpisodeRequest request, CancellationToken cancellationToken)
        {
            var series = await FindSonarrSeries(cfg, request, cancellationToken);
            var addedSeries = false;
            if (series.ValueKind != JsonValueKind.Object)
            {
                var lookup = await LookupSonarrSeries(cfg, request, cancellationToken);
                if (lookup.ValueKind != JsonValueKind.Object)
                {
                    return SonarrEpisodeResult.Fail(404, "Series was not found in Sonarr lookup.");
                }

                var addResult = await AddSonarrSeries(cfg, lookup, request.SeasonNumber ?? 0, cancellationToken);
                if (!addResult.Ok) return SonarrEpisodeResult.Fail(addResult.StatusCode, addResult.Error);
                series = addResult.Payload;
                addedSeries = true;
            }

            if (!TryReadInt(series, "id", out var seriesId) || seriesId <= 0)
            {
                return SonarrEpisodeResult.Fail(502, "Sonarr did not return a valid series id.");
            }

            var updateResult = await EnsureSonarrSeriesMonitored(cfg, series, request.SeasonNumber ?? 0, cancellationToken);
            if (updateResult.Ok && updateResult.Payload.ValueKind == JsonValueKind.Object)
            {
                series = updateResult.Payload;
            }

            var episode = await FindSonarrEpisode(cfg, seriesId, request.SeasonNumber ?? 0, request.EpisodeNumber ?? 0, cancellationToken);
            if (episode.ValueKind != JsonValueKind.Object && addedSeries)
            {
                await SendSonarrAsync(cfg, HttpMethod.Post, "/command", new Dictionary<string, object?>
                {
                    ["name"] = "RefreshSeries",
                    ["seriesId"] = seriesId
                }, cancellationToken);
                await Task.Delay(1200, cancellationToken);
                episode = await FindSonarrEpisode(cfg, seriesId, request.SeasonNumber ?? 0, request.EpisodeNumber ?? 0, cancellationToken);
            }

            if (episode.ValueKind != JsonValueKind.Object || !TryReadInt(episode, "id", out var episodeId) || episodeId <= 0)
            {
                return SonarrEpisodeResult.Fail(404, "Episode was not found in Sonarr after adding or locating the series.");
            }

            var monitor = await SendSonarrAsync(cfg, HttpMethod.Put, "/episode/monitor", new Dictionary<string, object?>
            {
                ["episodeIds"] = new[] { episodeId },
                ["monitored"] = true
            }, cancellationToken);
            if (!monitor.Ok) return SonarrEpisodeResult.Fail(monitor.StatusCode, monitor.Error);

            int? commandId = null;
            if (cfg.ArrSonarrSearchOnRequest)
            {
                var command = await SendSonarrAsync(cfg, HttpMethod.Post, "/command", new Dictionary<string, object?>
                {
                    ["name"] = "EpisodeSearch",
                    ["episodeIds"] = new[] { episodeId }
                }, cancellationToken);
                if (!command.Ok) return SonarrEpisodeResult.Fail(command.StatusCode, command.Error);
                if (TryReadInt(command.Payload, "id", out var id)) commandId = id;
            }

            return SonarrEpisodeResult.Success(seriesId, episodeId, commandId, addedSeries);
        }

        private async Task<JsonElement> FindSonarrSeries(JMSFusionConfiguration cfg, ArrEpisodeRequest request, CancellationToken cancellationToken)
        {
            var response = await SendSonarrAsync(cfg, HttpMethod.Get, "/series", null, cancellationToken);
            if (!response.Ok || response.Payload.ValueKind != JsonValueKind.Array) return default;

            foreach (var item in response.Payload.EnumerateArray())
            {
                if (request.TvdbId.HasValue && request.TvdbId.Value > 0 &&
                    TryReadInt(item, "tvdbId", out var tvdbId) && tvdbId == request.TvdbId.Value)
                {
                    return item.Clone();
                }

                var title = CleanKey(request.Title);
                if (!string.IsNullOrWhiteSpace(title) &&
                    string.Equals(CleanKey(ReadString(item, "title")), title, StringComparison.OrdinalIgnoreCase))
                {
                    return item.Clone();
                }
            }

            return default;
        }

        private async Task<JsonElement> LookupSonarrSeries(JMSFusionConfiguration cfg, ArrEpisodeRequest request, CancellationToken cancellationToken)
        {
            var terms = new List<string>();
            if (request.TvdbId.HasValue && request.TvdbId.Value > 0) terms.Add("tvdb:" + request.TvdbId.Value.ToString(CultureInfo.InvariantCulture));
            if (request.TmdbId.HasValue && request.TmdbId.Value > 0) terms.Add("tmdb:" + request.TmdbId.Value.ToString(CultureInfo.InvariantCulture));
            if (!string.IsNullOrWhiteSpace(request.Title)) terms.Add(request.Title!);

            foreach (var term in terms.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                var response = await SendSonarrAsync(cfg, HttpMethod.Get, "/series/lookup?term=" + Uri.EscapeDataString(term), null, cancellationToken);
                if (!response.Ok || response.Payload.ValueKind != JsonValueKind.Array) continue;
                foreach (var item in response.Payload.EnumerateArray())
                {
                    if (request.TvdbId.HasValue && request.TvdbId.Value > 0 &&
                        TryReadInt(item, "tvdbId", out var tvdbId) && tvdbId == request.TvdbId.Value)
                    {
                        return item.Clone();
                    }
                }

                var first = response.Payload.EnumerateArray().FirstOrDefault();
                if (first.ValueKind == JsonValueKind.Object) return first.Clone();
            }

            return default;
        }

        private async Task<ArrCallResult> AddSonarrSeries(JMSFusionConfiguration cfg, JsonElement lookup, int seasonNumber, CancellationToken cancellationToken)
        {
            var body = JsonSerializer.Deserialize<Dictionary<string, object?>>(lookup.GetRawText(), JsonOptions) ?? new Dictionary<string, object?>();
            body["qualityProfileId"] = cfg.ArrSonarrQualityProfileId;
            if (cfg.ArrSonarrLanguageProfileId > 0) body["languageProfileId"] = cfg.ArrSonarrLanguageProfileId;
            body["rootFolderPath"] = cfg.ArrSonarrRootFolderPath;
            body["monitored"] = true;
            body["seasonFolder"] = cfg.ArrSonarrSeasonFolder;
            body["seasons"] = BuildSeasonMonitorPayload(lookup, seasonNumber);
            body["addOptions"] = new Dictionary<string, object?>
            {
                ["searchForMissingEpisodes"] = false
            };

            return await SendSonarrAsync(cfg, HttpMethod.Post, "/series", body, cancellationToken);
        }

        private async Task<ArrCallResult> EnsureSonarrSeriesMonitored(JMSFusionConfiguration cfg, JsonElement series, int seasonNumber, CancellationToken cancellationToken)
        {
            if (!TryReadInt(series, "id", out var seriesId) || seriesId <= 0) return ArrCallResult.Fail(0, "Invalid series id.");

            var body = JsonSerializer.Deserialize<Dictionary<string, object?>>(series.GetRawText(), JsonOptions) ?? new Dictionary<string, object?>();
            body["monitored"] = true;
            body["seasons"] = BuildSeasonMonitorPayload(series, seasonNumber, preserveExisting: true);
            return await SendSonarrAsync(cfg, HttpMethod.Put, "/series/" + seriesId.ToString(CultureInfo.InvariantCulture), body, cancellationToken);
        }

        private async Task<JsonElement> FindSonarrEpisode(JMSFusionConfiguration cfg, int seriesId, int seasonNumber, int episodeNumber, CancellationToken cancellationToken)
        {
            var response = await SendSonarrAsync(cfg, HttpMethod.Get, "/episode?seriesId=" + seriesId.ToString(CultureInfo.InvariantCulture), null, cancellationToken);
            if (!response.Ok || response.Payload.ValueKind != JsonValueKind.Array) return default;

            foreach (var item in response.Payload.EnumerateArray())
            {
                if (TryReadInt(item, "seasonNumber", out var season) &&
                    TryReadInt(item, "episodeNumber", out var episode) &&
                    season == seasonNumber &&
                    episode == episodeNumber)
                {
                    return item.Clone();
                }
            }

            return default;
        }

        private static List<Dictionary<string, object?>> BuildSeasonMonitorPayload(JsonElement source, int targetSeason, bool preserveExisting = false)
        {
            var output = new List<Dictionary<string, object?>>();
            if (source.ValueKind == JsonValueKind.Object && source.TryGetProperty("seasons", out var seasons) && seasons.ValueKind == JsonValueKind.Array)
            {
                foreach (var season in seasons.EnumerateArray())
                {
                    if (!TryReadInt(season, "seasonNumber", out var seasonNumber)) continue;
                    var row = JsonSerializer.Deserialize<Dictionary<string, object?>>(season.GetRawText(), JsonOptions) ?? new Dictionary<string, object?>();
                    var monitored = seasonNumber == targetSeason || (preserveExisting && ReadBool(season, "monitored"));
                    row["seasonNumber"] = seasonNumber;
                    row["monitored"] = monitored;
                    output.Add(row);
                }
            }

            if (!output.Any(row => Convert.ToInt32(row["seasonNumber"], CultureInfo.InvariantCulture) == targetSeason))
            {
                output.Add(new Dictionary<string, object?>
                {
                    ["seasonNumber"] = targetSeason,
                    ["monitored"] = true
                });
            }

            return output;
        }

        private async Task<RadarrMovieResult> RequestRadarrMovie(JMSFusionConfiguration cfg, ArrMovieRequest request, CancellationToken cancellationToken)
        {
            var movie = await FindRadarrMovie(cfg, request, cancellationToken);
            var addedMovie = false;
            if (movie.ValueKind != JsonValueKind.Object)
            {
                var lookup = await LookupRadarrMovie(cfg, request, cancellationToken);
                if (lookup.ValueKind != JsonValueKind.Object)
                {
                    return RadarrMovieResult.Fail(404, "Movie was not found in Radarr lookup.");
                }

                var addResult = await AddRadarrMovie(cfg, lookup, cancellationToken);
                if (!addResult.Ok) return RadarrMovieResult.Fail(addResult.StatusCode, addResult.Error);
                movie = addResult.Payload;
                addedMovie = true;
            }

            if (!TryReadInt(movie, "id", out var movieId) || movieId <= 0)
            {
                return RadarrMovieResult.Fail(502, "Radarr did not return a valid movie id.");
            }

            var updateResult = await EnsureRadarrMovieMonitored(cfg, movie, cancellationToken);
            if (!updateResult.Ok) return RadarrMovieResult.Fail(updateResult.StatusCode, updateResult.Error);
            if (updateResult.Payload.ValueKind == JsonValueKind.Object)
            {
                movie = updateResult.Payload;
            }

            int? commandId = null;
            if (cfg.ArrRadarrSearchOnRequest)
            {
                var command = await SendRadarrAsync(cfg, HttpMethod.Post, "/command", new Dictionary<string, object?>
                {
                    ["name"] = "MoviesSearch",
                    ["movieIds"] = new[] { movieId }
                }, cancellationToken);
                if (!command.Ok) return RadarrMovieResult.Fail(command.StatusCode, command.Error);
                if (TryReadInt(command.Payload, "id", out var id)) commandId = id;
            }

            return RadarrMovieResult.Success(movieId, commandId, addedMovie);
        }

        private async Task<JsonElement> FindRadarrMovie(JMSFusionConfiguration cfg, ArrMovieRequest request, CancellationToken cancellationToken)
        {
            var response = await SendRadarrAsync(cfg, HttpMethod.Get, "/movie", null, cancellationToken);
            if (!response.Ok || response.Payload.ValueKind != JsonValueKind.Array) return default;

            var requestedTitle = CleanKey(request.Title);
            foreach (var item in response.Payload.EnumerateArray())
            {
                if (request.TmdbId.HasValue && request.TmdbId.Value > 0 &&
                    TryReadInt(item, "tmdbId", out var tmdbId) && tmdbId == request.TmdbId.Value)
                {
                    return item.Clone();
                }

                if (!string.IsNullOrWhiteSpace(requestedTitle) &&
                    string.Equals(CleanKey(ReadString(item, "title")), requestedTitle, StringComparison.OrdinalIgnoreCase) &&
                    MatchesYear(item, request.Year))
                {
                    return item.Clone();
                }
            }

            return default;
        }

        private async Task<JsonElement> LookupRadarrMovie(JMSFusionConfiguration cfg, ArrMovieRequest request, CancellationToken cancellationToken)
        {
            if (request.TmdbId.HasValue && request.TmdbId.Value > 0)
            {
                var byTmdb = await SendRadarrAsync(
                    cfg,
                    HttpMethod.Get,
                    "/movie/lookup/tmdb?tmdbId=" + request.TmdbId.Value.ToString(CultureInfo.InvariantCulture),
                    null,
                    cancellationToken);
                if (byTmdb.Ok && byTmdb.Payload.ValueKind == JsonValueKind.Object)
                {
                    return byTmdb.Payload.Clone();
                }
            }

            var terms = new List<string>();
            if (request.TmdbId.HasValue && request.TmdbId.Value > 0) terms.Add("tmdb:" + request.TmdbId.Value.ToString(CultureInfo.InvariantCulture));
            if (!string.IsNullOrWhiteSpace(request.Title)) terms.Add(request.Title!);

            foreach (var term in terms.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                var response = await SendRadarrAsync(cfg, HttpMethod.Get, "/movie/lookup?term=" + Uri.EscapeDataString(term), null, cancellationToken);
                if (!response.Ok || response.Payload.ValueKind != JsonValueKind.Array) continue;

                foreach (var item in response.Payload.EnumerateArray())
                {
                    if (request.TmdbId.HasValue && request.TmdbId.Value > 0 &&
                        TryReadInt(item, "tmdbId", out var tmdbId) && tmdbId == request.TmdbId.Value)
                    {
                        return item.Clone();
                    }
                }

                var requestedTitle = CleanKey(request.Title);
                foreach (var item in response.Payload.EnumerateArray())
                {
                    if (!string.IsNullOrWhiteSpace(requestedTitle) &&
                        string.Equals(CleanKey(ReadString(item, "title")), requestedTitle, StringComparison.OrdinalIgnoreCase) &&
                        MatchesYear(item, request.Year))
                    {
                        return item.Clone();
                    }
                }

                var first = response.Payload.EnumerateArray().FirstOrDefault();
                if (first.ValueKind == JsonValueKind.Object) return first.Clone();
            }

            return default;
        }

        private async Task<ArrCallResult> AddRadarrMovie(JMSFusionConfiguration cfg, JsonElement lookup, CancellationToken cancellationToken)
        {
            var validation = await ValidateRadarrMovieRequestConfig(cfg, cancellationToken);
            if (!validation.Ok) return validation;

            var body = JsonSerializer.Deserialize<Dictionary<string, object?>>(lookup.GetRawText(), JsonOptions) ?? new Dictionary<string, object?>();
            PrepareRadarrAddMovieBody(body, cfg);

            var result = await SendRadarrAsync(cfg, HttpMethod.Post, "/movie", body, cancellationToken);
            if (result.Ok || !IsRadarrSequenceError(result.Error)) return result;

            var minimal = BuildMinimalRadarrAddMovieBody(lookup, cfg);
            return await SendRadarrAsync(cfg, HttpMethod.Post, "/movie", minimal, cancellationToken);
        }

        private async Task<ArrCallResult> ValidateRadarrMovieRequestConfig(JMSFusionConfiguration cfg, CancellationToken cancellationToken)
        {
            var profiles = await SendRadarrAsync(cfg, HttpMethod.Get, "/qualityprofile", null, cancellationToken);
            if (!profiles.Ok) return profiles;
            if (profiles.Payload.ValueKind == JsonValueKind.Array &&
                !profiles.Payload.EnumerateArray().Any(profile => TryReadInt(profile, "id", out var id) && id == cfg.ArrRadarrQualityProfileId))
            {
                return ArrCallResult.Fail(412, "Radarr quality profile is not valid anymore. Test the Radarr connection and save a valid quality profile.");
            }

            var roots = await SendRadarrAsync(cfg, HttpMethod.Get, "/rootfolder", null, cancellationToken);
            if (!roots.Ok) return roots;
            var configuredRoot = NormalizeArrPath(cfg.ArrRadarrRootFolderPath);
            if (roots.Payload.ValueKind == JsonValueKind.Array &&
                !roots.Payload.EnumerateArray().Any(root => string.Equals(NormalizeArrPath(ReadString(root, "path")), configuredRoot, StringComparison.OrdinalIgnoreCase)))
            {
                return ArrCallResult.Fail(412, "Radarr root folder is not valid anymore. Test the Radarr connection and save a valid root folder.");
            }

            return ArrCallResult.Success(200, default);
        }

        private static void PrepareRadarrAddMovieBody(Dictionary<string, object?> body, JMSFusionConfiguration cfg)
        {
            foreach (var key in new[]
            {
                "id",
                "movieFile",
                "movieFileId",
                "path",
                "sizeOnDisk",
                "hasFile",
                "downloaded",
                "status",
                "statistics"
            })
            {
                body.Remove(key);
            }

            body["qualityProfileId"] = cfg.ArrRadarrQualityProfileId;
            body["rootFolderPath"] = cfg.ArrRadarrRootFolderPath;
            body["monitored"] = true;
            if (!body.ContainsKey("minimumAvailability") || body["minimumAvailability"] is null) body["minimumAvailability"] = "announced";
            if (!body.ContainsKey("tags") || body["tags"] is null) body["tags"] = Array.Empty<int>();
            body["addOptions"] = new Dictionary<string, object?>
            {
                ["searchForMovie"] = false
            };
        }

        private static Dictionary<string, object?> BuildMinimalRadarrAddMovieBody(JsonElement lookup, JMSFusionConfiguration cfg)
        {
            var body = new Dictionary<string, object?>();
            foreach (var property in new[]
            {
                "title",
                "originalTitle",
                "sortTitle",
                "tmdbId",
                "imdbId",
                "year",
                "overview",
                "images",
                "website",
                "youTubeTrailerId",
                "studio",
                "runtime",
                "certification",
                "genres",
                "ratings",
                "titleSlug",
                "cleanTitle"
            })
            {
                CopyJsonProperty(lookup, body, property);
            }

            PrepareRadarrAddMovieBody(body, cfg);
            return body;
        }

        private static void CopyJsonProperty(JsonElement source, Dictionary<string, object?> target, string property)
        {
            if (source.ValueKind != JsonValueKind.Object || !source.TryGetProperty(property, out var value)) return;
            target[property] = value.Clone();
        }

        private async Task<ArrCallResult> EnsureRadarrMovieMonitored(JMSFusionConfiguration cfg, JsonElement movie, CancellationToken cancellationToken)
        {
            if (!TryReadInt(movie, "id", out var movieId) || movieId <= 0) return ArrCallResult.Fail(0, "Invalid movie id.");
            if (ReadBool(movie, "monitored")) return ArrCallResult.Success(200, movie);

            var body = JsonSerializer.Deserialize<Dictionary<string, object?>>(movie.GetRawText(), JsonOptions) ?? new Dictionary<string, object?>();
            body["monitored"] = true;
            return await SendRadarrAsync(cfg, HttpMethod.Put, "/movie/" + movieId.ToString(CultureInfo.InvariantCulture), body, cancellationToken);
        }

        private IActionResult? EnsureSonarrConnectionConfigured(JMSFusionConfiguration cfg)
        {
            if (string.IsNullOrWhiteSpace(cfg.ArrSonarrBaseUrl) || string.IsNullOrWhiteSpace(cfg.ArrSonarrApiKey))
            {
                return StatusCode(412, new { ok = false, error = "Sonarr URL and API key are required." });
            }

            return null;
        }

        private IActionResult? EnsureRadarrConnectionConfigured(JMSFusionConfiguration cfg)
        {
            if (string.IsNullOrWhiteSpace(cfg.ArrRadarrBaseUrl) || string.IsNullOrWhiteSpace(cfg.ArrRadarrApiKey))
            {
                return StatusCode(412, new { ok = false, error = "Radarr URL and API key are required." });
            }

            return null;
        }

        private IActionResult? EnsureRadarrRequestConfigured(JMSFusionConfiguration cfg)
        {
            if (!cfg.EnableArrIntegration || !cfg.ArrRadarrEnabled)
            {
                return StatusCode(403, new { ok = false, error = "Arr/Radarr integration is disabled." });
            }

            var connectionError = EnsureRadarrConnectionConfigured(cfg);
            if (connectionError is not null) return connectionError;

            if (string.IsNullOrWhiteSpace(cfg.ArrRadarrRootFolderPath) || cfg.ArrRadarrQualityProfileId <= 0)
            {
                return StatusCode(412, new { ok = false, error = "Radarr root folder path and quality profile id are required." });
            }

            return null;
        }

        private IActionResult? EnsureSonarrRequestConfigured(JMSFusionConfiguration cfg)
        {
            if (!cfg.EnableArrIntegration || !cfg.ArrSonarrEnabled)
            {
                return StatusCode(403, new { ok = false, error = "Arr/Sonarr integration is disabled." });
            }

            var connectionError = EnsureSonarrConnectionConfigured(cfg);
            if (connectionError is not null) return connectionError;

            if (string.IsNullOrWhiteSpace(cfg.ArrSonarrRootFolderPath) || cfg.ArrSonarrQualityProfileId <= 0)
            {
                return StatusCode(412, new { ok = false, error = "Sonarr root folder path and quality profile id are required." });
            }

            return null;
        }

        private async Task<ArrCallResult> SendSonarrAsync(JMSFusionConfiguration cfg, HttpMethod method, string pathAndQuery, object? body, CancellationToken cancellationToken)
            => await SendArrAsync(cfg.ArrSonarrBaseUrl, cfg.ArrSonarrApiKey, "Sonarr", method, pathAndQuery, body, cancellationToken);

        private async Task<ArrCallResult> SendRadarrAsync(JMSFusionConfiguration cfg, HttpMethod method, string pathAndQuery, object? body, CancellationToken cancellationToken)
            => await SendArrAsync(cfg.ArrRadarrBaseUrl, cfg.ArrRadarrApiKey, "Radarr", method, pathAndQuery, body, cancellationToken);

        private async Task<ArrCallResult> SendArrAsync(string baseUrl, string apiKey, string serviceName, HttpMethod method, string pathAndQuery, object? body, CancellationToken cancellationToken)
        {
            try
            {
                var apiBase = BuildArrApiBase(baseUrl);
                if (apiBase is null) return ArrCallResult.Fail(400, "Invalid " + serviceName + " URL.");

                var relative = pathAndQuery.TrimStart('/');
                using var request = new HttpRequestMessage(method, new Uri(apiBase, relative));
                request.Headers.TryAddWithoutValidation("X-Api-Key", apiKey);
                request.Headers.TryAddWithoutValidation("Accept", "application/json");
                if (body is not null)
                {
                    request.Content = new StringContent(JsonSerializer.Serialize(body, JsonOptions), Encoding.UTF8, "application/json");
                }

                using var response = await Http.SendAsync(request, cancellationToken);
                var raw = await response.Content.ReadAsStringAsync(cancellationToken);
                if (!response.IsSuccessStatusCode)
                {
                    return ArrCallResult.Fail((int)response.StatusCode, ExtractError(raw) ?? (serviceName + " HTTP " + (int)response.StatusCode));
                }

                if (string.IsNullOrWhiteSpace(raw)) return ArrCallResult.Success((int)response.StatusCode, default);
                using var doc = JsonDocument.Parse(raw);
                return ArrCallResult.Success((int)response.StatusCode, doc.RootElement.Clone());
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                return ArrCallResult.Fail(500, ex.Message);
            }
        }

        private static Uri? BuildArrApiBase(string value)
        {
            var clean = NormalizeBaseUrlForStorage(value);
            if (!Uri.TryCreate(clean, UriKind.Absolute, out var uri)) return null;
            var raw = uri.ToString().TrimEnd('/');
            if (!raw.EndsWith("/api/v3", StringComparison.OrdinalIgnoreCase))
            {
                raw += "/api/v3";
            }

            return Uri.TryCreate(raw.TrimEnd('/') + "/", UriKind.Absolute, out var api) ? api : null;
        }

        private static object BuildSettingsPayload(JMSFusionConfiguration cfg, bool includeSensitive)
            => new
            {
                enabled = cfg.EnableArrIntegration,
                sonarrEnabled = cfg.ArrSonarrEnabled,
                sonarrBaseUrl = cfg.ArrSonarrBaseUrl,
                sonarrApiKey = includeSensitive ? cfg.ArrSonarrApiKey : string.Empty,
                hasSonarrApiKey = !string.IsNullOrWhiteSpace(cfg.ArrSonarrApiKey),
                sonarrRootFolderPath = cfg.ArrSonarrRootFolderPath,
                sonarrQualityProfileId = cfg.ArrSonarrQualityProfileId,
                sonarrLanguageProfileId = cfg.ArrSonarrLanguageProfileId,
                sonarrSeasonFolder = cfg.ArrSonarrSeasonFolder,
                sonarrSearchOnRequest = cfg.ArrSonarrSearchOnRequest,
                radarrEnabled = cfg.ArrRadarrEnabled,
                radarrBaseUrl = cfg.ArrRadarrBaseUrl,
                radarrApiKey = includeSensitive ? cfg.ArrRadarrApiKey : string.Empty,
                hasRadarrApiKey = !string.IsNullOrWhiteSpace(cfg.ArrRadarrApiKey),
                radarrRootFolderPath = cfg.ArrRadarrRootFolderPath,
                radarrQualityProfileId = cfg.ArrRadarrQualityProfileId,
                radarrSearchOnRequest = cfg.ArrRadarrSearchOnRequest
            };

        private static JMSFusionConfiguration GetConfig()
            => JMSFusionPlugin.Instance?.Configuration ?? throw new InvalidOperationException("Config not available.");

        private (User? User, Guid UserId, IActionResult? Result) TryGetAdminUser()
        {
            var userCheck = TryGetRequestUser();
            if (userCheck.Result is not null)
            {
                return userCheck;
            }

            if (!IsAdminUser(userCheck.User))
            {
                return (null, Guid.Empty, StatusCode(403, new { ok = false, error = "This action is only available to administrators." }));
            }

            return userCheck;
        }

        private (User? User, Guid UserId, IActionResult? Result) TryGetRequestUser()
        {
            if (!TryGetRequestUserId(out var userId))
            {
                return (null, Guid.Empty, Unauthorized(new { ok = false, error = "X-Emby-UserId is required." }));
            }

            var user = _users.GetUserById(userId);
            if (user is null)
            {
                return (null, Guid.Empty, Unauthorized(new { ok = false, error = "User not found." }));
            }

            return (user, userId, null);
        }

        private bool TryGetRequestUserId(out Guid userId)
        {
            var userIdHeader =
                Request.Headers["X-Emby-UserId"].FirstOrDefault() ??
                Request.Headers["X-MediaBrowser-UserId"].FirstOrDefault();

            return Guid.TryParse(userIdHeader, out userId) && userId != Guid.Empty;
        }

        private static bool IsAdminUser(User? user)
        {
            return user?.Permissions.Any(permission =>
                permission.Kind == PermissionKind.IsAdministrator && permission.Value) == true;
        }

        private void NoCache()
        {
            Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0";
            Response.Headers["Pragma"] = "no-cache";
            Response.Headers["Expires"] = "0";
        }

        private static string NormalizeBaseUrlForStorage(string? value)
            => (value ?? string.Empty).Trim().TrimEnd('/');

        private static string NormalizeSecret(string? value)
            => (value ?? string.Empty).Trim();

        private static string CleanText(string? value, int max)
        {
            var clean = string.Join(" ", (value ?? string.Empty).Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries));
            return clean.Length > max ? clean[..max] : clean;
        }

        private static string CleanKey(string? value)
            => new((value ?? string.Empty)
                .Trim()
                .ToLowerInvariant()
                .Where(ch => char.IsLetterOrDigit(ch) || char.IsWhiteSpace(ch))
                .ToArray());

        private static string NormalizeArrPath(string? value)
            => (value ?? string.Empty).Trim().TrimEnd('/', '\\');

        private static bool IsRadarrSequenceError(string? value)
            => (value ?? string.Empty).Contains("Sequence contains no matching element", StringComparison.OrdinalIgnoreCase);

        private static bool MatchesYear(JsonElement item, int? year)
        {
            if (!year.HasValue || year.Value <= 0) return true;
            return TryReadInt(item, "year", out var itemYear) && itemYear == year.Value;
        }

        private static bool TryReadInt(JsonElement source, string property, out int value)
        {
            value = 0;
            if (source.ValueKind != JsonValueKind.Object || !source.TryGetProperty(property, out var el)) return false;
            if (el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out value)) return true;
            if (el.ValueKind == JsonValueKind.String && int.TryParse(el.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out value)) return true;
            return false;
        }

        private static string ReadString(JsonElement source, string property)
        {
            if (source.ValueKind != JsonValueKind.Object || !source.TryGetProperty(property, out var el)) return string.Empty;
            return el.ValueKind == JsonValueKind.String ? (el.GetString() ?? string.Empty) : string.Empty;
        }

        private static int ReadIntValue(JsonElement source, string property)
            => TryReadInt(source, property, out var value) ? value : 0;

        private static long ReadLongValue(JsonElement source, string property)
        {
            if (source.ValueKind != JsonValueKind.Object || !source.TryGetProperty(property, out var el)) return 0;
            if (el.ValueKind == JsonValueKind.Number && el.TryGetInt64(out var value)) return value;
            if (el.ValueKind == JsonValueKind.String && long.TryParse(el.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out value)) return value;
            return 0;
        }

        private static bool ReadBool(JsonElement source, string property)
        {
            if (source.ValueKind != JsonValueKind.Object || !source.TryGetProperty(property, out var el)) return false;
            if (el.ValueKind == JsonValueKind.True) return true;
            if (el.ValueKind == JsonValueKind.False) return false;
            return el.ValueKind == JsonValueKind.String && bool.TryParse(el.GetString(), out var value) && value;
        }

        private static string? ExtractError(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return null;
            try
            {
                using var doc = JsonDocument.Parse(raw);
                var root = doc.RootElement;
                if (root.ValueKind == JsonValueKind.Array)
                {
                    var first = root.EnumerateArray().FirstOrDefault();
                    if (first.ValueKind == JsonValueKind.Object)
                    {
                        var msg = ReadString(first, "errorMessage");
                        if (!string.IsNullOrWhiteSpace(msg)) return msg;
                    }
                }

                if (root.ValueKind == JsonValueKind.Object)
                {
                    var message = ReadString(root, "message");
                    if (!string.IsNullOrWhiteSpace(message)) return message;
                    var error = ReadString(root, "error");
                    if (!string.IsNullOrWhiteSpace(error)) return error;
                }
            }
            catch {}

            return raw.Length > 500 ? raw[..500] : raw;
        }

        private readonly struct ArrCallResult
        {
            public bool Ok { get; init; }
            public int StatusCode { get; init; }
            public JsonElement Payload { get; init; }
            public string Error { get; init; }

            public static ArrCallResult Success(int statusCode, JsonElement payload)
                => new() { Ok = true, StatusCode = statusCode, Payload = payload, Error = string.Empty };

            public static ArrCallResult Fail(int statusCode, string error)
                => new() { Ok = false, StatusCode = statusCode, Payload = default, Error = error };
        }

        private readonly struct SonarrEpisodeResult
        {
            public bool Ok { get; init; }
            public int StatusCode { get; init; }
            public string Error { get; init; }
            public int SeriesId { get; init; }
            public int EpisodeId { get; init; }
            public int? CommandId { get; init; }
            public bool AddedSeries { get; init; }

            public static SonarrEpisodeResult Success(int seriesId, int episodeId, int? commandId, bool addedSeries)
                => new() { Ok = true, StatusCode = 200, Error = string.Empty, SeriesId = seriesId, EpisodeId = episodeId, CommandId = commandId, AddedSeries = addedSeries };

            public static SonarrEpisodeResult Fail(int statusCode, string error)
                => new() { Ok = false, StatusCode = statusCode, Error = error };
        }

        private readonly struct RadarrMovieResult
        {
            public bool Ok { get; init; }
            public int StatusCode { get; init; }
            public string Error { get; init; }
            public int MovieId { get; init; }
            public int? CommandId { get; init; }
            public bool AddedMovie { get; init; }

            public static RadarrMovieResult Success(int movieId, int? commandId, bool addedMovie)
                => new() { Ok = true, StatusCode = 200, Error = string.Empty, MovieId = movieId, CommandId = commandId, AddedMovie = addedMovie };

            public static RadarrMovieResult Fail(int statusCode, string error)
                => new() { Ok = false, StatusCode = statusCode, Error = error };
        }
    }
}
