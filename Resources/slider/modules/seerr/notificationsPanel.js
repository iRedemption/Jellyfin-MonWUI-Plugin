import {
  approveSerrRequest,
  declineSerrRequest,
  getSerrMovieDetails,
  getSerrTvDetails,
  listSerrRequests,
  withdrawSerrRequest
} from "./api.js";
import { getConfig } from "../config.js";
import { getEffectiveLanguage, getLanguageLabels } from "../../language/index.js";
import { requestMovieFromArr } from "../arr/requestFallback.js";
import { showNotification } from "../player/ui/notification.js";

let cachedCount = 0;
let cachedRequests = [];
let lastIsAdmin = false;
let managerRequests = [];
let managerIsAdmin = false;
let managerRefreshPromise = null;
let refreshPromise = null;
let pollTimer = 0;
let pollEventsBound = false;
let pollEnabled = false;
const ACTIVE_DOWNLOAD_POLL_MS = 2_000;
const OPEN_IDLE_POLL_MS = 5_000;
const BACKGROUND_POLL_MS = 15_000;
const SERR_IMAGE_BASE = "https://image.tmdb.org/t/p";
const posterCache = new Map();
const posterPromises = new Map();

function currentUserId() {
  try { return text(window.ApiClient?.getCurrentUserId?.()); } catch {}
  try { return text(window.ApiClient?._currentUserId); } catch {}
  try { return text(window.ApiClient?._currentUser?.Id || window.ApiClient?._currentUser?.id); } catch {}
  try { return text(sessionStorage.getItem("currentUserId") || localStorage.getItem("currentUserId")); } catch {}
  return "";
}

function seenStorageKey() {
  return `jf:serrSeenRequests:${currentUserId() || "nouser"}`;
}

function readSeenRequestKeys() {
  try {
    const raw = localStorage.getItem(seenStorageKey());
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.map((value) => text(value)).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function writeSeenRequestKeys(keys) {
  try {
    localStorage.setItem(seenStorageKey(), JSON.stringify(Array.from(keys || []).filter(Boolean)));
  } catch {}
}

function labels() {
  try {
    const activeLabels = getLanguageLabels?.(getEffectiveLanguage?.()) || {};
    if (Object.keys(activeLabels).length) return activeLabels;
  } catch {}
  try { return getConfig()?.languageLabels || {}; } catch { return {}; }
}

function moduleEnabled() {
  try { return getConfig()?.enableSerrArrIntegrationModule !== false; } catch { return true; }
}

function L(key, fallback) {
  const value = labels()?.[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function text(value, fallback = "") {
  const out = String(value ?? "").trim();
  return out || fallback;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[m]));
}

function serrLanguage() {
  try {
    const cfg = getConfig?.() || {};
    return text(cfg.serrDefaultLanguage || cfg.defaultLanguage || "");
  } catch {
    return "";
  }
}

function readFirst(source, ...keys) {
  if (!source || typeof source !== "object") return undefined;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function imageUrl(path, size = "w342") {
  const clean = text(path);
  if (!clean) return "";
  if (/^https?:\/\//i.test(clean)) return clean;
  return `${SERR_IMAGE_BASE}/${size}${clean.startsWith("/") ? clean : `/${clean}`}`;
}

function requestMediaType(req) {
  const type = text(req?.MediaType || req?.mediaType).toLowerCase();
  return type === "tv" || type === "series" || type === "show" || type === "tvshow" ? "tv" : "movie";
}

function requestMediaId(req) {
  const id = Number(req?.MediaId || req?.mediaId || 0);
  return Number.isFinite(id) && id > 0 ? Math.floor(id) : 0;
}

function requestNotificationKey(req) {
  const id = text(req?.Id || req?.id);
  if (id) return id;
  return [
    requestMediaType(req),
    requestMediaId(req),
    text(req?.CreatedAtUtc || req?.createdAtUtc),
    text(req?.Title || req?.title)
  ].filter(Boolean).join(":");
}

function posterCacheKey(req) {
  const id = requestMediaId(req);
  if (!id) return "";
  return `${requestMediaType(req)}:${id}`;
}

function directPosterUrl(req) {
  return imageUrl(readFirst(req, "PosterUrl", "posterUrl", "PosterPath", "posterPath", "poster_path", "image", "Image"));
}

async function resolvePosterUrl(req) {
  const direct = directPosterUrl(req);
  if (direct) return direct;

  const key = posterCacheKey(req);
  if (!key) return "";
  if (posterCache.has(key)) return posterCache.get(key) || "";
  if (posterPromises.has(key)) return posterPromises.get(key);

  const job = (async () => {
    const id = requestMediaId(req);
    const mediaType = requestMediaType(req);
    const language = serrLanguage();
    const details = mediaType === "tv"
      ? await getSerrTvDetails(id, { language }).catch(() => null)
      : await getSerrMovieDetails(id, { language }).catch(() => null);
    const poster = imageUrl(readFirst(details, "posterPath", "poster_path", "PosterPath"));
    posterCache.set(key, poster || "");
    return poster || "";
  })().finally(() => {
    posterPromises.delete(key);
  });

  posterPromises.set(key, job);
  return job;
}

function posterFallbackLabel(req) {
  return requestMediaType(req) === "tv" ? L("serrTv", "Dizi") : L("serrMovie", "Film");
}

function renderPoster(req, className = "") {
  const direct = directPosterUrl(req);
  const key = posterCacheKey(req);
  const cached = key ? posterCache.get(key) : "";
  const url = direct || cached || "";
  const title = text(req?.Title || req?.title, L("serrUntitled", "İçerik"));
  const label = posterFallbackLabel(req);
  const attrs = [
    `class="monwui-serr-poster ${escapeHtml(className)}"`,
    key ? `data-serr-art-key="${escapeHtml(key)}"` : "",
    direct ? `data-serr-art-ready="1"` : "",
  ].filter(Boolean).join(" ");

  return `
    <div ${attrs}>
      ${url
        ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(title)}" loading="lazy" decoding="async">`
        : `<div class="monwui-serr-poster-fallback"><i class="fas fa-clapperboard" aria-hidden="true"></i><span>${escapeHtml(label)}</span></div>`}
    </div>
  `;
}

function hydrateRequestPosters(scope = document) {
  const nodes = Array.from(scope.querySelectorAll?.(".monwui-serr-poster[data-serr-art-key]:not([data-serr-art-ready='1'])") || []);
  if (!nodes.length) return;

  for (const node of nodes) {
    const key = text(node.getAttribute("data-serr-art-key"));
    const req = [...cachedRequests, ...managerRequests].find((entry) => posterCacheKey(entry) === key);
    if (!req) continue;

    resolvePosterUrl(req).then((url) => {
      if (!url || !node.isConnected || node.getAttribute("data-serr-art-ready") === "1") return;
      const title = text(req?.Title || req?.title, L("serrUntitled", "İçerik"));
      node.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(title)}" loading="lazy" decoding="async">`;
      node.setAttribute("data-serr-art-ready", "1");
    }).catch(() => {});
  }
}

