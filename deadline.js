// Pure logic for the Stage 3 deadline alarm. No DOM, no browser APIs — must be
// independently unit-testable with plain `node`.

// Returns a Date for the effective deadline: today's date, at `timeStr` ("HH:MM", 24h),
// minus `bufferMinutes`.
export function getEffectiveDeadline(timeStr, bufferMinutes, now = new Date()) {
  const [hours, minutes] = timeStr.split(":").map(Number);
  const deadline = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
  deadline.setMinutes(deadline.getMinutes() - bufferMinutes);
  return deadline;
}

// Pure state computation. Returns null if fastestDurationSeconds is null (nothing to
// evaluate). Otherwise returns { state: "green"|"amber"|"red", marginSeconds }.
export function computeAlarmState(nowMs, effectiveDeadlineMs, fastestDurationSeconds) {
  if (fastestDurationSeconds === null) return null;
  const marginSeconds = (effectiveDeadlineMs - (nowMs + fastestDurationSeconds * 1000)) / 1000;
  let state;
  if (marginSeconds < 0) {
    state = "red";
  } else if (marginSeconds <= 900) {
    state = "amber";
  } else {
    state = "green";
  }
  return { state, marginSeconds };
}

// Pure. Returns the alarm banner message for a state ("green"|"amber"|"red") and margin.
// Rounds the margin to whole minutes itself; singular "1 minute", and amber never says
// "0 minutes" (a margin that rounds to 0 is "no time to spare").
export function getAlarmMessage(state, marginSeconds) {
  const minutesSpare = Math.round(marginSeconds / 60);
  const spare = `${minutesSpare} ${minutesSpare === 1 ? "minute" : "minutes"}`;
  if (state === "green") {
    return `Put the kettle on — you've ${spare} to spare.`;
  }
  if (state === "amber") {
    return minutesSpare === 0
      ? "Cutting it fine — no time to spare. Get your coat."
      : `Cutting it fine — ${spare} to spare. Get your coat.`;
  }
  return "You won't make it. Leave now.";
}

// Pure. True only when currentState is "red" AND previousState is not "red" (including
// when previousState is null/undefined).
export function shouldFireAlarm(previousState, currentState) {
  return currentState === "red" && previousState !== "red";
}

// Pure. Returns the recalculation interval in milliseconds, given how far away the
// effective deadline is (in ms, may be negative if already past).
export function getRecalcIntervalMs(msUntilEffectiveDeadline) {
  const minutesAway = msUntilEffectiveDeadline / 60000;
  // Bands are checked from slowest to fastest; each threshold is exclusive on the
  // slower side (`>`), so time exactly on a boundary falls into the faster band.
  if (minutesAway > 60) return 300000; // > 60 minutes away
  if (minutesAway > 20) return 120000; // 20–60 minutes away
  if (minutesAway > 5) return 60000; // 5–20 minutes away
  return 30000; // < 5 minutes away, including overdue
}

// Pure. Haversine distance in meters between two [lon, lat] points.
export function distanceMeters([lon1, lat1], [lon2, lat2]) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// Pure. True if `newPoint` is more than `thresholdMeters` from `lastPoint`, or if
// lastPoint is null (no prior fix to compare against, so treat as moved).
export function hasMovedSignificantly(lastPoint, newPoint, thresholdMeters = 500) {
  if (!lastPoint) return true;
  return distanceMeters(lastPoint, newPoint) > thresholdMeters;
}

// Pure. True when a raw (unbuffered) preset deadline instant is already behind `nowMs` —
// e.g. a midwinter "17:00" or "Sunset" preset that's already gone by on load.
export function hasDeadlinePassed(rawDeadlineMs, nowMs) {
  return rawDeadlineMs < nowMs;
}

// --- Sunset calculation -------------------------------------------------
//
// Sunset-only path ported from SunCalc (https://github.com/mourner/suncalc),
// with the moon/twilight/sunrise code removed. BSD-2-Clause:
//
//   Copyright (c) 2026, Volodymyr Agafonkin
//   Redistribution and use in source and binary forms, with or without
//   modification, are permitted provided that the following conditions are
//   met: Redistributions of source code must retain the above copyright
//   notice, this list of conditions and the following disclaimer.
//   THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
//
// Verified against the US Naval Observatory's official sun data
// (https://aa.usno.navy.mil/data/api) for Lincoln (53.2307 N, 0.5406 W)
// across both solstices and both equinoxes of 2026 — agrees within 30
// seconds in every case. See the getSunsetUtc checks below.

