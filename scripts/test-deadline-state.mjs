#!/usr/bin/env node
// Verifies the pure deadline-alarm logic in deadline.js using injected fake times
// and fake drive durations (no real timers, no real OSRM calls).

import {
  getEffectiveDeadline,
  computeAlarmState,
  getAlarmMessage,
  formatMinutes,
  shouldFireAlarm,
  getRecalcIntervalMs,
  hasMovedSignificantly,
  hasDeadlinePassed,
  getUkDateParts,
  getSunsetUtc,
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

  // 3b. Amber threshold is 15 minutes (900s), not the old 10 (600s): a margin of
  // exactly 900s is amber, 901s is green.
  check(
    "amber threshold: margin 900s -> amber",
    computeAlarmState(0, 900 * 1000, 0).state === "amber"
  );
  check(
    "amber threshold: margin 901s -> green",
    computeAlarmState(0, 901 * 1000, 0).state === "green"
  );

  // 3c. getAlarmMessage: singular "1 minute", and amber never says "0 minutes"
  // (a margin that rounds to 0 is "no time to spare"). Math.round(0.5) = 1, so 30s -> 1 minute.
  const NO_TIME = "Cutting it fine — no time to spare. Get your coat.";
  check(
    "getAlarmMessage: green 0s -> 0 minutes",
    getAlarmMessage("green", 0) === "Put the kettle on — you've 0 minutes to spare.",
    `got ${getAlarmMessage("green", 0)}`
  );
  check(
    "getAlarmMessage: green 60s -> 1 minute",
    getAlarmMessage("green", 60) === "Put the kettle on — you've 1 minute to spare.",
    `got ${getAlarmMessage("green", 60)}`
  );
  check(
    "getAlarmMessage: green 120s -> 2 minutes",
    getAlarmMessage("green", 120) === "Put the kettle on — you've 2 minutes to spare.",
    `got ${getAlarmMessage("green", 120)}`
  );
  check(
    "getAlarmMessage: amber 0s -> no time to spare",
    getAlarmMessage("amber", 0) === NO_TIME,
    `got ${getAlarmMessage("amber", 0)}`
  );
  check(
    "getAlarmMessage: amber 29s (rounds to 0) -> no time to spare",
    getAlarmMessage("amber", 29) === NO_TIME,
    `got ${getAlarmMessage("amber", 29)}`
  );
  check(
    "getAlarmMessage: amber 30s (rounds to 1) -> 1 minute",
    getAlarmMessage("amber", 30) === "Cutting it fine — 1 minute to spare. Get your coat.",
    `got ${getAlarmMessage("amber", 30)}`
  );
  check(
    "getAlarmMessage: amber 60s -> 1 minute",
    getAlarmMessage("amber", 60) === "Cutting it fine — 1 minute to spare. Get your coat.",
    `got ${getAlarmMessage("amber", 60)}`
  );
  check(
    "getAlarmMessage: amber 120s -> 2 minutes",
    getAlarmMessage("amber", 120) === "Cutting it fine — 2 minutes to spare. Get your coat.",
    `got ${getAlarmMessage("amber", 120)}`
  );
  check(
    "getAlarmMessage: red -> unchanged",
    getAlarmMessage("red", -300) === "You won't make it. Leave now.",
    `got ${getAlarmMessage("red", -300)}`
  );

  // 3d. formatMinutes: singular "1 minute", plural otherwise (including 0).
  check("formatMinutes(0) -> 0 minutes", formatMinutes(0) === "0 minutes", `got ${formatMinutes(0)}`);
  check("formatMinutes(1) -> 1 minute", formatMinutes(1) === "1 minute", `got ${formatMinutes(1)}`);
  check("formatMinutes(2) -> 2 minutes", formatMinutes(2) === "2 minutes", `got ${formatMinutes(2)}`);

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

  // 8. hasDeadlinePassed — the winter edge case: a midwinter "17:00" preset can
  // already be behind "now" on load (unrelated to sunset; just an ordinary passed clock time).
  const dec21_1700 = new Date("2026-12-21T17:00:00").getTime();
  check(
    "hasDeadlinePassed: 17:00 preset, now 17:30 -> true",
    hasDeadlinePassed(dec21_1700, new Date("2026-12-21T17:30:00").getTime()) === true
  );
  check(
    "hasDeadlinePassed: 17:00 preset, now 16:30 -> false",
    hasDeadlinePassed(dec21_1700, new Date("2026-12-21T16:30:00").getTime()) === false
  );

  // 9. getUkDateParts: BST/GMT-correct calendar date, independent of device timezone
  // (this test's `now` values are UTC instants; the assertion is against UK civil date).
  check(
    "getUkDateParts: 2026-06-15T23:30:00Z is already 2026-06-16 in BST (UTC+1)",
    JSON.stringify(getUkDateParts(new Date("2026-06-15T23:30:00Z"))) ===
      JSON.stringify({ year: 2026, month: 6, day: 16 })
  );
  check(
    "getUkDateParts: 2026-01-15T23:30:00Z is still 2026-01-15 in GMT (UTC+0)",
    JSON.stringify(getUkDateParts(new Date("2026-01-15T23:30:00Z"))) ===
      JSON.stringify({ year: 2026, month: 1, day: 15 })
  );

  // 10. getSunsetUtc, verified against the US Naval Observatory's official sun data
  // for Lincoln (53.2307 N, 0.5406 W) — see deadline.js's sunset section comment.
  // USNO times are minute-rounded, so 120s tolerance covers their rounding plus this
  // algorithm's own (~30s, empirically) divergence from USNO's fuller model.
  const LINCOLN_LAT = 53.2307;
  const LINCOLN_LON = -0.5406;
  const sunsetCases = [
    { label: "summer solstice 2026-06-21 (BST)", now: new Date("2026-06-21T12:00:00Z"), usnoUtc: "2026-06-21T20:33:00Z" },
    { label: "winter solstice 2026-12-21 (GMT)", now: new Date("2026-12-21T12:00:00Z"), usnoUtc: "2026-12-21T15:46:00Z" },
    { label: "near equinox 2026-09-17 (BST)", now: new Date("2026-09-17T12:00:00Z"), usnoUtc: "2026-09-17T18:13:00Z" },
    { label: "spring equinox 2026-03-20 (GMT)", now: new Date("2026-03-20T12:00:00Z"), usnoUtc: "2026-03-20T18:15:00Z" },
  ];
  for (const c of sunsetCases) {
    const computed = getSunsetUtc(LINCOLN_LAT, LINCOLN_LON, c.now);
    const diffSeconds = Math.abs(computed.getTime() - new Date(c.usnoUtc).getTime()) / 1000;
    check(
      `getSunsetUtc matches USNO reference for ${c.label} (within 120s)`,
      diffSeconds <= 120,
      `computed ${computed.toISOString()}, USNO ~${c.usnoUtc}, diff ${diffSeconds.toFixed(1)}s`
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main();