function formatTime(ts) {
  const n = Number(ts || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  try {
    return new Date(n).toLocaleString(labels()?.timeLocale || undefined);
  } catch {
    return "";
  }
}

function ensureSerrProgressStyles() {
  const id = "monwui-serr-download-progress-styles";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    #jfNotifModal .monwui-serr-download,
    .monwui-serr-requests-modal .monwui-serr-download {
      display: grid;
      gap: 5px;
      margin-top: 4px;
      min-width: 0;
    }
    #jfNotifModal .monwui-serr-download-line,
    .monwui-serr-requests-modal .monwui-serr-download-line {
      align-items: center;
      color: var(--jf-notif-text-dim, var(--nft-text-secondary, rgba(255,255,255,.68)));
      display: flex;
      flex-wrap: wrap;
      font-size: 12px;
      gap: 6px;
      line-height: 1.35;
      min-width: 0;
    }
    #jfNotifModal .monwui-serr-download-line b,
    .monwui-serr-requests-modal .monwui-serr-download-line b {
      color: var(--jf-notif-text, var(--nft-text-primary, #fff));
      font-weight: 800;
    }
    #jfNotifModal .monwui-serr-download-track,
    .monwui-serr-requests-modal .monwui-serr-download-track {
      background: color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 18%, transparent);
      border: 1px solid color-mix(in srgb, var(--jf-notif-accent, var(--notif-accent, #6aa6ff)) 26%, transparent);
      border-radius: 999px;
      height: 7px;
      overflow: hidden;
      width: 100%;
    }
    #jfNotifModal .monwui-serr-download-bar,
    .monwui-serr-requests-modal .monwui-serr-download-bar {
      background: var(--jf-notif-accent, var(--notif-accent, #6aa6ff));
      border-radius: inherit;
      height: 100%;
      min-width: 2px;
      transition: width .25s ease;
    }
  `;
  document.head.appendChild(style);
}

function statusLabel(status) {
  switch (text(status).toLowerCase()) {
    case "pending": return L("serrStatusPending", "Onay bekliyor");
    case "approved": return L("serrStatusApproved", "Onaylandı");
    case "processing": return L("serrStatusProcessing", "İşleniyor");
    case "completed":
    case "available": return L("serrStatusCompleted", "Tamamlandı");
    case "declined": return L("serrStatusDeclined", "Reddedildi");
    case "failed": return L("serrStatusFailed", "Hatalı");
    case "withdrawn": return L("serrStatusWithdrawn", "Geri çekildi");
    default: return L("serrStatusRequested", "İstendi");
  }
}

function downloadInfo(req) {
  const info = req?.download || req?.Download;
  return info && (info.active === true || info.IsActive === true) ? info : null;
}

function percentValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function serviceLabel(value) {
  const clean = text(value).toLowerCase();
  if (clean === "radarr") return "Radarr";
  if (clean === "sonarr") return "Sonarr";
  return clean ? clean : "Arr";
}

function renderDownloadProgress(req) {
  const info = downloadInfo(req);
  if (!info) return "";
  const percent = percentValue(info.progressPercent ?? info.ProgressPercent);
  const service = serviceLabel(info.service || info.Service);
  const client = text(info.downloadClient || info.DownloadClient);
  const timeLeft = text(info.timeLeft || info.TimeLeft);
  const count = Number(info.itemCount ?? info.ItemCount ?? 1);
  const bits = [
    service,
    client,
    timeLeft ? `${L("arrDownloadRemaining", "Kalan")}: ${timeLeft}` : "",
    Number.isFinite(count) && count > 1 ? `${count} ${L("arrDownloadItems", "öğe")}` : ""
  ].filter(Boolean);

  return `
    <div class="monwui-serr-download">
      <div class="monwui-serr-download-line">
        <b>${escapeHtml(L("arrDownloadProgress", "İndirme"))} ${escapeHtml(percent.toFixed(percent >= 10 ? 0 : 1))}%</b>
        ${bits.length ? `<span>${escapeHtml(bits.join(" • "))}</span>` : ""}
      </div>
      <div class="monwui-serr-download-track" aria-label="${escapeHtml(L("arrDownloadProgress", "İndirme"))}">
        <div class="monwui-serr-download-bar" style="width:${escapeHtml(String(percent))}%"></div>
      </div>
    </div>
  `;
}

function renderDownloadProgressHost(req) {
  return `<div data-serr-download-host>${renderDownloadProgress(req)}</div>`;
}

function arrStatusMessage(result) {
  if (result?.service === "sonarr") return L("arrEpisodeRequestSent", "Bölüm isteği Sonarr'a gönderildi.");
  if (result?.service === "radarr") return L("arrMovieRequestSent", "Film isteği Radarr'a gönderildi.");
  return L("arrRequestSent", "Arr isteği gönderildi.");
}

function notify(message, type = "info") {
  const clean = text(message);
  if (!clean) return;
  try {
    showNotification(`<i class="fas fa-clapperboard" style="margin-right:8px;"></i>${escapeHtml(clean)}`, 3200, type);
  } catch {
    window.showMessage?.(clean, type === "error" ? "error" : "success");
  }
}

function shouldFallbackMovieToArr(result) {
  if (result?.backend === "arr" || result?.service === "radarr" || result?.service === "sonarr") return false;
  if (result?.pendingApproval) return false;
  if (result?.ok !== false) return false;

  const request = result?.request || result?.Request || {};
  const mediaType = requestMediaType(request);
  const mediaId = requestMediaId(request);
  return mediaType === "movie" && mediaId > 0;
}

async function approveSerrRequestWithArrFallback(id) {
  const result = await approveSerrRequest(id);
  if (result?.backend === "arr" || result?.service === "radarr" || result?.service === "sonarr") {
    notify(arrStatusMessage(result), "success");
  }
  if (shouldFallbackMovieToArr(result)) {
    const request = result?.request || result?.Request || {};
    const mediaId = requestMediaId(request);
    const title = text(request?.Title || request?.title, L("serrMovie", "Film"));
    const arrResult = await requestMovieFromArr({ __tmdbId: mediaId, Name: title }, { tmdbId: mediaId, title });
    notify(arrStatusMessage(arrResult), "success");
  }
  return result;
}

function isHiddenFromNotifications(req) {
  const status = text(req?.Status || req?.status).toLowerCase();
  return status === "completed" ||
    status === "available" ||
    status === "declined" ||
    status === "failed" ||
    status === "withdrawn";
}

function mediaLabel(req) {
  const type = requestMediaType(req);
  const episodes = Array.isArray(req?.episodes) ? req.episodes : (Array.isArray(req?.Episodes) ? req.Episodes : []);
  const episodeText = episodes.length
    ? episodes.slice(0, 4).map((entry) => {
        const seasonNumber = Number(entry?.SeasonNumber ?? entry?.seasonNumber);
        const episodeNumber = Number(entry?.EpisodeNumber ?? entry?.episodeNumber);
        const code = [
          Number.isFinite(seasonNumber) ? `S${String(seasonNumber).padStart(2, "0")}` : "",
          Number.isFinite(episodeNumber) ? `E${String(episodeNumber).padStart(2, "0")}` : ""
        ].filter(Boolean).join("");
        return code || text(entry?.Name || entry?.name, L("episode", "Bölüm"));
      }).join(", ") + (episodes.length > 4 ? ` +${episodes.length - 4}` : "")
    : "";
  const seasons = req?.RequestAllSeasons || req?.requestAllSeasons
    ? L("serrAllSeasons", "Tüm sezonlar")
    : (Array.isArray(req?.seasons) && req.seasons.length
      ? req.seasons.map((n) => `${L("season", "Sezon")} ${n}`).join(", ")
      : "");
  return [type === "tv" ? L("serrTv", "Dizi") : L("serrMovie", "Film"), seasons, episodeText].filter(Boolean).join(" • ");
}

function computeCount(requests, isAdmin) {
  const seen = readSeenRequestKeys();
  return notificationCountableRequests(requests, isAdmin)
    .reduce((count, req) => {
      const key = requestNotificationKey(req);
      return count + (key && !seen.has(key) ? 1 : 0);
    }, 0);
}

function notificationCountableRequests(requests, isAdmin) {
  const list = Array.isArray(requests) ? requests : [];
  if (!isAdmin) return list;
  return list.filter((req) => text(req?.Status || req?.status).toLowerCase() === "pending");
}

function ensureSerrTabBadgeStyles() {
  const id = "monwui-serr-tab-badge-styles";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    #jfNotifModal .jf-notif-tab[data-tab="serr"] {
      align-items: center;
      display: inline-flex;
      gap: 6px;
      flex-direction: column-reverse;
    }
    #jfNotifModal .monwui-serr-tab-label {
      min-width: 0;
    }
    #jfNotifModal .monwui-serr-tab-badge {
      align-items: center;
      background: var(--jf-notif-warning, #ffbf5f);
      border-radius: 999px;
      color: #111;
      display: inline-flex;
      font-size: 11px;
      font-weight: 850;
      height: 18px;
      justify-content: center;
      line-height: 1;
      min-width: 18px;
      padding: 0 6px;
    }
    #jfNotifModal .jf-notif-tab.active .monwui-serr-tab-badge {
      background: rgba(255,255,255,.92);
      color: #111;
    }
    #jfNotifModal .monwui-serr-tab-badge[hidden] {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

function renderSerrTabBadge() {
  const tab = document.querySelector('#jfNotifModal .jf-notif-tab[data-tab="serr"]');
  if (!tab) return;
  ensureSerrTabBadgeStyles();

  let label = tab.querySelector(".monwui-serr-tab-label");
  let badge = tab.querySelector(".monwui-serr-tab-badge");
  if (!label || !badge) {
    tab.textContent = "";
    label = document.createElement("span");
    label.className = "monwui-serr-tab-label";
    badge = document.createElement("span");
    badge.className = "monwui-serr-tab-badge";
    badge.setAttribute("aria-hidden", "true");
    tab.append(label, badge);
  }

  label.textContent = L("serrNotificationsTab", "Seerr İstekleri");
  const count = getCachedSerrNotificationCount();
  const visible = count > 0;
  const value = count > 99 ? "99+" : String(count);
  badge.textContent = visible ? value : "";
  badge.hidden = !visible;
  tab.setAttribute("data-serr-count", visible ? value : "");
  tab.classList.toggle("has-serr-count", visible);
}

function dispatchSerrCountChanged() {
  try { window.dispatchEvent(new CustomEvent("monwui:serr-notification-count-changed")); } catch {}
}

export function markSerrNotificationsSeen() {
  const before = cachedCount;
  const seen = readSeenRequestKeys();
  let changed = false;
  for (const req of notificationCountableRequests(cachedRequests, lastIsAdmin)) {
    const key = requestNotificationKey(req);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    changed = true;
  }
  if (!changed && cachedCount === 0) {
    renderSerrTabBadge();
    if (before !== cachedCount) dispatchSerrCountChanged();
    return;
  }

  if (changed) writeSeenRequestKeys(seen);
  cachedCount = computeCount(cachedRequests, lastIsAdmin);
  renderSerrTabBadge();
  if (changed || before !== cachedCount) dispatchSerrCountChanged();
}

function applyNotificationData(data, { render = false } = {}) {
  const previousCount = cachedCount;
  cachedRequests = (Array.isArray(data?.requests) ? data.requests : []).filter((req) => !isHiddenFromNotifications(req));
  lastIsAdmin = data?.isAdmin === true;
  cachedCount = computeCount(cachedRequests, lastIsAdmin);
  if (isSerrPanelVisible()) {
    markSerrNotificationsSeen();
    if (previousCount !== cachedCount) dispatchSerrCountChanged();
  } else {
    renderSerrTabBadge();
    if (previousCount !== cachedCount) dispatchSerrCountChanged();
  }
  if (render) renderSerrNotifications();
}

async function refresh({ render = false } = {}) {
  if (!moduleEnabled()) {
    const previousCount = cachedCount;
    cachedRequests = [];
    cachedCount = 0;
    removeSerrNotificationsTab();
    if (previousCount !== cachedCount) dispatchSerrCountChanged();
    return null;
  }
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const data = await listSerrRequests();
      applyNotificationData(data, { render });
      return data;
    } catch {
      const previousCount = cachedCount;
      cachedRequests = [];
      cachedCount = 0;
      renderSerrTabBadge();
      if (previousCount !== cachedCount) dispatchSerrCountChanged();
      if (render) renderSerrNotifications();
      return null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export function refreshSerrNotifications({ render = false } = {}) {
  return refresh({ render });
}

export function getCachedSerrNotificationCount() {
  return moduleEnabled() ? cachedCount : 0;
}

export function removeSerrNotificationsTab() {
  const tab = document.querySelector('#jfNotifModal .jf-notif-tab[data-tab="serr"]');
  const pane = document.querySelector('#jfNotifModal .jf-notif-tab-content[data-tab="serr"]');
  const wasActive = tab?.classList?.contains("active") === true || (pane ? pane.style.display !== "none" : false);
  tab?.remove?.();
  pane?.remove?.();
  if (wasActive) {
    const first = document.querySelector("#jfNotifModal .jf-notif-tab");
    first?.click?.();
  }
}

export function ensureSerrNotificationsTab({ bindNotifTabButton } = {}) {
  if (!moduleEnabled()) {
    removeSerrNotificationsTab();
    return;
  }
  ensureSerrTabBadgeStyles();
  const tabs = document.querySelector("#jfNotifModal .jf-notif-tabs");
  const contentHost = document.querySelector("#jfNotifModal .jf-notif-content");
  if (!tabs || !contentHost) return;

  if (!tabs.querySelector('[data-tab="serr"]')) {
    const btn = document.createElement("button");
    btn.className = "jf-notif-tab";
    btn.setAttribute("data-tab", "serr");
    tabs.appendChild(btn);
    bindNotifTabButton?.(btn);
  }
  renderSerrTabBadge();

  let pane = contentHost.querySelector('.jf-notif-tab-content[data-tab="serr"]');
  if (!pane) {
    pane = document.createElement("div");
    pane.className = "jf-notif-tab-content";
    pane.setAttribute("data-tab", "serr");
    pane.style.display = "none";
    pane.innerHTML = `
      <div class="monwui-serr-notif-tools">
        <button type="button" class="monwui-serr-manage-btn" data-serr-open-manager>${escapeHtml(L("serrManageRequests", "İstekleri Yönet"))}</button>
      </div>
      <div class="monwui-serr-notif-host" id="monwuiSerrNotifHost"></div>
    `;
    contentHost.appendChild(pane);
  }

  if (!pane.querySelector("[data-serr-open-manager]")) {
    const tools = document.createElement("div");
    tools.className = "monwui-serr-notif-tools";
    tools.innerHTML = `<button type="button" class="monwui-serr-manage-btn" data-serr-open-manager>${escapeHtml(L("serrManageRequests", "İstekleri Yönet"))}</button>`;
    pane.prepend(tools);
  }

  if (!pane.querySelector("#monwuiSerrNotifHost")) {
    const host = document.createElement("div");
    host.className = "monwui-serr-notif-host";
    host.id = "monwuiSerrNotifHost";
    pane.appendChild(host);
  }

  bindSerrManagerButtons();
}

export function renderSerrNotifications() {
  if (!moduleEnabled()) {
    removeSerrNotificationsTab();
    return;
  }
  ensureSerrProgressStyles();
  const host = document.getElementById("monwuiSerrNotifHost");
  if (!host) return;

  if (!cachedRequests.length) {
    host.innerHTML = `<div class="monwui-serr-empty">${escapeHtml(L("serrNoRequests", "Aktif Seerr isteği yok."))}</div>`;
    return;
  }

  host.innerHTML = `
    <ul class="monwui-serr-notif-list">
      ${cachedRequests.map((req) => renderRequest(req, lastIsAdmin)).join("")}
    </ul>
  `;

  host.querySelectorAll("[data-serr-approve]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await runAction(btn, () => approveSerrRequestWithArrFallback(btn.getAttribute("data-serr-approve")));
    });
  });

  host.querySelectorAll("[data-serr-decline]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await runAction(btn, () => declineSerrRequest(btn.getAttribute("data-serr-decline")));
    });
  });

  hydrateRequestPosters(host);
}

function bindSerrManagerButtons(scope = document) {
  scope.querySelectorAll?.("[data-serr-open-manager]").forEach((button) => {
    if (button.__monwuiSerrManagerBound) return;
    button.__monwuiSerrManagerBound = true;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openSerrRequestsModal();
    });
  });
}

function renderRequest(req, isAdmin) {
  const status = text(req?.Status || req?.status).toLowerCase();
  const title = text(req?.Title || req?.title, L("serrUntitled", "İçerik"));
  const requestedBy = req?.requestedBy?.userName || req?.RequestedBy?.UserName || "";
  const error = text(req?.Error || req?.error);
  const time = formatTime(req?.UpdatedAtUtc || req?.updatedAtUtc || req?.CreatedAtUtc || req?.createdAtUtc);
  const canApprove = isAdmin && status === "pending";

  return `
    <li class="monwui-serr-notif-item">
      <div class="monwui-serr-notif-top">
        ${renderPoster(req, "compact")}
        <div class="monwui-serr-notif-main">
          <div class="monwui-serr-title-row">
            <span class="monwui-serr-status ${escapeHtml(status || "pending")}">${escapeHtml(statusLabel(status))}</span>
            ${time ? `<span class="monwui-serr-state">${escapeHtml(time)}</span>` : ""}
          </div>
          <div class="monwui-serr-name">${escapeHtml(title)}</div>
          <div class="monwui-serr-meta">${escapeHtml(mediaLabel(req))}</div>
          ${renderDownloadProgressHost(req)}
          ${requestedBy ? `<div class="monwui-serr-state">${escapeHtml(L("serrRequestedBy", "İsteyen"))}: ${escapeHtml(requestedBy)}</div>` : ""}
          ${error ? `<div class="monwui-serr-error">${escapeHtml(error)}</div>` : ""}
        </div>
        ${canApprove ? `
          <div class="monwui-serr-notif-actions">
            <button type="button" class="monwui-serr-mini-btn primary" data-serr-approve="${escapeHtml(req.Id || req.id)}">${escapeHtml(L("serrApprove", "Onayla"))}</button>
            <button type="button" class="monwui-serr-mini-btn" data-serr-decline="${escapeHtml(req.Id || req.id)}">${escapeHtml(L("serrDecline", "Reddet"))}</button>
          </div>
        ` : ""}
      </div>
    </li>
  `;
}

function ensureSerrRequestsModal() {
  let modal = document.getElementById("monwuiSerrRequestsModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "monwuiSerrRequestsModal";
  modal.className = "monwui-serr-requests-modal";
  modal.setAttribute("aria-hidden", "true");
  modal.innerHTML = `
    <div class="monwui-serr-requests-backdrop" data-serr-manager-close></div>
    <div class="monwui-serr-requests-dialog" role="dialog" aria-modal="true">
      <div class="monwui-serr-requests-head">
        <div class="monwui-serr-requests-title">${escapeHtml(L("serrRequestsModalTitle", "Seerr İstek Yönetimi"))}</div>
        <button type="button" class="monwui-serr-requests-close" data-serr-manager-close aria-label="${escapeHtml(L("close", "Kapat"))}">×</button>
      </div>
      <div class="monwui-serr-requests-body"></div>
    </div>
  `;
  modal.addEventListener("click", (event) => {
    if (event.target?.closest?.("[data-serr-manager-close]")) {
      closeSerrRequestsModal();
    }
  });
  document.body.appendChild(modal);
  return modal;
}

function closeSerrRequestsModal() {
  const modal = document.getElementById("monwuiSerrRequestsModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  scheduleNextPoll(nextPollDelay());
}

async function openSerrRequestsModal() {
  const modal = ensureSerrRequestsModal();
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  const body = modal.querySelector(".monwui-serr-requests-body");
  if (body) {
    body.innerHTML = `<div class="monwui-serr-loading">${escapeHtml(L("loadingText", "Yükleniyor..."))}</div>`;
  }
  const data = await refreshSerrRequestManager({ render: false, showError: true });
  if (data) renderSerrRequestManager();
  scheduleNextPoll(nextPollDelay());
}

async function refreshSerrRequestManager({ render = false, showError = render } = {}) {
  if (managerRefreshPromise) {
    const data = await managerRefreshPromise;
    if (render && data) renderSerrRequestManager();
    if (showError && !data) {
      const body = document.querySelector("#monwuiSerrRequestsModal .monwui-serr-requests-body");
      if (body) body.innerHTML = `<div class="monwui-serr-error">${escapeHtml(L("serrRequestFailed", "İşlem tamamlanamadı."))}</div>`;
    }
    return data;
  }
  managerRefreshPromise = (async () => {
    const modal = ensureSerrRequestsModal();
    const body = modal.querySelector(".monwui-serr-requests-body");
    if (render && body) {
      body.innerHTML = `<div class="monwui-serr-loading">${escapeHtml(L("loadingText", "Yükleniyor..."))}</div>`;
    }

    try {
      const data = await listSerrRequests({ includeHistory: true });
      managerRequests = Array.isArray(data?.requests) ? data.requests : [];
      managerIsAdmin = data?.isAdmin === true;
    } catch (error) {
      managerRequests = [];
      managerIsAdmin = false;
      if (showError && body) {
        body.innerHTML = `<div class="monwui-serr-error">${escapeHtml(error?.message || L("serrRequestFailed", "İşlem tamamlanamadı."))}</div>`;
      }
      return null;
    } finally {
      managerRefreshPromise = null;
    }

    if (render) renderSerrRequestManager();
    return { requests: managerRequests, isAdmin: managerIsAdmin };
  })();
  return managerRefreshPromise;
}

function renderSerrRequestManager() {
  ensureSerrProgressStyles();
  const modal = ensureSerrRequestsModal();
  const body = modal.querySelector(".monwui-serr-requests-body");
  if (!body) return;

  if (!managerRequests.length) {
    body.innerHTML = `<div class="monwui-serr-empty">${escapeHtml(L("serrNoRequestHistory", "Seerr istek geçmişi yok."))}</div>`;
    return;
  }

  body.innerHTML = `
    <div class="monwui-serr-requests-list">
      ${managerRequests.map((req) => renderManagerRequest(req, managerIsAdmin)).join("")}
    </div>
  `;

  body.querySelectorAll("[data-serr-manager-approve]").forEach((btn) => {
    btn.addEventListener("click", () => runManagerAction(btn, () => approveSerrRequestWithArrFallback(btn.getAttribute("data-serr-manager-approve"))));
  });
  body.querySelectorAll("[data-serr-manager-decline]").forEach((btn) => {
    btn.addEventListener("click", () => runManagerAction(btn, () => declineSerrRequest(btn.getAttribute("data-serr-manager-decline"))));
  });
  body.querySelectorAll("[data-serr-manager-withdraw]").forEach((btn) => {
    btn.addEventListener("click", () => runManagerAction(btn, () => withdrawSerrRequest(btn.getAttribute("data-serr-manager-withdraw"))));
  });

  hydrateRequestPosters(body);
}

function renderManagerRequest(req, isAdmin) {
  const id = text(req?.Id || req?.id);
  const status = text(req?.Status || req?.status).toLowerCase() || "pending";
  const title = text(req?.Title || req?.title, L("serrUntitled", "İçerik"));
  const requestedBy = req?.requestedBy?.userName || req?.RequestedBy?.UserName || "";
  const created = formatTime(req?.CreatedAtUtc || req?.createdAtUtc);
  const updated = formatTime(req?.UpdatedAtUtc || req?.updatedAtUtc);
  const completed = formatTime(req?.CompletedAtUtc || req?.completedAtUtc);
  const error = text(req?.Error || req?.error);
  const canApprove = isAdmin && (status === "pending" || status === "failed");
  const canDecline = isAdmin && status !== "declined" && status !== "withdrawn" && status !== "completed" && status !== "available";
  const canWithdraw = id && (
    (isAdmin && status !== "withdrawn" && status !== "completed" && status !== "available") ||
    (!isAdmin && status === "pending")
  );

  return `
    <section class="monwui-serr-request-card" data-serr-request-id="${escapeHtml(id)}">
      <div class="monwui-serr-request-main">
        ${renderPoster(req, "large")}
        <div class="monwui-serr-request-content">
          <div class="monwui-serr-title-row">
            <span class="monwui-serr-status ${escapeHtml(status)}" data-serr-status>${escapeHtml(statusLabel(status))}</span>
            <span class="monwui-serr-state" data-serr-updated ${updated ? "" : "hidden"}>${escapeHtml(updated)}</span>
          </div>
          <div class="monwui-serr-request-name">${escapeHtml(title)}</div>
          <div class="monwui-serr-request-meta">${escapeHtml(mediaLabel(req))}</div>
          ${renderDownloadProgressHost(req)}
        </div>
        <div class="monwui-serr-request-actions">
          ${canApprove ? `<button type="button" class="monwui-serr-mini-btn primary" data-serr-manager-approve="${escapeHtml(id)}">${escapeHtml(L("serrApprove", "Onayla"))}</button>` : ""}
          ${canDecline ? `<button type="button" class="monwui-serr-mini-btn" data-serr-manager-decline="${escapeHtml(id)}">${escapeHtml(L("serrDecline", "Reddet"))}</button>` : ""}
          ${canWithdraw ? `<button type="button" class="monwui-serr-mini-btn" data-serr-manager-withdraw="${escapeHtml(id)}">${escapeHtml(L("serrWithdraw", "Geri Çek"))}</button>` : ""}
        </div>
      </div>
      <div class="monwui-serr-request-details">
        ${requestedBy ? `<div><b>${escapeHtml(L("serrRequestedBy", "İsteyen"))}</b><span>${escapeHtml(requestedBy)}</span></div>` : ""}
        ${created ? `<div><b>${escapeHtml(L("created", "Oluşturuldu"))}</b><span>${escapeHtml(created)}</span></div>` : ""}
        ${updated ? `<div><b>${escapeHtml(L("updated", "Güncellendi"))}</b><span>${escapeHtml(updated)}</span></div>` : ""}
        ${completed ? `<div><b>${escapeHtml(L("serrStatusCompleted", "Tamamlandı"))}</b><span>${escapeHtml(completed)}</span></div>` : ""}
        <div><b>TMDb</b><span>${escapeHtml(text(req?.MediaId || req?.mediaId, "-"))}</span></div>
        ${req?.SerrRequestId || req?.serrRequestId ? `<div><b>Seerr</b><span>#${escapeHtml(req?.SerrRequestId || req?.serrRequestId)}</span></div>` : ""}
      </div>
      <div data-serr-error-host>${error ? `<div class="monwui-serr-error">${escapeHtml(error)}</div>` : ""}</div>
    </section>
  `;
}

function updateVisibleSerrRequestManager() {
  ensureSerrProgressStyles();
  const modal = document.querySelector(".monwui-serr-requests-modal.open");
  const body = modal?.querySelector(".monwui-serr-requests-body");
  if (!body) return;

  const cards = Array.from(body.querySelectorAll("[data-serr-request-id]"));
  if (!cards.length) {
    if (managerRequests.length) renderSerrRequestManager();
    return;
  }

  const requestsById = new Map(
    managerRequests
      .map((req) => [text(req?.Id || req?.id), req])
      .filter(([id]) => id)
  );

  for (const card of cards) {
    const id = text(card.getAttribute("data-serr-request-id"));
    const req = requestsById.get(id);
    if (!req) continue;

    const status = text(req?.Status || req?.status).toLowerCase() || "pending";
    const statusNode = card.querySelector("[data-serr-status]");
    if (statusNode) {
      statusNode.className = `monwui-serr-status ${status}`;
      statusNode.textContent = statusLabel(status);
    }

    const updated = formatTime(req?.UpdatedAtUtc || req?.updatedAtUtc);
    card.querySelectorAll("[data-serr-updated]").forEach((node) => {
      node.textContent = updated;
      if (updated) node.removeAttribute("hidden");
      else node.setAttribute("hidden", "");
    });

    const progressHost = card.querySelector("[data-serr-download-host]");
    if (progressHost) progressHost.innerHTML = renderDownloadProgress(req);

    const errorHost = card.querySelector("[data-serr-error-host]");
    if (errorHost) {
      const error = text(req?.Error || req?.error);
      errorHost.innerHTML = error ? `<div class="monwui-serr-error">${escapeHtml(error)}</div>` : "";
    }
  }

  hydrateRequestPosters(body);
}

async function runManagerAction(button, fn) {
  if (!button || button.disabled) return;
  const old = button.textContent;
  try {
    button.disabled = true;
    button.textContent = L("loadingText", "Yükleniyor...");
    await fn();
    await refresh({ render: true });
    const data = await refreshSerrRequestManager({ render: false, showError: true });
    if (data) renderSerrRequestManager();
    try { window.dispatchEvent(new CustomEvent("monwui:serr-notification-count-changed")); } catch {}
  } catch (error) {
    button.textContent = error?.message || L("serrRequestFailed", "İşlem tamamlanamadı.");
    setTimeout(() => {
      button.textContent = old;
      button.disabled = false;
    }, 1800);
  }
}

async function runAction(button, fn) {
  if (!button || button.disabled) return;
  const old = button.textContent;
  try {
    button.disabled = true;
    button.textContent = L("loadingText", "Yükleniyor...");
    await fn();
    await refresh({ render: true });
  } catch (error) {
    button.textContent = error?.message || L("serrRequestFailed", "İşlem tamamlanamadı.");
    setTimeout(() => { button.textContent = old; button.disabled = false; }, 1800);
    return;
  }
  button.disabled = false;
  button.textContent = old;
}

function isSerrPanelVisible() {
  const tab = document.querySelector('.jf-notif-tab.active[data-tab="serr"]');
  if (!tab) return false;
  const modal = tab.closest("#jfNotifModal");
  return !modal || modal.classList.contains("open");
}

function isSerrManagerVisible() {
  return document.querySelector(".monwui-serr-requests-modal.open") != null;
}

function hasActiveDownload(requests) {
  return (Array.isArray(requests) ? requests : []).some((req) => downloadInfo(req));
}

function nextPollDelay() {
  if (document.hidden) return BACKGROUND_POLL_MS;
  const visibleSurface = isSerrPanelVisible() || isSerrManagerVisible();
  if (visibleSurface && (hasActiveDownload(cachedRequests) || hasActiveDownload(managerRequests))) {
    return ACTIVE_DOWNLOAD_POLL_MS;
  }
  return visibleSurface ? OPEN_IDLE_POLL_MS : BACKGROUND_POLL_MS;
}

function syncNotificationsFromManager({ renderPanel = false } = {}) {
  applyNotificationData({ requests: managerRequests, isAdmin: managerIsAdmin }, { render: renderPanel });
}

async function refreshVisibleSerrSurfaces({ forcePanelRender = false } = {}) {
  const renderPanel = forcePanelRender || isSerrPanelVisible();
  if (isSerrManagerVisible()) {
    const data = await refreshSerrRequestManager({ render: false });
    if (data) {
      updateVisibleSerrRequestManager();
      syncNotificationsFromManager({ renderPanel });
      return data;
    }
  }

  return refresh({ render: renderPanel });
}

function scheduleNextPoll(delay = nextPollDelay()) {
  clearTimeout(pollTimer);
  if (!pollEnabled || !moduleEnabled()) return;
  pollTimer = setTimeout(() => {
    pollTimer = 0;
    if (document.hidden) {
      scheduleNextPoll();
      return;
    }
    refreshVisibleSerrSurfaces()
      .catch(() => {})
      .finally(() => scheduleNextPoll());
  }, Math.max(500, delay));
}

export function scheduleSerrNotificationsPoll() {
  if (!moduleEnabled()) {
    stopSerrNotificationsPoll();
    return;
  }
  pollEnabled = true;
  clearTimeout(pollTimer);
  refresh({ render: false }).finally(() => scheduleNextPoll());

  if (pollEventsBound) return;
  pollEventsBound = true;

  window.addEventListener("monwui:serr-requests-changed", () => {
    if (!pollEnabled || !moduleEnabled()) return;
    refreshVisibleSerrSurfaces({ forcePanelRender: true })
      .catch(() => {})
      .finally(() => scheduleNextPoll(ACTIVE_DOWNLOAD_POLL_MS));
  });
  window.addEventListener("focus", () => {
    if (!pollEnabled || !moduleEnabled()) return;
    refreshVisibleSerrSurfaces({ forcePanelRender: document.querySelector("#jfNotifModal.open") != null })
      .catch(() => {})
      .finally(() => scheduleNextPoll());
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && pollEnabled && moduleEnabled()) {
      refreshVisibleSerrSurfaces()
        .catch(() => {})
        .finally(() => scheduleNextPoll());
    }
  });
}

export function stopSerrNotificationsPoll() {
  pollEnabled = false;
  clearTimeout(pollTimer);
  pollTimer = 0;
  const previousCount = cachedCount;
  cachedRequests = [];
  cachedCount = 0;
  removeSerrNotificationsTab();
  if (previousCount !== cachedCount) dispatchSerrCountChanged();
}
