import { initPlayer, togglePlayerVisibility, isPlayerInitialized } from "./utils/mainIndex.js";
import { musicPlayerState, saveUserSettings } from "./core/state.js";
import {
  refreshPlaylist,
  playTrackById,
  playAlbumById,
  playArtistById,
  playPlaylistById,
  playFolderById
} from "./core/playlist.js";
import { updateProgress, updateDuration } from "./player/progress.js";
import { syncDbIncremental, syncDbFullscan } from "./ui/artistModal.js";
import { loadJSMediaTags } from "./lyrics/id3Reader.js";
import { getConfig } from "../config.js";
import { initializeControlStates, toggleMute, updateVolumeIcon } from "./ui/controls.js";
import { togglePlayPause } from "./player/playback.js";
import { faIconHtml } from "../faIcons.js";
import { loadCSS } from "../playerStyles.js";
import { apiUrl } from "./core/auth.js";
import { getEmbyHeaders, getSessionInfo } from "../../../Plugins/JMSFusion/runtime/api.js";
import { applyHeaderIconButtonMode, findHeaderMountTarget, getHeaderMountWaitSelector } from "../headerCompat.js";

export { isMobileDevice } from "../playerStyles.js";
export {
  playTrackById,
  playAlbumById,
  playArtistById,
  playPlaylistById,
  playFolderById
};

const config = getConfig();
const GMMP_REMOTE_STATE_INTERVAL_MS = 4000;
const GMMP_REMOTE_COMMAND_INTERVAL_MS = 2500;
const GMMP_NATIVE_HOOK_SCAN_INTERVAL_MS = 2_000;
const GMMP_NATIVE_HOOK_MAX_SCAN_MS = 5 * 60_000;

let gmmpRemoteStateTimer = 0;
let gmmpRemoteCommandTimer = 0;
let gmmpRemoteStateBusy = false;
let gmmpRemoteCommandBusy = false;
let gmmpRemoteLastCommandSequence = 0;
let gmmpRemoteLastStateSignature = "";
let gmmpRemoteLifecycleHooksInstalled = false;
let gmmpNativePlaybackHookInstalled = false;
let gmmpNativePlaybackHookScanTimer = 0;
let gmmpNativePlaybackHookScheduleTimer = 0;
let gmmpNativePlaybackHookScanStartedAt = 0;
let gmmpNativePlaybackHookBypassDepth = 0;
let playerHeaderObserver = null;
const gmmpNativePlaybackHookPatchedTargets = new WeakMap();
const PLAYER_HEADER_LEGACY_CLASS = "headerSyncButton syncButton headerButton headerButtonRight paper-icon-button-light";

