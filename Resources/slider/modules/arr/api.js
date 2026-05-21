const ARR_ENDPOINT = "/Plugins/MonWUI/arr";

function tokenSafe() {
  try {
    return window.ApiClient?.accessToken?.() || window.ApiClient?._accessToken || "";
  } catch {
    return "";
  }
}

async function userIdSafe() {
  try {
    const user = await window.ApiClient?.getCurrentUser?.();
    return user?.Id || "";
  } catch {
    return "";
  }
}

async function headers(json = true) {
  const h = { Accept: "application/json" };
  if (json) h["Content-Type"] = "application/json";
  const token = tokenSafe();
  const userId = await userIdSafe();
  if (token) h["X-Emby-Token"] = token;
  if (userId) h["X-Emby-UserId"] = userId;
  return h;
}

async function request(path = "", options = {}) {
  const res = await fetch(`${ARR_ENDPOINT}${path}`, {
    cache: "no-store",
    ...options,
    headers: {
      ...(await headers(options.body !== undefined)),
      ...(options.headers || {})
    }
  });

  const raw = await res.text();
  let data = {};
  if (raw) {
    try { data = JSON.parse(raw); } catch { data = { raw }; }
  }

  if (!res.ok) {
    const message = data?.error || data?.message || `Arr HTTP ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    error.payload = data;
    throw error;
  }

  return data;
}

export async function getArrSettings() {
  return request("/settings");
}

export async function saveArrSettings(settings = {}) {
  return request("/settings", {
    method: "POST",
    body: JSON.stringify(settings || {})
  });
}

export async function testArrConnection() {
  return request("/test", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export async function testSonarrConnection() {
  return request("/sonarr/test", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export async function testRadarrConnection() {
  return request("/radarr/test", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export async function getSonarrOptions() {
  return request("/sonarr/options");
}

export async function getRadarrOptions() {
  return request("/radarr/options");
}

export async function requestArrEpisode(payload = {}) {
  return request("/episode", {
    method: "POST",
    body: JSON.stringify(payload || {})
  });
}

export async function requestArrMovie(payload = {}) {
  return request("/movie", {
    method: "POST",
    body: JSON.stringify(payload || {})
  });
}
