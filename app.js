import { isInsideBoundary } from "./point-in-polygon.js";

const BOUNDARY_URLS = {
  ceremonial: "data/boundaries/lincolnshire-ceremonial.geojson",
  administrative: "data/boundaries/lincolnshire-administrative.geojson",
};

const CROSSINGS_URL = "data/crossings.json";

const BOUNDARY_STORAGE_KEY = "back-to-lincolnshire:boundary-type";

const locationMessageEl = document.getElementById("location-message");
const statusMessageEl = document.getElementById("status-message");
const useLocationBtn = document.getElementById("use-location-btn");
const addressForm = document.getElementById("address-form");
const addressInput = document.getElementById("address-input");
const boundarySelect = document.getElementById("boundary-select");
const routeResultEl = document.getElementById("route-result");
const routePrimaryEl = document.getElementById("route-primary");
const routeAlternativesEl = document.getElementById("route-alternatives");

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

  const requestId = ++routeRequestId;
  routeResultEl.hidden = false;
  routePrimaryEl.textContent = "Calculating route...";
  routeAlternativesEl.innerHTML = "";

  const settled = await Promise.allSettled(
    nearest.map((crossing) =>
      fetch(
        `https://router.project-osrm.org/route/v1/driving/${lastPoint[0]},${lastPoint[1]};${crossing.lon},${crossing.lat}?overview=full&geometries=geojson`
      )
        .then((response) => response.json())
        .then((data) => {
          const route = data.routes && data.routes[0];
          if (!route) throw new Error("No route returned");
          return {
            crossing,
            duration: route.duration,
            distance: route.distance,
            geometry: route.geometry,
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
    routePrimaryEl.textContent = "Couldn't calculate a route right now.";
    routeAlternativesEl.innerHTML = "";
    return;
  }

  const fastest = routes[0];
  const minutes = Math.round(fastest.duration / 60);
  routePrimaryEl.textContent = `Fastest route back: ${fastest.crossing.name}, about ${minutes} minutes`;

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

  locationMessageEl.textContent = "Searching...";

  // Nominatim usage policy (https://operations.osmfoundation.org/policies/nominatim/)
  // requires a descriptive User-Agent or Referer identifying the application.
  // Browsers automatically send Origin/Referer with fetch requests, but JS
  // cannot override the User-Agent header, and attempting to set one from
  // fetch() would be silently dropped or trigger a CORS preflight for no
  // benefit. Proper server-side identification will be added when this call
  // is proxied through a Cloudflare Pages Function in a later stage.
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(
    query
  )}&limit=1&countrycodes=gb`;

  try {
    const response = await fetch(url);
    const results = await response.json();
    if (!results.length) {
      locationMessageEl.textContent = "No results found.";
      return;
    }
    const { lat, lon } = results[0];
    locationMessageEl.textContent = "";
    setPoint(parseFloat(lon), parseFloat(lat));
  } catch (err) {
    locationMessageEl.textContent = "Something went wrong searching for that address.";
  }
});

async function loadBoundaries() {
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
}

loadBoundaries();