function logGmmpRemote(message, detail = undefined, level = "info") {
  try {
    if (detail === undefined) {
      console[level](`[GMMP remote] ${message}`);
    } else {
      console[level](`[GMMP remote] ${message}`, detail);
    }
  } catch {}
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function settle(ms = 60) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function getGmmpPlaybackState() {
  const audio = musicPlayerState?.audio;
  const track = musicPlayerState?.currentTrack || musicPlayerState?.playlist?.[musicPlayerState?.currentIndex] || null;
  const runtimeSeconds = Number.isFinite(audio?.duration) && audio.duration > 0
    ? audio.duration
    : (Number.isFinite(musicPlayerState?.currentTrackDuration) ? musicPlayerState.currentTrackDuration : 0);
  const currentVolume = clamp(
    Math.round((audio?.muted ? 0 : Number(audio?.volume ?? musicPlayerState?.userSettings?.volume ?? 0)) * 100),
    0,
    100
  );

  return {
    hasCurrentTrack: !!track,
    trackId: track?.Id ? String(track.Id) : "",
    isPaused: !!audio?.paused,
    isMuted: !!audio?.muted || currentVolume <= 0,
    volumeLevel: currentVolume,
    positionTicks: Math.max(0, Math.floor(Number(audio?.currentTime || 0) * 10_000_000)),
    runtimeTicks: Math.max(0, Math.floor(Number(runtimeSeconds || 0) * 10_000_000)),
    isLiveStream: !!musicPlayerState?.isLiveStream
  };
}

function getGmmpSyncContext() {
  const session = (typeof getSessionInfo === "function" ? getSessionInfo() : null) || {};
  const api = (typeof window !== "undefined" && window.ApiClient) ? window.ApiClient : null;

  return {
    sessionId: String(session?.sessionId || api?._sessionId || "").trim(),
    deviceId: String(session?.deviceId || api?._deviceId || "").trim(),
    userId: String(
      session?.userId ||
      (typeof api?.getCurrentUserId === "function" ? api.getCurrentUserId() : api?._currentUserId) ||
      ""
    ).trim()
  };
}

function buildGmmpSyncHeaders(extra = {}) {
  const headers = (typeof getEmbyHeaders === "function" ? getEmbyHeaders(extra) : { ...extra }) || { ...extra };
  const { userId } = getGmmpSyncContext();

  if (userId) {
    headers["X-Emby-UserId"] = userId;
    headers["X-MediaBrowser-UserId"] = userId;
  }

  return headers;
}

function buildGmmpStatePayload() {
  const state = getGmmpPlaybackState();
  const { sessionId, deviceId } = getGmmpSyncContext();

  return {
    sessionId,
    deviceId,
    trackId: String(state?.trackId || "").trim(),
    itemId: String(state?.trackId || "").trim(),
    hasCurrentTrack: !!state?.hasCurrentTrack,
    isPaused: !!state?.isPaused,
    isMuted: !!state?.isMuted,
    volumeLevel: clamp(state?.volumeLevel ?? 0, 0, 100),
    positionTicks: Math.max(0, Number(state?.positionTicks || 0)),
    runtimeTicks: Math.max(0, Number(state?.runtimeTicks || 0)),
    isLiveStream: !!state?.isLiveStream
  };
}

function isGmmpEnabled() {
  const liveConfig = (typeof getConfig === "function" ? getConfig() : null) || config || {};
  return liveConfig.enabledGmmp !== false;
}

function isRemoteGmmpSyncEnabled() {
  const liveConfig = (typeof getConfig === "function" ? getConfig() : null) || config || {};
  return isGmmpEnabled() && liveConfig.enableCastModule !== false;
}

function hasActiveRemoteGmmpTrack() {
  try {
    return buildGmmpStatePayload().hasCurrentTrack === true;
  } catch {
    return false;
  }
}

function getGmmpStateSignature(payload) {
  if (!payload?.hasCurrentTrack) {
    return "";
  }

  const coarsePositionTicks = Math.floor(Number(payload.positionTicks || 0) / 10_000_000) * 10_000_000;
  return JSON.stringify([
    payload.sessionId,
    payload.deviceId,
    payload.trackId,
    payload.isPaused,
    payload.isMuted,
    payload.volumeLevel,
    coarsePositionTicks,
    payload.runtimeTicks,
    payload.isLiveStream
  ]);
}

function buildInactiveGmmpStatePayload() {
  const { sessionId, deviceId } = getGmmpSyncContext();

  return {
    sessionId,
    deviceId,
    trackId: "",
    itemId: "",
    hasCurrentTrack: false,
    isPaused: true,
    isMuted: true,
    volumeLevel: 0,
    positionTicks: 0,
    runtimeTicks: 0,
    isLiveStream: false
  };
}

async function postRemoteGmmpState(payload, { keepalive = false } = {}) {
  if (!isRemoteGmmpSyncEnabled()) {
    return false;
  }

  try {
    const response = await fetch(apiUrl("/Plugins/JMSFusion/gmmp/state"), {
      method: "POST",
      headers: buildGmmpSyncHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
      keepalive
    });

    if (!response.ok) {
      logGmmpRemote("state post failed", {
        status: response.status,
        hasCurrentTrack: !!payload?.hasCurrentTrack,
        sessionId: payload?.sessionId || "",
        deviceId: payload?.deviceId || ""
      }, "warn");
      return false;
    }

    gmmpRemoteLastStateSignature = payload?.hasCurrentTrack ? getGmmpStateSignature(payload) : "";
    return true;
  } catch (error) {
    logGmmpRemote("state post threw", {
      error: error?.message || String(error || ""),
      hasCurrentTrack: !!payload?.hasCurrentTrack
    }, "warn");
    return false;
  }
}

async function syncRemoteGmmpState(force = false) {
  if (!isRemoteGmmpSyncEnabled()) return false;
  if (gmmpRemoteStateBusy) return false;

  const payload = buildGmmpStatePayload();
  if (!payload.sessionId && !payload.deviceId) {
    return false;
  }

  const signature = getGmmpStateSignature(payload);
  if (!force && !payload.hasCurrentTrack && !gmmpRemoteLastStateSignature) {
    return false;
  }

  if (!force && payload.hasCurrentTrack && signature && gmmpRemoteLastStateSignature === signature) {
    return false;
  }

  gmmpRemoteStateBusy = true;
  try {
    return await postRemoteGmmpState(payload);
  } finally {
    gmmpRemoteStateBusy = false;
  }
}

async function clearRemoteGmmpState({ reason = "manual", keepalive = false } = {}) {
  if (!isRemoteGmmpSyncEnabled()) return false;
  const payload = buildInactiveGmmpStatePayload();
  if (!payload.sessionId && !payload.deviceId) {
    return false;
  }

  gmmpRemoteLastStateSignature = "";
  const ok = await postRemoteGmmpState(payload, { keepalive });
  if (ok) {
    logGmmpRemote("state cleared", {
      reason,
      sessionId: payload.sessionId,
      deviceId: payload.deviceId
    });
  }
  return ok;
}

async function applyRemoteGmmpCommand(command) {
  const name = String(command?.Name || command?.name || "").trim().toLowerCase();
  const args = (command?.Arguments || command?.arguments || {});
  const expectedTrackId = String(
    args?.TrackId ??
    args?.trackId ??
    args?.ItemId ??
    args?.itemId ??
    ""
  ).trim();
  const currentState = getGmmpPlaybackState();

  if (expectedTrackId) {
    const currentTrackId = String(currentState?.trackId || "").trim();
    if (!currentState?.hasCurrentTrack || !currentTrackId) {
      logGmmpRemote("command ignored without active track", {
        name,
        expectedTrackId
      }, "warn");
      return false;
    }

    if (currentTrackId !== expectedTrackId) {
      logGmmpRemote("command ignored due to track mismatch", {
        name,
        expectedTrackId,
        currentTrackId
      }, "warn");
      return false;
    }
  }

  switch (name) {
    case "pause":
      await setGmmpPaused(true);
      return true;
    case "unpause":
    case "resume":
      await setGmmpPaused(false);
      return true;
    case "mute":
      await setGmmpMuted(true);
      return true;
    case "unmute":
      await setGmmpMuted(false);
      return true;
    case "setvolume": {
      const volume = clamp(
        Number(args?.Volume ?? args?.volume ?? 0),
        0,
        100
      );
      await setGmmpVolume(volume);
      return true;
    }
    default:
      return false;
  }
}

async function pollRemoteGmmpCommands() {
  if (!isRemoteGmmpSyncEnabled()) return false;
  if (gmmpRemoteCommandBusy) return false;
  if (!hasActiveRemoteGmmpTrack()) return false;

  const { sessionId, deviceId } = getGmmpSyncContext();
  if (!sessionId && !deviceId) {
    return false;
  }

  gmmpRemoteCommandBusy = true;
  try {
    const url = new URL(apiUrl("/Plugins/JMSFusion/gmmp/commands"));
    if (sessionId) {
      url.searchParams.set("sessionId", sessionId);
    }
    if (deviceId) {
      url.searchParams.set("deviceId", deviceId);
    }
    if (gmmpRemoteLastCommandSequence > 0) {
      url.searchParams.set("afterSequence", String(gmmpRemoteLastCommandSequence));
    }

    const response = await fetch(url.toString(), {
      headers: buildGmmpSyncHeaders()
    });
    if (!response.ok) {
      logGmmpRemote("command poll failed", {
        status: response.status,
        sessionId,
        deviceId
      }, "warn");
      return false;
    }

    const data = await response.json().catch(() => ({}));
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) {
      return true;
    }

    logGmmpRemote("commands received", items.map((item) => ({
      sequence: Number(item?.Sequence ?? item?.sequence ?? 0) || 0,
      name: String(item?.Name || item?.name || "").trim()
    })), "warn");

    for (const item of items) {
      const sequence = Number(item?.Sequence ?? item?.sequence ?? 0) || 0;
      try {
        await applyRemoteGmmpCommand(item);
        logGmmpRemote("command applied", {
          sequence,
          name: String(item?.Name || item?.name || "").trim()
        }, "warn");
      } catch (error) {
        console.warn("GMMP remote command apply failed:", error);
        logGmmpRemote("command apply failed", {
          sequence,
          name: String(item?.Name || item?.name || "").trim(),
          error: error?.message || String(error || "")
        }, "warn");
      } finally {
        if (sequence > gmmpRemoteLastCommandSequence) {
          gmmpRemoteLastCommandSequence = sequence;
        }
      }
    }

    void syncRemoteGmmpState(true);
    return true;
  } catch {
    return false;
  } finally {
    gmmpRemoteCommandBusy = false;
  }
}

