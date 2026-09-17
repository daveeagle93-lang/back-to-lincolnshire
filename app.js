import { isInsideBoundary } from "./point-in-polygon.js";
import {
  getEffectiveDeadline,
  computeAlarmState,
  shouldFireAlarm,
  getRecalcIntervalMs,
  hasMovedSignificantly,
  hasDeadlinePassed,
  getSunsetUtc,
} from "./deadline.js";

const DEADLINE_PRESETS = ["12:00", "15:00", "17:00", "sunset"];
const UK_TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const BOUNDARY_URLS = {
  ceremonial: "data/boundaries/lincolnshire-ceremonial.geojson",
  administrative: "data/boundaries/lincolnshire-administrative.geojson",
};

const CROSSINGS_URL = "data/crossings.json";

const BOUNDARY_STORAGE_KEY = "back-to-lincolnshire:boundary-type";
const DEADLINE_TIME_STORAGE_KEY = "back-to-lincolnshire:deadline-time";
const BUFFER_MINUTES_STORAGE_KEY = "back-to-lincolnshire:buffer-minutes";

const locationMessageEl = document.getElementById("location-message");
const statusMessageEl = document.getElementById("status-message");
const useLocationBtn = document.getElementById("use-location-btn");
const addressForm = document.getElementById("address-form");
const addressInput = document.getElementById("address-input");
const boundarySelect = document.getElementById("boundary-select");
const routeResultEl = document.getElementById("route-result");
const routePrimaryEl = document.getElementById("route-primary");
const routeAlternativesEl = document.getElementById("route-alternatives");
const presetButtons = Array.from(document.querySelectorAll(".preset-btn"));
const sunsetStatusEl = document.getElementById("sunset-status");
const deadlineBufferInput = document.getElementById("deadline-buffer");
const alarmBannerEl = document.getElementById("alarm-banner");
const alarmMessageEl = document.getElementById("alarm-message");
const alarmCountdownEl = document.getElementById("alarm-countdown");
const alarmStaleNoticeEl = document.getElementById("alarm-stale-notice");
const installBtnEl = document.getElementById("install-btn");
const iosInstallHintEl = document.getElementById("ios-install-hint");
const offlineBannerEl = document.getElementById("offline-banner");
const appErrorEl = document.getElementById("app-error");
const shareNativeBtn = document.getElementById("share-native-btn");
const shareWhatsappBtn = document.getElementById("share-whatsapp-btn");
const shareXBtn = document.getElementById("share-x-btn");
const shareFacebookBtn = document.getElementById("share-facebook-btn");
const shareCopyBtn = document.getElementById("share-copy-btn");
const shareStatusEl = document.getElementById("share-status");

// Map, centred on Lincolnshire by default.
const map = L.map("map").setView([53.1, -0.3], 8);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

let marker = null;
let boundaryLayer = null;
let boundaryData = { ceremonial: null, administrative: null };
let lastPoint = null; // [lon, lat]
let crossings = [];
let routeLayer = null;
let routeRequestId = 0;
let lastFastestDurationSeconds = null;
let lastFastestCrossingName = null;
let lastGoodResultAt = null; // Date
let previousAlarmState = null;
let lastRecalcPoint = null; // [lon, lat] used for the most recent successful route computation
let selectedPreset = "15:00";
let sunsetInfo = null; // { deadlineMs, crossingName, originPoint } — held steady per-session, see maybeUpdateSunset
let audioCtx = null;
let wakeLock = null;
let deferredInstallPrompt = null;
const geocodeCache = new Map(); // normalized query -> { lat, lon, cachedAt: Date }
let geocodeRequestId = 0;
let lastOsrmBatchAt = 0;
const OSRM_BATCH_MIN_INTERVAL_MS = 1500;

function getBoundaryType() {
  const stored = localStorage.getItem(BOUNDARY_STORAGE_KEY);
  return stored === "administrative" ? "administrative" : "ceremonial";
}

function setBoundaryType(type) {
  localStorage.setItem(BOUNDARY_STORAGE_KEY, type);
}

function drawBoundary(type) {
  const data = boundaryData[type];
  if (!data) return;
  if (boundaryLayer) {
    map.removeLayer(boundaryLayer);
  }
  boundaryLayer = L.geoJSON(data, {
    style: { color: "#1a5d1a", weight: 2, fill: false },
  }).addTo(map);
}

