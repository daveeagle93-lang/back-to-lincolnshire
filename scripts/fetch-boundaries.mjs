#!/usr/bin/env node
// Fetches raw OSM boundary polygons and test-town coordinates from Nominatim.
//
// Rerunnable: re-run any time the source OSM data changes. Every value
// written to disk here comes directly from a live Nominatim HTTP response
// made at run time - nothing is hardcoded/guessed.
//
// Respects Nominatim's usage policy (https://operations.osmfoundation.org/policies/nominatim/):
//   - max 1 request/second (we sleep 1.1s between every request)
//   - identify the application via a descriptive User-Agent (never a personal email)

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const USER_AGENT = "BackToLincolnshire-DataPipeline/0.1 (+https://www.backtolincolnshire.co.uk)";
const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/search";
const RATE_LIMIT_MS = 1100;

const BOUNDARY_AREAS = [
  { name: "Lincolnshire", file: "lincolnshire.geojson" },
  { name: "North Lincolnshire", file: "north-lincolnshire.geojson" },
  { name: "North East Lincolnshire", file: "north-east-lincolnshire.geojson" },
];

const TEST_TOWNS = [
  "Lincoln",
  "Boston",
  "Grimsby",
  "Scunthorpe",
  "Newark-on-Trent",
  "Peterborough",
  "Melton Mowbray",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function nominatimSearch(query, extraParams = {}) {
  const url = new URL(NOMINATIM_BASE);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  for (const [k, v] of Object.entries(extraParams)) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`Nominatim request failed (${res.status}): ${url}`);
  }
  const body = await res.json();
  return { url: url.toString(), body };
}

// Pick the candidate that is the actual admin_level=6 English county/unitary
// authority boundary relation, not some other same-named entity.
function pickBoundaryCandidate(areaName, candidates) {
  // Note: jsonv2 format calls the field "category", not "class".
  const boundaryCandidates = candidates.filter(
    (c) =>
      c.category === "boundary" &&
      c.type === "administrative" &&
      c.osm_type === "relation" &&
      c.geojson &&
      (c.geojson.type === "Polygon" || c.geojson.type === "MultiPolygon")
  );

  if (boundaryCandidates.length === 0) {
    return { picked: null, boundaryCandidates, allCandidates: candidates };
  }

  // Prefer admin_level 6 (English county / unitary authority) when reported.
  const adminLevel6 = boundaryCandidates.filter(
    (c) => c.extratags && c.extratags.admin_level === "6"
  );
  const pool = adminLevel6.length > 0 ? adminLevel6 : boundaryCandidates;

  // Among remaining candidates, prefer highest importance/place_rank as tiebreak.
  pool.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));

  return { picked: pool[0], boundaryCandidates, allCandidates: candidates };
}

async function fetchBoundary(area) {
  const query = `${area.name}, United Kingdom`;
  const { url, body: candidates } = await nominatimSearch(query, {
    polygon_geojson: "1",
    addressdetails: "1",
    extratags: "1",
    limit: "5",
  });

  console.log(`\n=== ${area.name} ===`);
  console.log(`Request: ${url}`);
  console.log(`Candidates returned: ${candidates.length}`);
  for (const c of candidates) {
    console.log(
      `  - osm_id=${c.osm_id} osm_type=${c.osm_type} category=${c.category} type=${c.type} ` +
        `admin_level=${c.extratags?.admin_level ?? "?"} importance=${c.importance} display_name="${c.display_name}"`
    );
  }

  const { picked, boundaryCandidates } = pickBoundaryCandidate(area.name, candidates);
  if (!picked) {
    throw new Error(
      `No boundary/administrative relation candidate found for "${area.name}". ` +
        `Raw candidates: ${JSON.stringify(candidates, null, 2)}`
    );
  }

  console.log(
    `Picked: osm_id=${picked.osm_id} osm_type=${picked.osm_type} admin_level=${picked.extratags?.admin_level ?? "?"} ` +
      `display_name="${picked.display_name}" (${boundaryCandidates.length} boundary/administrative relation candidate(s) total)`
  );

  const feature = {
    type: "Feature",
    properties: {
      name: area.name,
      osm_id: picked.osm_id,
      osm_type: picked.osm_type,
      class: picked.category,
      type: picked.type,
      admin_level: picked.extratags?.admin_level ?? null,
      display_name: picked.display_name,
      address: picked.address ?? null,
      extratags: picked.extratags ?? null,
      importance: picked.importance ?? null,
      source: "nominatim.openstreetmap.org/search",
      source_request_url: url,
      fetched_at: new Date().toISOString(),
    },
    geometry: picked.geojson,
  };

  const outPath = path.join(REPO_ROOT, "data", "boundaries", "raw", area.file);
  await writeFile(outPath, JSON.stringify(feature, null, 2) + "\n", "utf8");
  console.log(`Wrote ${path.relative(REPO_ROOT, outPath)}`);

  return feature;
}

async function fetchTown(name) {
  const query = `${name}, United Kingdom`;
  const { url, body: candidates } = await nominatimSearch(query, {
    addressdetails: "1",
    limit: "5",
  });

  console.log(`\n=== Town: ${name} ===`);
  console.log(`Request: ${url}`);
  for (const c of candidates.slice(0, 5)) {
    console.log(
      `  - osm_id=${c.osm_id} osm_type=${c.osm_type} class=${c.class} type=${c.type} ` +
        `country=${c.address?.country ?? "?"} importance=${c.importance} display_name="${c.display_name}"`
    );
  }

  // Prefer a UK result that is a populated place (or admin boundary standing
  // in for one), highest importance first (Nominatim already sorts this way,
  // but we re-assert it after filtering to be safe).
  const ukCandidates = candidates.filter((c) => c.address?.country === "United Kingdom");
  const pool = ukCandidates.length > 0 ? ukCandidates : candidates;
  pool.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
  const picked = pool[0];

  if (!picked) {
    throw new Error(`No candidate found for town "${name}"`);
  }

  console.log(
    `Picked: osm_id=${picked.osm_id} lat=${picked.lat} lon=${picked.lon} display_name="${picked.display_name}"`
  );

  return {
    name,
    lat: Number(picked.lat),
    lon: Number(picked.lon),
    display_name: picked.display_name,
    osm_id: picked.osm_id,
    osm_type: picked.osm_type,
    address: picked.address ?? null,
    source_request_url: url,
    fetched_at: new Date().toISOString(),
  };
}

async function main() {
  await mkdir(path.join(REPO_ROOT, "data", "boundaries", "raw"), { recursive: true });

  // --- Step 1: boundary polygons ---
  let first = true;
  for (const area of BOUNDARY_AREAS) {
    if (!first) await sleep(RATE_LIMIT_MS);
    first = false;
    await fetchBoundary(area);
  }

  // --- Step 3: test-town geocodes ---
  await sleep(RATE_LIMIT_MS);
  const towns = [];
  let firstTown = true;
  for (const town of TEST_TOWNS) {
    if (!firstTown) await sleep(RATE_LIMIT_MS);
    firstTown = false;
    towns.push(await fetchTown(town));
  }

  const townsPath = path.join(REPO_ROOT, "data", "test-towns.json");
  await writeFile(townsPath, JSON.stringify(towns, null, 2) + "\n", "utf8");
  console.log(`\nWrote ${path.relative(REPO_ROOT, townsPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