function ensureRemoteGmmpSync() {
  if (!isRemoteGmmpSyncEnabled()) {
    stopRemoteGmmpSync();
    return false;
  }

  const startedStateTimer = !gmmpRemoteStateTimer;
  const startedCommandTimer = !gmmpRemoteCommandTimer;

  if (!gmmpRemoteStateTimer) {
    gmmpRemoteStateTimer = window.setInterval(() => {
      void syncRemoteGmmpState(false);
    }, GMMP_REMOTE_STATE_INTERVAL_MS);
  }

  if (!gmmpRemoteCommandTimer) {
    gmmpRemoteCommandTimer = window.setInterval(() => {
      void pollRemoteGmmpCommands();
    }, GMMP_REMOTE_COMMAND_INTERVAL_MS);
  }

  if (startedStateTimer || startedCommandTimer) {
    queueMicrotask(() => {
      void syncRemoteGmmpState(true);
      void pollRemoteGmmpCommands();
    });
  }

  return true;
}

function stopRemoteGmmpSync() {
  if (gmmpRemoteStateTimer) {
    clearInterval(gmmpRemoteStateTimer);
    gmmpRemoteStateTimer = 0;
  }

  if (gmmpRemoteCommandTimer) {
    clearInterval(gmmpRemoteCommandTimer);
    gmmpRemoteCommandTimer = 0;
  }

  gmmpRemoteStateBusy = false;
  gmmpRemoteCommandBusy = false;
}

function installRemoteGmmpLifecycleHooks() {
  if (gmmpRemoteLifecycleHooksInstalled || typeof window === "undefined") {
    return;
  }

  gmmpRemoteLifecycleHooksInstalled = true;

  window.addEventListener("pagehide", () => {
    void clearRemoteGmmpState({ reason: "pagehide", keepalive: true });
  }, { passive: true });

  window.addEventListener("beforeunload", () => {
    void clearRemoteGmmpState({ reason: "beforeunload", keepalive: true });
  }, { passive: true });

  if (/Android|iPhone|iPad/i.test(typeof navigator !== "undefined" ? navigator.userAgent : "")) {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) return;
      void clearRemoteGmmpState({ reason: "hidden", keepalive: true });
    }, { passive: true });
  }
}

async function setGmmpPaused(paused) {
  await ensureGmmpInit({ show: false });
  const audio = musicPlayerState?.audio;
  if (!audio) {
    throw new Error("GMMP audio bulunamadi");
  }

  if (!!audio.paused !== !!paused) {
    if (typeof togglePlayPause === "function") {
      togglePlayPause();
      await settle(paused ? 20 : 80);
    }

    if (!!audio.paused !== !!paused) {
      if (paused) {
        audio.pause();
      } else {
        await audio.play();
      }
    }
  }

  try {
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = paused ? "paused" : "playing";
    }
  } catch {}

  void syncRemoteGmmpState(true);
  return getGmmpPlaybackState();
}

async function setGmmpMuted(muted) {
  await ensureGmmpInit({ show: false });
  const audio = musicPlayerState?.audio;
  if (!audio) {
    throw new Error("GMMP audio bulunamadi");
  }

  const nextMuted = !!muted;
  if (!nextMuted && Number(audio.volume || 0) <= 0) {
    const restored = clamp(
      Math.round(Number(musicPlayerState?.userSettings?.volume ?? 0.7) * 100),
      1,
      100
    ) / 100;
    audio.volume = restored;
    if (musicPlayerState?.userSettings) {
      musicPlayerState.userSettings.volume = restored;
    }
  }

  if (!!audio.muted !== nextMuted && typeof toggleMute === "function") {
    toggleMute();
  }
  if (!!audio.muted !== nextMuted) {
    audio.muted = nextMuted;
  }

  if (musicPlayerState?.volumeSlider) {
    try {
      musicPlayerState.volumeSlider.value = String(nextMuted ? 0 : Number(audio.volume || 0));
    } catch {}
  }

  try {
    updateVolumeIcon(nextMuted ? 0 : Number(audio.volume || 0));
  } catch {}

  try {
    saveUserSettings?.();
  } catch {}

  void syncRemoteGmmpState(true);
  return getGmmpPlaybackState();
}