function updateStatusMessage(type) {
  if (!lastPoint) {
    statusMessageEl.textContent = "";
    return;
  }
  const data = boundaryData[type];
  if (!data) {
    statusMessageEl.textContent = "";
    return;
  }
  const inside = isInsideBoundary(lastPoint, data);
  statusMessageEl.textContent = inside
    ? "You're already in Lincolnshire."
    : `You're outside Lincolnshire (${type} boundary).`;
}

function isOutsideBoundary(type) {
  const data = boundaryData[type];
  if (!lastPoint || !data) return false;
  return !isInsideBoundary(lastPoint, data);
}

function getCrossingsForBoundary(type) {
  return crossings.filter((crossing) => crossing.boundaries.includes(type));
}

function haversineDistanceKm([lon1, lat1], [lon2, lat2]) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function clearRoute() {
  routeRequestId += 1;
  routeResultEl.hidden = true;
  routePrimaryEl.textContent = "";
  routeAlternativesEl.innerHTML = "";
  if (routeLayer) {
    map.removeLayer(routeLayer);
    routeLayer = null;
  }
  lastFastestDurationSeconds = null;
  lastFastestCrossingName = null;
  lastGoodResultAt = null;
  previousAlarmState = null;
}

async function computeRoute(type) {
  if (!lastPoint) return;
  const candidates = getCrossingsForBoundary(type);
  if (!candidates.length) {
    clearRoute();
    return;
  }

  const nearest = candidates
    .map((crossing) => ({
      crossing,
      distance: haversineDistanceKm(lastPoint, [crossing.lon, crossing.lat]),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5)
    .map((entry) => entry.crossing);

  lastRecalcPoint = lastPoint;

  const requestId = ++routeRequestId;
  routeResultEl.hidden = false;
  routePrimaryEl.textContent = "Calculating route...";
  routeAlternativesEl.innerHTML = "";

  // Light throttling: smooth out bursts (rapid boundary toggling, the background
  // recalc loop, and manual retries all independently calling computeRoute) rather
  // than firing a fresh batch of OSRM requests with no minimum spacing between them.
  const sinceLastBatch = Date.now() - lastOsrmBatchAt;
  if (lastOsrmBatchAt !== 0 && sinceLastBatch < OSRM_BATCH_MIN_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, OSRM_BATCH_MIN_INTERVAL_MS - sinceLastBatch));
    if (requestId !== routeRequestId) return; // superseded while debounced
  }
  lastOsrmBatchAt = Date.now();

  const settled = await Promise.allSettled(
    nearest.map((crossing) =>
      fetch(
        `/api/route?from=${lastPoint[0]},${lastPoint[1]}&to=${crossing.lon},${crossing.lat}`
      )
        .then((response) => {
          if (response.status === 429) throw new Error("rate-limited");
          const cachedAt = response.headers.get("X-Cached-At");
          return response.json().then((data) => ({ data, cachedAt }));
        })
        .then(({ data, cachedAt }) => {
          const route = data.routes && data.routes[0];
          if (!route) throw new Error("No route returned");
          return {
            crossing,
            duration: route.duration,
            distance: route.distance,
            geometry: route.geometry,
            cachedAt, // set when this came from the SW's runtime cache fallback, not a live network response
          };
        })
    )
  );

  if (requestId !== routeRequestId) return; // superseded by a newer request

  const routes = settled
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .sort((a, b) => a.duration - b.duration);

  if (!routes.length) {
    // Prefer showing a cached last-known-good estimate (honestly timestamped) over a
    // bare "try again" message when one's available — the user needs a number to
    // decide whether to leave, not just to be told the service is busy.
    if (lastFastestDurationSeconds !== null) {
      const minutes = Math.round(lastFastestDurationSeconds / 60);
      const asOf = lastGoodResultAt.toLocaleTimeString();
      routePrimaryEl.textContent = `Fastest route back: ${lastFastestCrossingName}, about ${minutes} minutes (as of ${asOf})`;
    } else {
      const rateLimited = settled.some(
        (result) => result.status === "rejected" && result.reason && result.reason.message === "rate-limited"
      );
      routePrimaryEl.textContent = rateLimited
        ? "Routing service is busy right now — try again in a moment."
        : "Couldn't calculate a route right now.";
    }
    routeAlternativesEl.innerHTML = "";
    return;
  }

  const fastest = routes[0];
  const minutes = Math.round(fastest.duration / 60);
  lastFastestDurationSeconds = fastest.duration;
  lastFastestCrossingName = fastest.crossing.name;
  maybeUpdateSunset(fastest.crossing);
  if (fastest.cachedAt) {
    // Served from the service worker's offline cache fallback, not a live network
    // response — show it as such rather than presenting it as fresh.
    lastGoodResultAt = new Date(fastest.cachedAt);
    const asOf = lastGoodResultAt.toLocaleTimeString();
    routePrimaryEl.textContent = `Fastest route back: ${fastest.crossing.name}, about ${minutes} minutes (as of ${asOf})`;
  } else {
    lastGoodResultAt = new Date();
    routePrimaryEl.textContent = `Fastest route back: ${fastest.crossing.name}, about ${minutes} minutes`;
  }

  routeAlternativesEl.innerHTML = "";
  routes.slice(1, 3).forEach((entry) => {
    const li = document.createElement("li");
    li.textContent = `${entry.crossing.name} — about ${Math.round(entry.duration / 60)} minutes`;
    routeAlternativesEl.appendChild(li);
  });

  if (routeLayer) {
    map.removeLayer(routeLayer);
  }
  routeLayer = L.geoJSON(fastest.geometry, {
    style: { color: "#1a5d1a", weight: 4 },
  }).addTo(map);
}

