import { showNotification } from "../player/ui/notification.js";
import { createCheckbox, createSection } from "../settings/shared.js";
import {
  getArrSettings,
  getRadarrOptions,
  getSonarrOptions,
  saveArrSettings,
  testRadarrConnection,
  testSonarrConnection
} from "../arr/api.js";
import { getSerrSettings, saveSerrSettings, testSerrConnection } from "./api.js";

function text(value, fallback = "") {
  const out = String(value ?? "").trim();
  return out || fallback;
}

function L(labels, key, fallback) {
  const value = labels?.[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function createInput(name, label, value = "", { type = "text", placeholder = "" } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "input-container";

  const lab = document.createElement("label");
  lab.htmlFor = name;
  lab.textContent = label;

  const input = document.createElement("input");
  input.id = name;
  input.name = name;
  input.type = type;
  input.value = value || "";
  input.placeholder = placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;

  wrap.append(lab, input);
  return wrap;
}

function createSelect(name, label, options = []) {
  const wrap = document.createElement("div");
  wrap.className = "input-container";

  const lab = document.createElement("label");
  lab.htmlFor = name;
  lab.textContent = label;

  const select = document.createElement("select");
  select.id = name;
  select.name = name;
  select.dataset.pendingValue = "";

  for (const option of options) {
    const opt = document.createElement("option");
    opt.value = String(option.value ?? "");
    opt.textContent = option.label ?? String(option.value ?? "");
    select.appendChild(opt);
  }

  wrap.append(lab, select);
  return wrap;
}

function setValues(panel, settings = {}) {
  const set = (name, value) => {
    const el = panel.querySelector(`[name="${name}"]`);
    if (!el) return;
    if (el.type === "checkbox") el.checked = value === true;
    else if (el.tagName === "SELECT") {
      const clean = value ?? "";
      el.dataset.pendingValue = String(clean);
      if (clean && !Array.from(el.options).some((option) => option.value === String(clean))) {
        const opt = document.createElement("option");
        opt.value = String(clean);
        opt.textContent = String(clean);
        el.appendChild(opt);
      }
      el.value = clean;
    } else el.value = value ?? "";
  };

  set("serrEnabled", settings.enabled === true);
  set("serrBaseUrl", settings.baseUrl || "");
  set("serrApiKey", settings.apiKey || "");
  set("serrDefaultLanguage", settings.defaultLanguage || "tr");
  set("serrRequestAsJellyfinUser", settings.requestAsJellyfinUser !== false);
  set("serrConfirmRequests", settings.confirmRequests !== false);
  set("serrShowMissingSearchButton", settings.showMissingSearchButton !== false);
  set("serrEnableNotifications", settings.enableNotifications !== false);
}

function setArrValues(panel, settings = {}) {
  const set = (name, value) => {
    const el = panel.querySelector(`[name="${name}"]`);
    if (!el) return;
    if (el.type === "checkbox") el.checked = value === true;
    else el.value = value ?? "";
  };

  set("arrEnabled", settings.enabled === true);
  set("arrSonarrEnabled", settings.sonarrEnabled === true);
  set("arrSonarrBaseUrl", settings.sonarrBaseUrl || "");
  set("arrSonarrApiKey", settings.sonarrApiKey || "");
  set("arrSonarrRootFolderPath", settings.sonarrRootFolderPath || "");
  set("arrSonarrQualityProfileId", settings.sonarrQualityProfileId || "");
  set("arrSonarrLanguageProfileId", settings.sonarrLanguageProfileId || "");
  set("arrSonarrSeasonFolder", settings.sonarrSeasonFolder !== false);
  set("arrSonarrSearchOnRequest", settings.sonarrSearchOnRequest !== false);
  set("arrRadarrEnabled", settings.radarrEnabled === true);
  set("arrRadarrBaseUrl", settings.radarrBaseUrl || "");
  set("arrRadarrApiKey", settings.radarrApiKey || "");
  set("arrRadarrRootFolderPath", settings.radarrRootFolderPath || "");
  set("arrRadarrQualityProfileId", settings.radarrQualityProfileId || "");
  set("arrRadarrSearchOnRequest", settings.radarrSearchOnRequest !== false);
}

function setSelectOptions(select, options, currentValue = "") {
  if (!select) return;
  const cleanCurrent = text(currentValue || select.value || select.dataset.pendingValue || "");
  select.innerHTML = "";
  for (const option of options) {
    const opt = document.createElement("option");
    opt.value = String(option.value ?? "");
    opt.textContent = option.label ?? String(option.value ?? "");
    select.appendChild(opt);
  }
  const values = new Set(Array.from(select.options).map((option) => option.value));
  if (cleanCurrent && !values.has(cleanCurrent)) {
    const opt = document.createElement("option");
    opt.value = cleanCurrent;
    opt.textContent = cleanCurrent;
    select.appendChild(opt);
  }
  select.value = cleanCurrent && values.has(cleanCurrent) || cleanCurrent ? cleanCurrent : "";
  select.dataset.pendingValue = select.value;
}

function formatBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let size = n;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function applySonarrOptions(panel, options = {}, labels = {}) {
  const qualityProfiles = Array.isArray(options?.qualityProfiles) ? options.qualityProfiles : [];
  const rootFolders = Array.isArray(options?.rootFolders) ? options.rootFolders : [];
  const languageProfiles = Array.isArray(options?.languageProfiles) ? options.languageProfiles : [];

  setSelectOptions(
    panel.querySelector('[name="arrSonarrQualityProfileId"]'),
    [
      { value: "", label: L(labels, "arrSelectQualityProfile", "Kalite profili seç") },
      ...qualityProfiles
        .filter((profile) => Number(profile?.id) > 0)
        .map((profile) => ({ value: String(profile.id), label: text(profile.name, `#${profile.id}`) }))
    ],
    panel.querySelector('[name="arrSonarrQualityProfileId"]')?.value
  );

  setSelectOptions(
    panel.querySelector('[name="arrSonarrRootFolderPath"]'),
    [
      { value: "", label: L(labels, "arrSelectRootFolder", "Dizin seç") },
      ...rootFolders
        .filter((folder) => text(folder?.path))
        .map((folder) => {
          const free = formatBytes(folder?.freeSpace);
          return {
            value: folder.path,
            label: free ? `${folder.path} (${free})` : folder.path
          };
        })
    ],
    panel.querySelector('[name="arrSonarrRootFolderPath"]')?.value
  );

  setSelectOptions(
    panel.querySelector('[name="arrSonarrLanguageProfileId"]'),
    [
      { value: "", label: L(labels, "arrLanguageProfileNone", "Yok / Sonarr v4") },
      ...languageProfiles
        .filter((profile) => Number(profile?.id) > 0)
        .map((profile) => ({ value: String(profile.id), label: text(profile.name, `#${profile.id}`) }))
    ],
    panel.querySelector('[name="arrSonarrLanguageProfileId"]')?.value
  );
}

async function refreshSonarrOptions(panel, labels) {
  const data = await getSonarrOptions();
  applySonarrOptions(panel, data?.options || {}, labels);
  return data?.options || {};
}

function applyRadarrOptions(panel, options = {}, labels = {}) {
  const qualityProfiles = Array.isArray(options?.qualityProfiles) ? options.qualityProfiles : [];
  const rootFolders = Array.isArray(options?.rootFolders) ? options.rootFolders : [];

  setSelectOptions(
    panel.querySelector('[name="arrRadarrQualityProfileId"]'),
    [
      { value: "", label: L(labels, "arrSelectQualityProfile", "Kalite profili seç") },
      ...qualityProfiles
        .filter((profile) => Number(profile?.id) > 0)
        .map((profile) => ({ value: String(profile.id), label: text(profile.name, `#${profile.id}`) }))
    ],
    panel.querySelector('[name="arrRadarrQualityProfileId"]')?.value
  );

  setSelectOptions(
    panel.querySelector('[name="arrRadarrRootFolderPath"]'),
    [
      { value: "", label: L(labels, "arrSelectRootFolder", "Dizin seç") },
      ...rootFolders
        .filter((folder) => text(folder?.path))
        .map((folder) => {
          const free = formatBytes(folder?.freeSpace);
          return {
            value: folder.path,
            label: free ? `${folder.path} (${free})` : folder.path
          };
        })
    ],
    panel.querySelector('[name="arrRadarrRootFolderPath"]')?.value
  );
}

async function refreshRadarrOptions(panel, labels) {
  const data = await getRadarrOptions();
  applyRadarrOptions(panel, data?.options || {}, labels);
  return data?.options || {};
}

function readValues(panel) {
  const value = (name) => panel.querySelector(`[name="${name}"]`)?.value ?? "";
  const checked = (name) => panel.querySelector(`[name="${name}"]`)?.checked === true;
  return {
    enabled: checked("serrEnabled"),
    baseUrl: text(value("serrBaseUrl")),
    apiKey: text(value("serrApiKey")),
    defaultLanguage: text(value("serrDefaultLanguage"), "tr"),
    requestAsJellyfinUser: checked("serrRequestAsJellyfinUser"),
    confirmRequests: checked("serrConfirmRequests"),
    showMissingSearchButton: checked("serrShowMissingSearchButton"),
    enableNotifications: checked("serrEnableNotifications")
  };
}

function readArrValues(panel) {
  const value = (name) => panel.querySelector(`[name="${name}"]`)?.value ?? "";
  const checked = (name) => panel.querySelector(`[name="${name}"]`)?.checked === true;
  const number = (name) => {
    const n = Number(value(name));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const radarrEnabled = checked("arrRadarrEnabled");
  const sonarrEnabled = checked("arrSonarrEnabled");
  const arrEnabledControl = panel.querySelector('[name="arrEnabled"]');
  return {
    enabled: arrEnabledControl ? checked("arrEnabled") : (radarrEnabled || sonarrEnabled),
    sonarrEnabled,
    sonarrBaseUrl: text(value("arrSonarrBaseUrl")),
    sonarrApiKey: text(value("arrSonarrApiKey")),
    sonarrRootFolderPath: text(value("arrSonarrRootFolderPath")),
    sonarrQualityProfileId: number("arrSonarrQualityProfileId"),
    sonarrLanguageProfileId: number("arrSonarrLanguageProfileId"),
    sonarrSeasonFolder: checked("arrSonarrSeasonFolder"),
    sonarrSearchOnRequest: checked("arrSonarrSearchOnRequest"),
    radarrEnabled,
    radarrBaseUrl: text(value("arrRadarrBaseUrl")),
    radarrApiKey: text(value("arrRadarrApiKey")),
    radarrRootFolderPath: text(value("arrRadarrRootFolderPath")),
    radarrQualityProfileId: number("arrRadarrQualityProfileId"),
    radarrSearchOnRequest: checked("arrRadarrSearchOnRequest")
  };
}

function setBusy(panel, isBusy) {
  panel.querySelectorAll("input,button,select").forEach((el) => {
    el.disabled = isBusy;
  });
}

export function createSerrPanel(config, labels) {
  const panel = document.createElement("div");
  panel.id = "serr-panel";
  panel.className = "settings-panel";

  const section = createSection(L(labels, "serrSettingsTab", "Seerr & Arr Entegrasyonu"));

  section.appendChild(createCheckbox(
    "serrEnabled",
    L(labels, "serrEnabled", "Seerr entegrasyonunu etkinleştir"),
    false
  ));
  section.appendChild(createCheckbox(
    "arrRadarrEnabled",
    L(labels, "arrRadarrEnabled", "Radarr'ı etkinleştir"),
    false
  ));
  section.appendChild(createCheckbox(
    "arrSonarrEnabled",
    L(labels, "arrSonarrEnabled", "Sonarr'ı etkinleştir"),
    false
  ));
  section.appendChild(createCheckbox(
    "serrConfirmRequests",
    L(labels, "serrConfirmRequests", "İstek göndermeden önce onay modalı göster"),
    true
  ));
  section.appendChild(createInput(
    "serrBaseUrl",
    L(labels, "serrBaseUrl", "Seerr URL"),
    "",
    { placeholder: "http://localhost:5055" }
  ));
  section.appendChild(createInput(
    "serrApiKey",
    L(labels, "serrApiKey", "Seerr API anahtarı"),
    "",
    { type: "password", placeholder: L(labels, "serrApiKeyPlaceholder", "Seerr ayarlarındaki API anahtarı") }
  ));
  section.appendChild(createInput(
    "serrDefaultLanguage",
    L(labels, "serrDefaultLanguage", "Seerr arama dili"),
    "tr",
    { placeholder: "tr, en, en-US" }
  ));
  section.appendChild(createCheckbox(
    "serrRequestAsJellyfinUser",
    L(labels, "serrRequestAsJellyfinUser", "Seerr kullanıcısını Jellyfin kullanıcı ID'si ile eşleştirmeyi dene"),
    true
  ));
  section.appendChild(createCheckbox(
    "serrShowMissingSearchButton",
    L(labels, "serrShowMissingSearchButton", "Jellyfin aramasında Seerr butonunu göster"),
    true
  ));
  section.appendChild(createCheckbox(
    "serrEnableNotifications",
    L(labels, "serrEnableNotifications", "Seerr isteklerini bildirim panelinde göster"),
    true
  ));

  const hint = document.createElement("div");
  hint.className = "description-text";
  hint.textContent = L(
    labels,
    "serrSettingsHint",
    "Admin kullanıcıların istekleri doğrudan Seerr'e gönderilir. Diğer kullanıcıların istekleri önce MonWUI bildirimlerinde admin onayına düşer."
  );
  section.appendChild(hint);

  const actions = document.createElement("div");
  actions.className = "setting-item";
  const testBtn = document.createElement("button");
  testBtn.type = "button";
  testBtn.className = "monwui-serr-test-btn";
  testBtn.textContent = L(labels, "serrTestConnection", "Bağlantıyı Test Et");
  testBtn.addEventListener("click", async () => {
    const old = testBtn.textContent;
    try {
      setBusy(panel, true);
      await saveSerrSettings(readValues(panel));
      testBtn.textContent = L(labels, "serrTesting", "Test ediliyor...");
      await testSerrConnection();
      showNotification(
        `<i class="fas fa-check" style="margin-right:8px;"></i>${L(labels, "serrConnectionOk", "Seerr bağlantısı başarılı.")}`,
        2800,
        "success"
      );
    } catch (error) {
      showNotification(
        `<i class="fas fa-triangle-exclamation" style="margin-right:8px;"></i>${error?.message || L(labels, "serrConnectionFailed", "Seerr bağlantısı başarısız.")}`,
        4200,
        "error"
      );
    } finally {
      testBtn.textContent = old;
      setBusy(panel, false);
    }
  });
  actions.appendChild(testBtn);
  section.appendChild(actions);

  panel.appendChild(section);

  const arrSection = createSection(L(labels, "arrSettingsSection", "Arr Fallback"));

  const sonarrHeading = document.createElement("div");
  sonarrHeading.className = "description-text";
  sonarrHeading.textContent = L(labels, "arrSonarrSection", "Sonarr");
  arrSection.appendChild(sonarrHeading);
  arrSection.appendChild(createInput(
    "arrSonarrBaseUrl",
    L(labels, "arrSonarrBaseUrl", "Sonarr URL"),
    "",
    { placeholder: "http://localhost:8989" }
  ));
  arrSection.appendChild(createInput(
    "arrSonarrApiKey",
    L(labels, "arrSonarrApiKey", "Sonarr API anahtarı"),
    "",
    { type: "password", placeholder: L(labels, "arrApiKeyPlaceholder", "Sonarr ayarlarındaki API anahtarı") }
  ));
  arrSection.appendChild(createSelect(
    "arrSonarrRootFolderPath",
    L(labels, "arrSonarrRootFolderPath", "Sonarr root folder path"),
    [{ value: "", label: L(labels, "arrSelectRootFolder", "Dizin seçmek için bağlantıyı test et") }]
  ));
  arrSection.appendChild(createSelect(
    "arrSonarrQualityProfileId",
    L(labels, "arrSonarrQualityProfileId", "Sonarr quality profile ID"),
    [{ value: "", label: L(labels, "arrSelectQualityProfile", "Kalite seçmek için bağlantıyı test et") }]
  ));
  arrSection.appendChild(createSelect(
    "arrSonarrLanguageProfileId",
    L(labels, "arrSonarrLanguageProfileId", "Sonarr language profile ID"),
    [{ value: "", label: L(labels, "arrLanguageProfileNone", "Yok / Sonarr v4") }]
  ));
  arrSection.appendChild(createCheckbox(
    "arrSonarrSeasonFolder",
    L(labels, "arrSonarrSeasonFolder", "Sonarr'da season folder kullan"),
    true
  ));
  arrSection.appendChild(createCheckbox(
    "arrSonarrSearchOnRequest",
    L(labels, "arrSonarrSearchOnRequest", "Fallback isteğinde bölümü hemen ara"),
    true
  ));

  const arrActions = document.createElement("div");
  arrActions.className = "setting-item";
  const arrTestBtn = document.createElement("button");
  arrTestBtn.type = "button";
  arrTestBtn.className = "monwui-arr-test-btn";
  arrTestBtn.textContent = L(labels, "arrTestConnection", "Sonarr Bağlantısını Test Et");
  arrTestBtn.addEventListener("click", async () => {
    const old = arrTestBtn.textContent;
    try {
      setBusy(panel, true);
      await saveArrSettings(readArrValues(panel));
      arrTestBtn.textContent = L(labels, "serrTesting", "Test ediliyor...");
      const data = await testSonarrConnection();
      applySonarrOptions(panel, data?.options || {}, labels);
      showNotification(
        `<i class="fas fa-check" style="margin-right:8px;"></i>${L(labels, "arrConnectionOk", "Sonarr bağlantısı başarılı.")}`,
        2800,
        "success"
      );
    } catch (error) {
      showNotification(
        `<i class="fas fa-triangle-exclamation" style="margin-right:8px;"></i>${error?.message || L(labels, "arrConnectionFailed", "Sonarr bağlantısı başarısız.")}`,
        4200,
        "error"
      );
    } finally {
      arrTestBtn.textContent = old;
      setBusy(panel, false);
    }
  });
  arrActions.appendChild(arrTestBtn);
  arrSection.appendChild(arrActions);

  const radarrHeading = document.createElement("div");
  radarrHeading.className = "description-text";
  radarrHeading.textContent = L(labels, "arrRadarrSection", "Radarr");
  arrSection.appendChild(radarrHeading);

  arrSection.appendChild(createInput(
    "arrRadarrBaseUrl",
    L(labels, "arrRadarrBaseUrl", "Radarr URL"),
    "",
    { placeholder: "http://localhost:7878" }
  ));
  arrSection.appendChild(createInput(
    "arrRadarrApiKey",
    L(labels, "arrRadarrApiKey", "Radarr API anahtarı"),
    "",
    { type: "password", placeholder: L(labels, "arrRadarrApiKeyPlaceholder", "Radarr ayarlarındaki API anahtarı") }
  ));
  arrSection.appendChild(createSelect(
    "arrRadarrRootFolderPath",
    L(labels, "arrRadarrRootFolderPath", "Radarr root folder path"),
    [{ value: "", label: L(labels, "arrSelectRootFolder", "Dizin seçmek için bağlantıyı test et") }]
  ));
  arrSection.appendChild(createSelect(
    "arrRadarrQualityProfileId",
    L(labels, "arrRadarrQualityProfileId", "Radarr quality profile ID"),
    [{ value: "", label: L(labels, "arrSelectQualityProfile", "Kalite seçmek için bağlantıyı test et") }]
  ));
  arrSection.appendChild(createCheckbox(
    "arrRadarrSearchOnRequest",
    L(labels, "arrRadarrSearchOnRequest", "Fallback isteğinde filmi hemen ara"),
    true
  ));

  const radarrActions = document.createElement("div");
  radarrActions.className = "setting-item";
  const radarrTestBtn = document.createElement("button");
  radarrTestBtn.type = "button";
  radarrTestBtn.className = "monwui-arr-radarr-test-btn";
  radarrTestBtn.textContent = L(labels, "arrRadarrTestConnection", "Radarr Bağlantısını Test Et");
  radarrTestBtn.addEventListener("click", async () => {
    const old = radarrTestBtn.textContent;
    try {
      setBusy(panel, true);
      await saveArrSettings(readArrValues(panel));
      radarrTestBtn.textContent = L(labels, "serrTesting", "Test ediliyor...");
      const data = await testRadarrConnection();
      applyRadarrOptions(panel, data?.options || {}, labels);
      showNotification(
        `<i class="fas fa-check" style="margin-right:8px;"></i>${L(labels, "arrRadarrConnectionOk", "Radarr bağlantısı başarılı.")}`,
        2800,
        "success"
      );
    } catch (error) {
      showNotification(
        `<i class="fas fa-triangle-exclamation" style="margin-right:8px;"></i>${error?.message || L(labels, "arrRadarrConnectionFailed", "Radarr bağlantısı başarısız.")}`,
        4200,
        "error"
      );
    } finally {
      radarrTestBtn.textContent = old;
      setBusy(panel, false);
    }
  });
  radarrActions.appendChild(radarrTestBtn);
  arrSection.appendChild(radarrActions);

  const arrHint = document.createElement("div");
  arrHint.className = "description-text";
  arrHint.textContent = L(
    labels,
    "arrSettingsHint",
    "Tek bölüm Seerr tarafından talep edilemezse Sonarr'a, film Seerr'de mevcut görünüp Jellyfin'de yoksa Radarr'a gönderilir."
  );
  arrSection.appendChild(arrHint);
  panel.appendChild(arrSection);

  panel.__monwuiSave = async () => {
    await Promise.all([
      saveSerrSettings(readValues(panel)),
      saveArrSettings(readArrValues(panel))
    ]);
  };

  panel.__monwuiLoad = async () => {
    const [serrData, arrData] = await Promise.all([
      getSerrSettings().catch(() => null),
      getArrSettings().catch(() => null)
    ]);
    setValues(panel, serrData?.settings || {});
    setArrValues(panel, arrData?.settings || {});
    await Promise.all([
      text(arrData?.settings?.sonarrBaseUrl) && text(arrData?.settings?.sonarrApiKey)
        ? refreshSonarrOptions(panel, labels).catch(() => {})
        : Promise.resolve(),
      text(arrData?.settings?.radarrBaseUrl) && text(arrData?.settings?.radarrApiKey)
        ? refreshRadarrOptions(panel, labels).catch(() => {})
        : Promise.resolve()
    ]);
    setArrValues(panel, arrData?.settings || {});
  };

  setTimeout(() => {
    panel.__monwuiLoad?.().catch(() => {});
  }, 0);

  return panel;
}