async function setGmmpVolume(volumeLevel) {
  await ensureGmmpInit({ show: false });
  const audio = musicPlayerState?.audio;
  if (!audio) {
    throw new Error("GMMP audio bulunamadi");
  }

  const normalized = clamp(volumeLevel, 0, 100) / 100;
  audio.volume = normalized;
  audio.muted = normalized <= 0;

  if (musicPlayerState?.userSettings) {
    musicPlayerState.userSettings.volume = normalized;
  }

  if (musicPlayerState?.volumeSlider) {
    try {
      musicPlayerState.volumeSlider.value = String(normalized);
    } catch {}
  }

  try {
    updateVolumeIcon(normalized);
  } catch {}

  try {
    saveUserSettings?.();
  } catch {}

  void syncRemoteGmmpState(true);
  return getGmmpPlaybackState();
}

export async function ensureGmmpInit({ show = true } = {}) {
  try {
    if (!isGmmpEnabled()) {
      return false;
    }

    ensureRemoteGmmpSync();
    initializeControlStates?.();
    if (!isPlayerInitialized()) {
      await loadJSMediaTags?.();
      await initPlayer();
      await new Promise(r => setTimeout(r, 50));
    }
    if (show) {
      const visible = !!document.querySelector(".gmmp-player.visible, .modernPlayer.visible");
      if (!visible) {
        try { togglePlayerVisibility(); } catch {}
      }
    }
    return true;
  } catch (e) {
    console.warn("ensureGmmpInit failed:", e);
    return false;
  }
}