function setPoint(lon, lat) {
  lastPoint = [lon, lat];
  if (marker) {
    marker.setLatLng([lat, lon]);
  } else {
    marker = L.marker([lat, lon]).addTo(map);
  }
  map.setView([lat, lon], 12);
  updateStatusMessage(boundarySelect.value);
  if (isOutsideBoundary(boundarySelect.value)) {
    computeRoute(boundarySelect.value);
  } else {
    clearRoute();
  }
}

function initDeadlineInputs() {
  const storedPreset = localStorage.getItem(DEADLINE_TIME_STORAGE_KEY);
  if (storedPreset && DEADLINE_PRESETS.includes(storedPreset)) selectedPreset = storedPreset;
  const storedBuffer = localStorage.getItem(BUFFER_MINUTES_STORAGE_KEY);
  if (storedBuffer !== null) deadlineBufferInput.value = storedBuffer;
  renderPresetButtons();
}

function renderPresetButtons() {
  presetButtons.forEach((btn) => {
    const isSelected = btn.dataset.preset === selectedPreset;
    btn.classList.toggle("selected", isSelected);
    btn.setAttribute("aria-pressed", String(isSelected));
  });
  updateSunsetStatusText();
}

function formatUkTime(ms) {
  return UK_TIME_FORMATTER.format(ms);
}

// The raw (unbuffered) deadline instant for `preset`, or null if it isn't resolvable
// yet (the "sunset" preset before any route has been computed).
function getRawDeadlineMs(preset) {
  if (preset === "sunset") return sunsetInfo ? sunsetInfo.deadlineMs : null;
  return getEffectiveDeadline(preset, 0).getTime();
}

function formatPresetLabel(preset, rawDeadlineMs) {
  return preset === "sunset" ? `Sunset (${formatUkTime(rawDeadlineMs)})` : preset;
}

// Computes sunset for the crossing the fastest route currently heads to, once routing
// has run. Held steady for the session and only recomputed if the person's search
// origin has moved significantly since the point it was last computed from — a new
// fastest crossing alone (ties, minor route changes) doesn't trigger a recompute.
function maybeUpdateSunset(crossing) {
  if (sunsetInfo && !hasMovedSignificantly(sunsetInfo.originPoint, lastPoint)) return;
  const sunsetDate = getSunsetUtc(crossing.lat, crossing.lon);
  if (!sunsetDate) return; // defensive; sunset is always reachable at UK latitudes
  sunsetInfo = { deadlineMs: sunsetDate.getTime(), crossingName: crossing.name, originPoint: lastPoint };
  updateSunsetStatusText();
  if (selectedPreset === "sunset") tickAlarm();
}

