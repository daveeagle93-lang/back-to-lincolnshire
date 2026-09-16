import { isInsideBoundary } from "./point-in-polygon.js";

const BOUNDARY_URLS = {
  ceremonial: "data/boundaries/lincolnshire-ceremonial.geojson",
  administrative: "data/boundaries/lincolnshire-administrative.geojson",
};

const BOUNDARY_STORAGE_KEY = "back-to-lincolnshire:boundary-type";

const locationMessageEl = document.getElementById("location-message");
const statusMessageEl = document.getElementById("status-message");
const useLocationBtn = document.getElementById("use-location-btn");
const addressForm = document.getElementById("address-form");
const addressInput = document.getElementById("address-input");
const boundarySelect = document.getElementById("boundary-select");

// Map, centred on Lincolnshire by default.
const map = L.map("map").setView([53.1, -0.3], 8);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

let marker = null;
let boundaryLayer = null;
let boundaryData = { ceremonial: null, administrative: null };
let lastPoint = null; // [lon, lat]

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

function setPoint(lon, lat) {
  lastPoint = [lon, lat];
  if (marker) {
    marker.setLatLng([lat, lon]);
  } else {
    marker = L.marker([lat, lon]).addTo(map);
  }
  map.setView([lat, lon], 12);
  updateStatusMessage(boundarySelect.value);
}

boundarySelect.addEventListener("change", () => {
  const type = boundarySelect.value;
  setBoundaryType(type);
  drawBoundary(type);
  updateStatusMessage(type);
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
  const [ceremonial, administrative] = await Promise.all([
    fetch(BOUNDARY_URLS.ceremonial).then((r) => r.json()),
    fetch(BOUNDARY_URLS.administrative).then((r) => r.json()),
  ]);
  boundaryData.ceremonial = ceremonial;
  boundaryData.administrative = administrative;

  const type = getBoundaryType();
  boundarySelect.value = type;
  drawBoundary(type);
  updateStatusMessage(type);
}

loadBoundaries();