function firstNativePlaybackString(...values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function getNativePlaybackItemId(item) {
  return String(item?.Id || item?.id || item?.ItemId || item?.itemId || "").trim();
}

function getFirstNativePlaybackItem(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (Array.isArray(payload)) {
    return payload.find((item) => item && typeof item === "object" && getNativePlaybackItemId(item)) || null;
  }
  if (payload.item && typeof payload.item === "object") return payload.item;
  if (payload.Item && typeof payload.Item === "object") return payload.Item;
  if (Array.isArray(payload.items)) return getFirstNativePlaybackItem(payload.items);
  if (Array.isArray(payload.Items)) return getFirstNativePlaybackItem(payload.Items);
  if (payload.Id || payload.id) return payload;
  return null;
}

function getFirstNativePlaybackId(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload.trim();
  if (Array.isArray(payload)) {
    for (const value of payload) {
      const id = getFirstNativePlaybackId(value);
      if (id) return id;
    }
    return "";
  }
  if (typeof payload !== "object") return "";

  const item = getFirstNativePlaybackItem(payload);
  const itemId = getNativePlaybackItemId(item);
  if (itemId) return itemId;

  const listKeys = ["ids", "Ids", "itemIds", "ItemIds", "ItemIdsList", "PlaylistItemIds"];
  for (const key of listKeys) {
    const value = payload[key];
    if (Array.isArray(value) && value.length) {
      const id = getFirstNativePlaybackId(value[0]) || firstNativePlaybackString(value[0]);
      if (id) return id;
    }
  }

  return firstNativePlaybackString(
    payload.itemId,
    payload.ItemId,
    payload.id,
    payload.Id,
    payload.mediaSourceId,
    payload.MediaSourceId
  );
}

function extractGmmpNativePlaybackContext(args = []) {
  const list = Array.isArray(args) ? args : [];
  for (const arg of list) {
    const item = getFirstNativePlaybackItem(arg);
    const itemId = getFirstNativePlaybackId(arg);
    if (item || itemId) {
      return {
        item,
        itemId: itemId || getNativePlaybackItemId(item)
      };
    }
  }
  return { item: null, itemId: "" };
}

function isMusicNativePlaybackItem(item) {
  const type = String(item?.Type || "");
  const mediaType = String(item?.MediaType || "");
  const collectionType = String(item?.CollectionType || item?.collectionType || "").trim().toLowerCase();

  if (mediaType === "Audio") return true;
  if (type === "Audio" || type === "MusicVideo" || type === "MusicAlbum" || type === "MusicArtist") return true;
  if (type === "Playlist") return true;
  if (type === "Folder" && (collectionType === "music" || collectionType === "musicvideos" || collectionType === "audio")) return true;
  return false;
}

async function fetchGmmpNativePlaybackItemDetails(itemId) {
  const id = String(itemId || "").trim();
  if (!id) return null;

  try {
    const api = await import("../../../Plugins/JMSFusion/runtime/api.js");
    if (typeof api?.fetchItemDetails === "function") {
      return await api.fetchItemDetails(id);
    }
  } catch (error) {
    console.warn("[GMMP] Native music item lookup failed:", error);
  }

  return null;
}

async function resolveGmmpNativePlaybackItem(context = {}) {
  const candidate = context?.item;
  if (candidate?.Type && getNativePlaybackItemId(candidate)) return candidate;

  const itemId = context?.itemId || getNativePlaybackItemId(candidate);
  if (!itemId) return candidate || null;
  if (candidate && getNativePlaybackItemId(candidate)) return candidate;

  const fetched = await fetchGmmpNativePlaybackItemDetails(itemId);
  if (fetched) return fetched;
  return candidate || { Id: itemId };
}

async function playNativeMusicItemWithGmmp(item, itemId) {
  if (!isGmmpEnabled()) return false;

  const id = String(itemId || getNativePlaybackItemId(item) || "").trim();
  if (!id) return false;

  const type = String(item?.Type || "");
  const mediaType = String(item?.MediaType || "");

  if (type === "Audio" || type === "MusicVideo" || mediaType === "Audio") {
    return !!(await playTrackById(id, { revealPlayer: true }).catch(() => false));
  }
  if (type === "MusicAlbum") {
    return !!(await playAlbumById(id, { revealPlayer: true }).catch(() => false));
  }
  if (type === "MusicArtist") {
    return !!(await playArtistById(id, { revealPlayer: true }).catch(() => false));
  }
  if (type === "Playlist") {
    return !!(await playPlaylistById(id, { revealPlayer: true }).catch(() => false));
  }
  if (type === "Folder") {
    return !!(await playFolderById(id, { revealPlayer: true }).catch(() => false));
  }

  return false;
}

function callOriginalGmmpNativePlay(original, target, args) {
  gmmpNativePlaybackHookBypassDepth += 1;
  try {
    return original.apply(target, args);
  } finally {
    gmmpNativePlaybackHookBypassDepth = Math.max(0, gmmpNativePlaybackHookBypassDepth - 1);
  }
}

async function runGmmpBeforeNativePlay(original, target, args, label) {
  if (gmmpNativePlaybackHookBypassDepth > 0) {
    return callOriginalGmmpNativePlay(original, target, args);
  }

  const context = extractGmmpNativePlaybackContext(args);
  const itemId = context.itemId || getNativePlaybackItemId(context.item);
  if (!itemId) {
    return callOriginalGmmpNativePlay(original, target, args);
  }

  const item = await resolveGmmpNativePlaybackItem(context);
  if (!isMusicNativePlaybackItem(item)) {
    return callOriginalGmmpNativePlay(original, target, args);
  }

  const handled = await playNativeMusicItemWithGmmp(item, itemId);
  if (handled) return true;

  return callOriginalGmmpNativePlay(original, target, args);
}

function getWebpackRequireForGmmpNativeHook() {
  try {
    if (window.__jmsGmmpWebpackRequire) return window.__jmsGmmpWebpackRequire;
  } catch {}

  const chunkGlobals = [];
  try {
    if (Array.isArray(window.webpackChunk)) chunkGlobals.push(window.webpackChunk);
  } catch {}
  try {
    for (const key of Object.getOwnPropertyNames(window)) {
      if (!/^webpackChunk/i.test(key)) continue;
      const value = window[key];
      if (Array.isArray(value) && !chunkGlobals.includes(value)) chunkGlobals.push(value);
    }
  } catch {}

  for (const chunkGlobal of chunkGlobals) {
    try {
      let captured = null;
      const chunkId = `jms-gmmp-native-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      chunkGlobal.push([[chunkId], {}, (req) => {
        captured = req;
      }]);
      if (typeof captured === "function") {
        try { window.__jmsGmmpWebpackRequire = captured; } catch {}
        return captured;
      }
    } catch {}
  }

  return null;
}

function collectWebpackPlaybackManagersForGmmpHook() {
  const req = getWebpackRequireForGmmpNativeHook();
  if (!req) return [];

  const out = [];
  const add = (candidate, label) => {
    if (!candidate || typeof candidate.play !== "function") return;
    out.push({ target: candidate, label });
  };

  try {
    const direct = req(39738);
    add(direct?.f, "webpack:39738");
  } catch {}

  try {
    if (req.c) {
      for (const [moduleId, mod] of Object.entries(req.c)) {
        const candidate = mod?.exports?.f;
        if (candidate?.play && candidate?.canPlay && candidate?.getCurrentPlayer) {
          add(candidate, `webpack:${moduleId}`);
        }
      }
    }
  } catch {}

  return out;
}

function collectNativePlaybackManagersForGmmpHook() {
  const out = [];
  const seen = new Set();
  const add = (candidate, label) => {
    if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) return;
    if (typeof candidate.play !== "function") return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    out.push({ target: candidate, label });
  };

  [
    [window.playbackManager, "window.playbackManager"],
    [window.MediaBrowser?.playbackManager, "MediaBrowser.playbackManager"],
    [window.MediaBrowser?.PlaybackManager, "MediaBrowser.PlaybackManager"],
    [window.Emby?.playbackManager, "Emby.playbackManager"],
    [window.Emby?.PlaybackManager, "Emby.PlaybackManager"],
    [window.appRouter?.playbackManager, "appRouter.playbackManager"],
    [window.__playbackManager, "__playbackManager"],
    [window.__jellyfinPlaybackManager, "__jellyfinPlaybackManager"],
    [window.__jmsPlaybackManager, "__jmsPlaybackManager"]
  ].forEach(([candidate, label]) => add(candidate, label));

  try {
    for (const key of Object.getOwnPropertyNames(window)) {
      if (!/playback/i.test(key)) continue;
      try { add(window[key], `window.${key}`); } catch {}
    }
  } catch {}

  for (const candidate of collectWebpackPlaybackManagersForGmmpHook()) {
    add(candidate.target, candidate.label);
  }

  return out;
}

function patchNativePlaybackManagerForGmmp(target, label) {
  if (!target || typeof target.play !== "function") return false;

  const currentPlay = target.play;
  if (currentPlay?.__jmsGmmpNativeWrapped === true) {
    gmmpNativePlaybackHookPatchedTargets.set(target, currentPlay);
    return false;
  }

  const knownWrapped = gmmpNativePlaybackHookPatchedTargets.get(target);
  if (knownWrapped && currentPlay === knownWrapped) return false;

  const wrapped = function gmmpWrappedNativePlay(...args) {
    return runGmmpBeforeNativePlay(currentPlay, this || target, args, label);
  };

  try {
    Object.defineProperty(wrapped, "__jmsGmmpNativeWrapped", { value: true });
    Object.defineProperty(wrapped, "__jmsGmmpNativeOriginalPlay", { value: currentPlay });
    Object.defineProperty(wrapped, "__jmsGmmpNativePlayLabel", { value: label });
    target.play = wrapped;
    gmmpNativePlaybackHookPatchedTargets.set(target, wrapped);
    return true;
  } catch {
    return false;
  }
}

function patchKnownNativePlaybackManagersForGmmp() {
  if (typeof window === "undefined") return false;

  let patchedAny = false;
  for (const { target, label } of collectNativePlaybackManagersForGmmpHook()) {
    patchedAny = patchNativePlaybackManagerForGmmp(target, label) || patchedAny;
  }
  return patchedAny;
}

function installGmmpNativePlaybackHook() {
  if (
    gmmpNativePlaybackHookInstalled ||
    !isGmmpEnabled() ||
    typeof window === "undefined" ||
    typeof document === "undefined"
  ) return;

  gmmpNativePlaybackHookInstalled = true;
  gmmpNativePlaybackHookScanStartedAt = Date.now();

  const scan = () => {
    patchKnownNativePlaybackManagersForGmmp();
    if (
      gmmpNativePlaybackHookScanTimer &&
      Date.now() - gmmpNativePlaybackHookScanStartedAt > GMMP_NATIVE_HOOK_MAX_SCAN_MS
    ) {
      window.clearInterval(gmmpNativePlaybackHookScanTimer);
      gmmpNativePlaybackHookScanTimer = 0;
    }
  };

  scan();
  gmmpNativePlaybackHookScanTimer = window.setInterval(scan, GMMP_NATIVE_HOOK_SCAN_INTERVAL_MS);
  window.addEventListener("pageshow", scan, { passive: true });
  window.addEventListener("focus", scan, { passive: true });
}

function isAndroidWebViewLike() {
  try {
    const ua = String(navigator?.userAgent || "");
    return /Android/i.test(ua) && (
      /\bwv\b/i.test(ua) ||
      /; wv\)/i.test(ua) ||
      /Jellyfin/i.test(ua) ||
      !!window.ReactNativeWebView
    );
  } catch {
    return false;
  }
}

function scheduleGmmpNativePlaybackHook() {
  if (
    gmmpNativePlaybackHookInstalled ||
    gmmpNativePlaybackHookScheduleTimer ||
    !isGmmpEnabled() ||
    typeof window === "undefined" ||
    typeof document === "undefined"
  ) return;

  const delayMs = isAndroidWebViewLike() ? 3500 : 750;
  const run = () => {
    gmmpNativePlaybackHookScheduleTimer = 0;
    if (!isGmmpEnabled()) return;

    const install = () => installGmmpNativePlaybackHook();
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(install, { timeout: 2000 });
    } else {
      install();
    }
  };

  const arm = () => {
    if (gmmpNativePlaybackHookInstalled || gmmpNativePlaybackHookScheduleTimer || !isGmmpEnabled()) return;
    gmmpNativePlaybackHookScheduleTimer = window.setTimeout(run, delayMs);
  };

  if (document.readyState === "complete") {
    arm();
  } else {
    window.addEventListener("load", arm, { once: true, passive: true });
    window.setTimeout(arm, isAndroidWebViewLike() ? 9000 : 5000);
  }
}

export async function destroyGmmp({ reason = "manual" } = {}) {
  try {
    const [
      stateMod,
      playbackMod,
      progressMod,
      mediaSessionMod,
      controlsMod,
      playlistModalMod,
      playerUiMod,
      artistModalMod,
      genreFilterMod,
      notificationMod,
      playlistCoreMod,
      id3ReaderMod,
      lyricsMod,
      radioCoreMod
    ] = await Promise.all([
      import("./core/state.js").catch(() => null),
      import("./player/playback.js").catch(() => null),
      import("./player/progress.js").catch(() => null),
      import("./core/mediaSession.js").catch(() => null),
      import("./ui/controls.js").catch(() => null),
      import("./ui/playlistModal.js").catch(() => null),
      import("./ui/playerUI.js").catch(() => null),
      import("./ui/artistModal.js").catch(() => null),
      import("./ui/genreFilterModal.js").catch(() => null),
      import("./ui/notification.js").catch(() => null),
      import("./core/playlist.js").catch(() => null),
      import("./lyrics/id3Reader.js").catch(() => null),
      import("./lyrics/lyrics.js").catch(() => null),
      import("./core/radio.js").catch(() => null)
    ]);

    const musicPlayerState = stateMod?.musicPlayerState;
    if (!musicPlayerState) return false;

    await playbackMod?.stopPlayback?.({ resetSource: true }).catch(() => false);
    try { playbackMod?.clearPlaybackRuntimeCaches?.(); } catch {}
    try { playlistCoreMod?.cleanupPlaylistRuntimeState?.(); } catch {}
    try { lyricsMod?.clearLyricsRuntimeCaches?.(); } catch {}
    try { id3ReaderMod?.clearId3RuntimeCaches?.(); } catch {}
    try { radioCoreMod?.clearRadioRuntimeCaches?.(); } catch {}

    try { progressMod?.cleanupProgressControls?.(); } catch {}
    try { progressMod?.cleanupMediaSession?.(); } catch {}
    try { mediaSessionMod?.cleanupMediaSession?.(); } catch {}
    try { controlsMod?.destroyControls?.(); } catch {}
    try { playlistModalMod?.destroyPlaylistModal?.(); } catch {}
    try { genreFilterMod?.closeModalSafe?.(); } catch {}
    try { artistModalMod?.destroyArtistModal?.(); } catch {}
    try { playerUiMod?.destroyModernPlayerUI?.(); } catch {}

    [
      "#gmmp-radio-modal",
      "#music-stats-modal"
    ].forEach((selector) => {
      try { document.querySelector(selector)?.remove?.(); } catch {}
    });

    try { notificationMod?.destroyNotificationSystem?.(); } catch {}

    musicPlayerState.isPlayerVisible = false;
    musicPlayerState.modernPlayer = null;
    musicPlayerState.favoriteBtn = null;
    musicPlayerState.playlistModal = null;
    musicPlayerState.playlistItemsContainer = null;
    musicPlayerState.playlistSearchInput = null;
    musicPlayerState.radioModal = null;
    musicPlayerState.mediaSessionInitialized = false;
    musicPlayerState.playlist = [];
    musicPlayerState.originalPlaylist = [];
    musicPlayerState.effectivePlaylist = [];
    musicPlayerState.combinedPlaylist = [];
    musicPlayerState.userAddedTracks = [];
    musicPlayerState.selectedItems = [];
    musicPlayerState.selectedGenres = [];
    musicPlayerState.currentLyrics = [];
    musicPlayerState.radioSharedStations = [];
    musicPlayerState.radioSearchResults = [];
    musicPlayerState.playedHistory = [];
    musicPlayerState.lyricsCache = {};
    musicPlayerState.currentTrack = null;
    musicPlayerState.currentTrackName = null;
    musicPlayerState.currentAlbumName = null;
    musicPlayerState.currentArtwork = null;
    musicPlayerState.currentPlaylistId = null;
    musicPlayerState.playlistSource = null;
    musicPlayerState.currentIndex = 0;
    musicPlayerState.currentTrackDuration = 0;
    musicPlayerState.radioNowPlayingSource = null;
    musicPlayerState.isLiveStream = false;
    musicPlayerState.isUserModified = false;
    musicPlayerState.isPlayingReported = false;
    musicPlayerState.lastReportedItemId = null;
    musicPlayerState.syncedLyrics = {
      lines: [],
      currentLine: -1
    };
    try { musicPlayerState.onTrackChanged?.splice?.(0); } catch {}
    try { musicPlayerState.id3TagsCache?.clear?.(); } catch {}
    try { musicPlayerState.id3ImageCache?.clear?.(); } catch {}
    musicPlayerState.id3TagsCache = new Map();
    musicPlayerState.id3ImageCache = new Map();
    try { musicPlayerState.selectedTracks?.clear?.(); } catch {}
    musicPlayerState.selectedTracks = new Set();

    stopRemoteGmmpSync();
    await clearRemoteGmmpState({ reason: `destroy:${reason}` }).catch(() => false);
    return true;
  } catch (err) {
    console.warn("GMMP destroy failed:", { reason, err });
    return false;
  }
}

let stylesInjected = false;
function ensurePointerStylesInjected() {
  if (stylesInjected) return;
  stylesInjected = true;

  const style = document.createElement("style");
  style.id = "gmmp-pointer-style";
  style.textContent = `
    html .skinHeader { pointer-events: all !important; }
    button#jellyfinPlayerToggle {
      align-items: center;
      background: none !important;
      border: none !important;
      cursor: pointer !important;
      display: inline-flex !important;
      justify-content: center;
      opacity: 1 !important;
      pointer-events: all !important;
      text-shadow: none !important;
    }
    button#jellyfinPlayerToggle[data-jms-header-mode="legacy"] {
      text-shadow: rgb(255 255 255) 0 0 2px !important;
    }
    .jms-mui-header-icon-button,.jms-mui-header-icon-button.MuiButtonBase-root MuiIconButton-root.MuiIconButton-colorInherit.MuiIconButton-sizeLarge {
      display: inline-flex;
      -webkit-box-align: center;
      align-items: center;
      -webkit-box-pack: center;
      justify-content: center;
      position: relative;
      box-sizing: border-box;
      -webkit-tap-highlight-color: transparent;
      background-color: transparent;
      cursor: pointer;
      user-select: none;
      vertical-align: middle;
      appearance: none;
      text-align: center;
      --IconButton-hoverBg: rgba(var(--jf-palette-action-activeChannel) / var(--jf-palette-action-hoverOpacity));
      color: inherit;
      font-size: 1rem;
      outline: 0px;
      border-width: 0px;
      border-style: none;
      border-color: currentcolor;
      color: currentcolor;
      border-image: initial;
      margin: 0px;
      text-decoration: none;
      flex: 0 0 auto;
      border-radius: 50%;
      transition: background-color 150ms cubic-bezier(0.4, 0, 0.2, 1);
      padding: 12px;
  }

  a.monwui-watchlist-nav-button.monwui-watchlist-nav-link.MuiButtonBase-root.MuiButton-root.MuiButton-text.MuiButton-textInherit.MuiButton-sizeMedium.MuiButton-textSizeMedium.MuiButton-colorInherit {
      display: inline-flex;
      -webkit-box-align: center;
      align-items: center;
      -webkit-box-pack: center;
      justify-content: center;
      position: relative;
      box-sizing: border-box;
      -webkit-tap-highlight-color: transparent;
      cursor: pointer;
      user-select: none;
      vertical-align: middle;
      color: currentcolor;
      appearance: none;
      font-family: "Noto Sans", sans-serif;
      font-weight: 500;
      font-size: 0.875rem;
      line-height: 1.75;
      text-transform: none;
      min-width: 64px;
      background-color: var(--variant-textBg);
      color: inherit;
      --variant-containedBg: var(--jf-palette-Button-inheritContainedBg);
      outline: 0px;
      margin: 0px;
      text-decoration: none;
      border-width: 0px;
      border-style: none;
      border-image: initial;
      border-radius: var(--jf-shape-borderRadius);
      padding: 6px 8px;
      border-color: currentcolor;
      transition: background-color 250ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 250ms cubic-bezier(0.4, 0, 0.2, 1), border-color 250ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  span.MuiButton-icon.MuiButton-startIcon.MuiButton-iconSizeMedium.monwui-watchlist-nav-icon {
      font-size: 18px;
  }
  `;
  document.head.appendChild(style);
}

function forceSkinHeaderPointerEvents() {
  ensurePointerStylesInjected();
}

function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(selector);
    if (existing) return resolve(existing);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    const to = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Zaman aşımı bekleniyor ${selector}`));
    }, timeout);
    const cleanupResolve = (el) => {
      clearTimeout(to);
      return el;
    };
    resolve = ((orig) => (v) => orig(cleanupResolve(v)))(resolve);
  });
}