function updateSunsetStatusText() {
  sunsetStatusEl.textContent = sunsetInfo
    ? `Sunset: ${formatUkTime(sunsetInfo.deadlineMs)} (based on ${sunsetInfo.crossingName})`
    : "Sunset: pending — run a search to calculate it.";
}

function formatCountdown(msRemaining) {
  const overdue = msRemaining < 0;
  const totalSeconds = Math.floor(Math.abs(msRemaining) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  const time = hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
  return overdue ? `${time} over` : `${time} to go`;
}

function tickAlarm() {
  if (lastFastestDurationSeconds === null) {
    alarmBannerEl.hidden = true;
    releaseWakeLock();
    return;
  }

  const rawDeadlineMs = getRawDeadlineMs(selectedPreset);
  if (rawDeadlineMs === null) {
    alarmBannerEl.hidden = false;
    alarmBannerEl.classList.remove("state-green", "state-amber", "state-red", "state-passed");
    alarmMessageEl.textContent = "Sunset time pending — run a search to calculate it.";
    alarmCountdownEl.textContent = "";
    alarmStaleNoticeEl.hidden = true;
    releaseWakeLock();
    return;
  }

  if (hasDeadlinePassed(rawDeadlineMs, Date.now())) {
    alarmBannerEl.hidden = false;
    alarmBannerEl.classList.remove("state-green", "state-amber", "state-red");
    alarmBannerEl.classList.add("state-passed");
    alarmMessageEl.textContent = `${formatPresetLabel(selectedPreset, rawDeadlineMs)} has already passed today.`;
    alarmCountdownEl.textContent = "";
    alarmStaleNoticeEl.hidden = true;
    releaseWakeLock();
    return;
  }

  if (!wakeLock) requestWakeLock();

  const bufferMinutes = Number(deadlineBufferInput.value);
  const effectiveDeadlineMs = rawDeadlineMs - bufferMinutes * 60000;
  const result = computeAlarmState(Date.now(), effectiveDeadlineMs, lastFastestDurationSeconds);
  if (!result) {
    alarmBannerEl.hidden = true;
    releaseWakeLock();
    return;
  }

  alarmBannerEl.hidden = false;
  alarmBannerEl.classList.remove("state-green", "state-amber", "state-red", "state-passed");
  alarmBannerEl.classList.add(`state-${result.state}`);

  const minutesSpare = Math.round(result.marginSeconds / 60);
  if (result.state === "green") {
    alarmMessageEl.textContent = `You'll make it, with ${minutesSpare} minutes to spare.`;
  } else if (result.state === "amber") {
    alarmMessageEl.textContent = `Cutting it close — about ${minutesSpare} minutes of margin left.`;
  } else {
    alarmMessageEl.textContent = "You won't make it — leave now!";
  }

  alarmCountdownEl.textContent = formatCountdown(effectiveDeadlineMs - Date.now());

  const staleMs = lastGoodResultAt ? Date.now() - lastGoodResultAt.getTime() : 0;
  if (lastGoodResultAt && staleMs > 3 * 60 * 1000) {
    alarmStaleNoticeEl.hidden = false;
    alarmStaleNoticeEl.textContent = `Estimate as of ${lastGoodResultAt.toLocaleTimeString()}`;
  } else {
    alarmStaleNoticeEl.hidden = true;
  }

  if (shouldFireAlarm(previousAlarmState, result.state)) {
    fireAlarm();
  }
  previousAlarmState = result.state;
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch (err) {
    // e.g. not allowed while hidden, or unsupported; fail silently, this is a nice-to-have.
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

function unlockAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  if (!audioCtx) {
    audioCtx = new AudioContextClass();
  } else if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

function playAlarmSound() {
  if (!audioCtx) return; // not yet unlocked by a user gesture
  const beepCount = 3;
  const beepDuration = 0.15;
  const gap = 0.1;
  for (let i = 0; i < beepCount; i++) {
    const startTime = audioCtx.currentTime + i * (beepDuration + gap);
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    oscillator.frequency.value = 880;
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(0.3, startTime + 0.02);
    gainNode.gain.linearRampToValueAtTime(0, startTime + beepDuration);
    oscillator.start(startTime);
    oscillator.stop(startTime + beepDuration);
  }
}

function fireAlarm() {
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification("Back to Lincolnshire", { body: "You won't make it — leave now!" });
    } catch (err) {
      // Some browsers throw if not in a suitable context; fall through to the audible alarm.
    }
  }
  playAlarmSound();
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject);
  });
}

