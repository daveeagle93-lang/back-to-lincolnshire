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
  } else if (marginSeconds <= 600) {
    state = "amber";
  } else {
    state = "green";
  }
  return { state, marginSeconds };
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