function createPlayerButton() {
  const cfg = getConfig();
  if (typeof cfg !== "undefined" && cfg.enabledGmmp !== false) {
    const btn = document.createElement("button");
    btn.id = "jellyfinPlayerToggle";
    btn.type = "button";
    btn.setAttribute("aria-label", "GMMP Aç/Kapa");
    btn.title = "GMMP";
    btn.innerHTML = faIconHtml("play", "gmmp");
    return btn;
  }
  return null;
}

function ensurePlayerButtonMounted() {
  const cfg = getConfig();
  if (cfg?.enabledGmmp === false) {
    stopRemoteGmmpSync();
    document.getElementById("jellyfinPlayerToggle")?.remove?.();
    return true;
  }

  const { element: header, mode } = findHeaderMountTarget({ variant: "actions" });
  if (!header) return false;

  let btn = document.getElementById("jellyfinPlayerToggle");
  if (!btn) {
    btn = createPlayerButton();
    if (!btn) return false;
    btn.addEventListener("click", onToggleClick, { passive: true });
  }

  applyHeaderIconButtonMode(btn, mode, {
    legacyClassName: PLAYER_HEADER_LEGACY_CLASS,
  });

  if (btn.parentElement === header) return true;

  try {
    header.insertBefore(btn, header.firstChild);
  } catch {
    header.appendChild(btn);
  }

  return true;
}