async function attemptRecalc(type) {
  if (document.visibilityState !== "visible") return;
  if (!isOutsideBoundary(type) || !("geolocation" in navigator)) return;
  let position;
  try {
    position = await getCurrentPosition();
  } catch (err) {
    return;
  }
  const newPoint = [position.coords.longitude, position.coords.latitude];
  if (!hasMovedSignificantly(lastRecalcPoint, newPoint)) return;
  setPoint(newPoint[0], newPoint[1]);
  lastRecalcPoint = newPoint;
}

function scheduleRecalc() {
  const type = boundarySelect.value;
  let delay = 120000; // fallback if we don't yet have a deadline-based figure
  const rawDeadlineMs = lastFastestDurationSeconds !== null ? getRawDeadlineMs(selectedPreset) : null;
  if (rawDeadlineMs !== null) {
    const bufferMinutes = Number(deadlineBufferInput.value);
    delay = getRecalcIntervalMs(rawDeadlineMs - bufferMinutes * 60000 - Date.now());
  }
  setTimeout(() => attemptRecalc(type).finally(scheduleRecalc), delay);
}

presetButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedPreset = btn.dataset.preset;
    localStorage.setItem(DEADLINE_TIME_STORAGE_KEY, selectedPreset);
    renderPresetButtons();
    tickAlarm();
  });
});

deadlineBufferInput.addEventListener("input", () => {
  localStorage.setItem(BUFFER_MINUTES_STORAGE_KEY, deadlineBufferInput.value);
  tickAlarm();
});

document.body.addEventListener("click", unlockAudioContext, { once: true });
// iOS Safari's autoplay-unlock is most reliably satisfied by a touch gesture; add
// touchend alongside click since unlockAudioContext is idempotent.
document.body.addEventListener("touchend", unlockAudioContext, { once: true });

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && lastFastestDurationSeconds !== null) {
    requestWakeLock();
  }
});

boundarySelect.addEventListener("change", () => {
  const type = boundarySelect.value;
  setBoundaryType(type);
  drawBoundary(type);
  updateStatusMessage(type);
  if (isOutsideBoundary(type)) {
    computeRoute(type);
  } else {
    clearRoute();
  }
});

useLocationBtn.addEventListener("click", () => {
  locationMessageEl.textContent = "";
  if (!("geolocation" in navigator)) {
    locationMessageEl.textContent = "Geolocation isn't supported by your browser.";
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      setPoint(position.coords.longitude, position.coords.latitude);
    },
    (error) => {
      let message = "Couldn't get your location.";
      if (error.code === error.PERMISSION_DENIED) {
        message = "Location access was denied. You can type an address instead.";
      } else if (error.code === error.POSITION_UNAVAILABLE) {
        message = "Your location is currently unavailable.";
      } else if (error.code === error.TIMEOUT) {
        message = "Timed out trying to get your location.";
      }
      locationMessageEl.textContent = message;
    }
  );
});

addressForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = addressInput.value.trim();
  if (!query) return;
  const normalizedQuery = query.toLowerCase();

  const requestId = ++geocodeRequestId;

  // Client-side cache of results already fetched this session — avoids a network
  // call entirely for a repeated/duplicate query, distinct from the service
  // worker's offline-fallback cache which only kicks in on network failure.
  const cached = geocodeCache.get(normalizedQuery);
  if (cached) {
    setPoint(cached.lon, cached.lat);
    locationMessageEl.textContent = `Showing a cached search result from ${cached.cachedAt.toLocaleTimeString()}.`;
    return;
  }

  locationMessageEl.textContent = "Searching...";

  // Proxied through a same-origin Pages Function, which sets a proper
  // Nominatim User-Agent/contact and applies rate limiting and caching
  // server-side — the browser never talks to Nominatim directly.
  const url = `/api/geocode?q=${encodeURIComponent(query)}`;

  try {
    const response = await fetch(url);
    if (response.status === 429) {
      if (requestId !== geocodeRequestId) return; // superseded by a newer search
      locationMessageEl.textContent = "Search is busy right now — try again in a moment.";
      return;
    }
    const cachedAt = response.headers.get("X-Cached-At");
    const results = await response.json();
    if (requestId !== geocodeRequestId) return; // superseded by a newer search
    if (!results.length) {
      locationMessageEl.textContent = "No results found.";
      return;
    }
    const { lat, lon } = results[0];
    const parsedLat = parseFloat(lat);
    const parsedLon = parseFloat(lon);
    setPoint(parsedLon, parsedLat);
    if (cachedAt) {
      // A cachedAt header means this is a stale SW-cache fallback, not a live geocode —
      // say so rather than silently presenting it as current. Not stored in the
      // client-side cache, since it's already a fallback result, not a fresh one.
      locationMessageEl.textContent = `Showing a cached search result from ${new Date(cachedAt).toLocaleTimeString()} (offline).`;
    } else {
      geocodeCache.set(normalizedQuery, { lat: parsedLat, lon: parsedLon, cachedAt: new Date() });
      locationMessageEl.textContent = "";
    }
  } catch (err) {
    if (requestId !== geocodeRequestId) return; // superseded by a newer search
    locationMessageEl.textContent = "Something went wrong searching for that address.";
  }
});

async function loadBoundaries() {
  try {
    const [ceremonial, administrative, crossingsData] = await Promise.all([
      fetch(BOUNDARY_URLS.ceremonial).then((r) => r.json()),
      fetch(BOUNDARY_URLS.administrative).then((r) => r.json()),
      fetch(CROSSINGS_URL).then((r) => r.json()),
    ]);
    boundaryData.ceremonial = ceremonial;
    boundaryData.administrative = administrative;
    crossings = crossingsData;

    const type = getBoundaryType();
    boundarySelect.value = type;
    drawBoundary(type);
    updateStatusMessage(type);
  } catch (err) {
    appErrorEl.textContent = "Couldn't load boundary data — check your connection and reload.";
    appErrorEl.hidden = false;
  }
}

initDeadlineInputs();
tickAlarm();
setInterval(tickAlarm, 1000);

if ("Notification" in window && Notification.permission === "default") {
  Notification.requestPermission();
}

scheduleRecalc();

loadBoundaries();

offlineBannerEl.hidden = navigator.onLine;
window.addEventListener("online", () => {
  offlineBannerEl.hidden = true;
});
window.addEventListener("offline", () => {
  offlineBannerEl.hidden = false;
});

const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isStandalone =
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

if (isIos && !isStandalone) {
  iosInstallHintEl.hidden = false;
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (!isStandalone) installBtnEl.hidden = false;
});

installBtnEl.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBtnEl.hidden = true;
});

const SHARE_MESSAGE = "Hey, fellow Yellow Belly — found this useful tool, you might like it too.";

function getShareUrl() {
  return location.href;
}

function showShareStatus(text) {
  shareStatusEl.textContent = text;
  setTimeout(() => {
    if (shareStatusEl.textContent === text) shareStatusEl.textContent = "";
  }, 3000);
}

if (navigator.share) shareNativeBtn.hidden = false;

shareNativeBtn.addEventListener("click", async () => {
  try {
    await navigator.share({ title: document.title, text: SHARE_MESSAGE, url: getShareUrl() });
  } catch (err) {
    // AbortError when the user dismisses the share sheet; not an error worth surfacing.
  }
});

shareWhatsappBtn.addEventListener("click", () => {
  const text = `${SHARE_MESSAGE} ${getShareUrl()}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
});

shareXBtn.addEventListener("click", () => {
  const params = new URLSearchParams({ text: SHARE_MESSAGE, url: getShareUrl() });
  window.open(`https://twitter.com/intent/tweet?${params}`, "_blank", "noopener");
});

shareFacebookBtn.addEventListener("click", () => {
  const params = new URLSearchParams({ u: getShareUrl() });
  window.open(`https://www.facebook.com/sharer/sharer.php?${params}`, "_blank", "noopener");
});

shareCopyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(getShareUrl());
    showShareStatus("Link copied");
  } catch (err) {
    showShareStatus("Couldn't copy link");
  }
});

// Moved from an inline <script> in index.html so the CSP's script-src can
// omit 'unsafe-inline'.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
}