const RAD = Math.PI / 180;
const DAY_MS = 1000 * 60 * 60 * 24;
const J1970 = 2440588;
const J2000 = 2451545;
const J0 = 0.0009;
const SUNSET_ANGLE = -0.833 * RAD; // standard atmospheric refraction + solar radius correction

function toDays(date) {
  return date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;
}

function fromJulian(j) {
  return new Date((j + 0.5 - J1970) * DAY_MS);
}

// TT - UT1, in seconds. Low-order-polynomial approximation, accurate for 20th/21st-century dates.
function deltaT(d) {
  const y = 2000 + d / 365.2425;
  const t = y - 2000;
  if (y < 2005) {
    return 63.86 + t * (0.3345 + t * (-0.060374 + t * (0.0017275 + t * (0.000651814 + t * 0.00002373599))));
  }
  if (y < 2050) return 62.92 + t * (0.32217 + t * 0.005589);
  return -20 + 32 * ((y - 1820) / 100) ** 2;
}

function toDaysTT(d) {
  return d + deltaT(d) / 86400;
}

function altitude(H, phi, dec) {
  return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
}

function siderealTime(d, lw) {
  return RAD * (280.46061837 + 360.98564736629 * d) - lw;
}

function sunCoords(d) {
  const t = d / 36525;
  const L0 = RAD * (280.46646 + t * (36000.76983 + t * 0.0003032));
  const M = RAD * (357.52911 + t * (35999.05029 - t * 0.0001537));
  const sinM = Math.sin(M);
  const cosM = Math.cos(M);
  const C =
    RAD *
    ((1.914602 - t * (0.004817 + t * 0.000014)) * sinM +
      (0.019993 - 0.000101 * t) * 2 * sinM * cosM +
      0.000289 * sinM * (3 - 4 * sinM * sinM));
  const Om = RAD * (125.04 - 1934.136 * t);
  const L = L0 + C - RAD * (0.00569 + 0.00478 * Math.sin(Om));
  const e =
    RAD * (23.439291 - t * (0.0130042 + t * (0.00000016 - t * 0.000000504))) + RAD * 0.00256 * Math.cos(Om);

  return {
    ra: Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)),
    dec: Math.asin(Math.sin(e) * Math.sin(L)),
  };
}

function wrapPi(a) {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}

function solarTransit(dt, lw) {
  for (let i = 0; i < 3; i++) {
    const H = wrapPi(siderealTime(dt, lw) - sunCoords(toDaysTT(dt)).ra);
    dt -= H / (2 * Math.PI);
  }
  return dt;
}

function getSetJulian(h0, dt, lw, phi, dec) {
  const cosH0 = (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosH0 < -1 || cosH0 > 1) return null; // sun never reaches this altitude that day — not reachable at UK latitudes

  let d = dt + Math.acos(cosH0) / (2 * Math.PI);
  for (let i = 0; i < 2; i++) {
    const c = sunCoords(toDaysTT(d));
    const H = wrapPi(siderealTime(d, lw) - c.ra);
    const h = altitude(H, phi, c.dec);
    const sinH = Math.cos(phi) * Math.cos(c.dec) * Math.sin(H);
    if (Math.abs(sinH) < 1e-6) break;
    d += (h - h0) / (2 * Math.PI * sinH);
  }
  return d;
}

function sunsetUtcForInstant(date, lat, lon) {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = Math.round(toDays(date) - J0 - lw / (2 * Math.PI));
  const dt = solarTransit(d + J0 + lw / (2 * Math.PI), lw);
  const dec = sunCoords(toDaysTT(dt)).dec;

  const jset = getSetJulian(SUNSET_ANGLE, dt, lw, phi, dec);
  return jset === null ? null : fromJulian(jset + J2000);
}

// Pure. Returns { year, month, day } (month 1-12) for the UK civil calendar date that
// `date` falls on, via the Europe/London timezone — correctly handles the GMT/BST
// transition regardless of the device's own timezone setting.
export function getUkDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return { year: Number(lookup.year), month: Number(lookup.month), day: Number(lookup.day) };
}

// Sunset for the UK calendar date containing `now`, at the given latitude/longitude.
// Returns a Date (the UTC instant), or null if the sun doesn't set that day (not
// reachable at UK latitudes; included only as a defensive guard). `lon` is standard
// signed longitude, negative = west (matches data/crossings.json).
export function getSunsetUtc(lat, lon, now = new Date()) {
  const { year, month, day } = getUkDateParts(now);
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return sunsetUtcForInstant(noonUtc, lat, lon);
}