function startPlayerButtonSentinel() {
  if (playerHeaderObserver) return;
  const root = document.body || document.documentElement;
  if (!root) return;

  playerHeaderObserver = new MutationObserver(() => {
    ensurePlayerButtonMounted();
  });

  try {
    playerHeaderObserver.observe(root, { childList: true, subtree: true });
  } catch {
    try { playerHeaderObserver.disconnect(); } catch {}
    playerHeaderObserver = null;
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      ensurePlayerButtonMounted();
    }
  });
}

let initInProgress = false;

installRemoteGmmpLifecycleHooks();
ensureRemoteGmmpSync();

async function onToggleClick() {
  if (initInProgress) return;

  try {
    forceSkinHeaderPointerEvents();
    initializeControlStates();

    if (!isPlayerInitialized()) {
      initInProgress = true;

      await loadJSMediaTags();
      await initPlayer();
      await new Promise(r => setTimeout(r, 250));
      queueMicrotask(() => {
      const run = async () => {
        try {
          const dbIsEmpty = async () => {
            try {
              const t = await window.__musicDB?.getAllTracks?.();
              return !t || t.length === 0;
            } catch {
              return true;
            }
          };
          const r = await syncDbIncremental().catch(() => null);

          if (!r || r.skipped === "no-credentials" || await dbIsEmpty()) {
            await syncDbFullscan({ force: true }).catch(() => {});
          }
        } catch {}
      };

  if ("requestIdleCallback" in window) requestIdleCallback(run, { timeout: 5000 });
  else setTimeout(run, 800);
});

      togglePlayerVisibility();
      await refreshPlaylist();
      setTimeout(() => {
        try {
          updateDuration();
          updateProgress();
        } catch (e) {
          console.debug("Progress/duration update skipped:", e);
        }
      }, 500);

    } else {
      togglePlayerVisibility();
    }
  } catch (err) {
    console.error("GMMP geçiş hatası:", err);
  } finally {
    initInProgress = false;
  }
}

export async function addPlayerButton() {
  try {
    forceSkinHeaderPointerEvents();
    loadCSS();

    if (!ensurePlayerButtonMounted()) {
      await waitForElement(getHeaderMountWaitSelector("actions"));
      ensurePlayerButtonMounted();
    }
    startPlayerButtonSentinel();
  } catch (err) {
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    forceSkinHeaderPointerEvents();
    addPlayerButton();
    scheduleGmmpNativePlaybackHook();
  }, { once: true });
} else {
  forceSkinHeaderPointerEvents();
  addPlayerButton();
  scheduleGmmpNativePlaybackHook();
}


if (typeof window !== "undefined") {
  window.__GMMP = window.__GMMP || {};
  Object.assign(window.__GMMP, {
    playTrackById,
    playAlbumById,
    playArtistById,
    playPlaylistById,
    playFolderById,
    ensureInit: ensureGmmpInit,
    destroy: destroyGmmp,
    installNativePlaybackHook: scheduleGmmpNativePlaybackHook,
    getPlaybackState: getGmmpPlaybackState,
    setPaused: setGmmpPaused,
    setMuted: setGmmpMuted,
    setVolume: setGmmpVolume
  });
}
