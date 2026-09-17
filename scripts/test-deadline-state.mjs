#!/usr/bin/env node
// Verifies the pure deadline-alarm logic in deadline.js using injected fake times
// and fake drive durations (no real timers, no real OSRM calls).

import {
  getEffectiveDeadline,
  computeAlarmState,
  shouldFireAlarm,
  getRecalcIntervalMs,
  hasMovedSignificantly,
} from "../deadline.js";

let failures = 0;

function check(label, condition, details) {
  if (condition) {
    console.log(`PASS: ${label}`);
  } else {
    console.error(`FAIL: ${label}${details ? ` — ${details}` : ""}`);
    failures += 1;
  }
}

function main() {
  // 1. Fixed now + effective deadline.
  const now = new Date("2026-09-17T14:00:00");
  const effectiveDeadline = getEffectiveDeadline("15:00", 10, now);
  check(
    "getEffectiveDeadline computes 14:50",
    effectiveDeadline.getHours() === 14 && effectiveDeadline.getMinutes() === 50,
    `got ${effectiveDeadline.toISOString()}`
  );

  // 2. Green case: duration 20 minutes -> arrival 14:20, margin to 14:50 = 1800s.
  const greenResult = computeAlarmState(now.getTime(), effectiveDeadline.getTime(), 20 * 60);
  check("green case state", greenResult.state === "green", `got ${greenResult.state}`);
  check("green case margin", greenResult.marginSeconds === 1800, `got ${greenResult.marginSeconds}`);

  // 3. Amber case: duration 45 minutes -> arrival 14:45, margin to 14:50 = 300s.
  const amberResult = computeAlarmState(now.getTime(), effectiveDeadline.getTime(), 45 * 60);
  check("amber case state", amberResult.state === "amber", `got ${amberResult.state}`);
  check("amber case margin", amberResult.marginSeconds === 300, `got ${amberResult.marginSeconds}`);

  // 4. Red case: duration 55 minutes -> arrival 14:55, margin to 14:50 = -300s.
  const redResult = computeAlarmState(now.getTime(), effectiveDeadline.getTime(), 55 * 60);
  check("red case state", redResult.state === "red", `got ${redResult.state}`);
  check("red case margin", redResult.marginSeconds === -300, `got ${redResult.marginSeconds}`);

  // 5. Alarm fires exactly once, at the amber->red transition.
  const sequence = [null, "green", "green", "amber", "amber", "red", "red", "red"];
  const fired = [];
  for (let i = 0; i < sequence.length - 1; i++) {
    fired.push(shouldFireAlarm(sequence[i], sequence[i + 1]));
  }
  const expectedFired = [false, false, false, false, true, false, false];
  check(
    "shouldFireAlarm fires exactly once, at amber->red",
    JSON.stringify(fired) === JSON.stringify(expectedFired),
    `got ${JSON.stringify(fired)}`
  );

  // 6. getRecalcIntervalMs boundary check.
  check(
    "getRecalcIntervalMs: 90 minutes away -> 300000",
    getRecalcIntervalMs(90 * 60 * 1000) === 300000
  );
  check(
    "getRecalcIntervalMs: 40 minutes away -> 120000",
    getRecalcIntervalMs(40 * 60 * 1000) === 120000
  );
  check(
    "getRecalcIntervalMs: 10 minutes away -> 60000",
    getRecalcIntervalMs(10 * 60 * 1000) === 60000
  );
  check(
    "getRecalcIntervalMs: 2 minutes away -> 30000",
    getRecalcIntervalMs(2 * 60 * 1000) === 30000
  );
  check(
    "getRecalcIntervalMs: -5 minutes (overdue) -> 30000",
    getRecalcIntervalMs(-5 * 60 * 1000) === 30000
  );

  // 7. hasMovedSignificantly.
  // Lincoln Cathedral area: ~50m apart (small lat offset ~0.00045deg ~ 50m).
  const pointA = [-0.5387, 53.2344];
  const pointNear = [-0.5387, 53.23485]; // ~50m north
  // ~600m apart (lat offset ~0.0054deg ~ 600m).
  const pointFar = [-0.5387, 53.2398];

  check(
    "hasMovedSignificantly: ~50m apart is false",
    hasMovedSignificantly(pointA, pointNear) === false
  );
  check(
    "hasMovedSignificantly: ~600m apart is true",
    hasMovedSignificantly(pointA, pointFar) === true
  );
  check(
    "hasMovedSignificantly: null lastPoint is true",
    hasMovedSignificantly(null, pointA) === true
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main();
