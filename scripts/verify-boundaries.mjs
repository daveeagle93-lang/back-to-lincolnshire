#!/usr/bin/env node
// Verifies the simplified boundary files against known test towns using the
// shared point-in-polygon module. Prints an INSIDE/OUTSIDE table for both
// the administrative and ceremonial boundaries.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isInsideBoundary } from "../point-in-polygon.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

async function loadJson(relPath) {
  const raw = await readFile(path.join(REPO_ROOT, relPath), "utf8");
  return JSON.parse(raw);
}

async function main() {
  const [administrative, ceremonial, towns] = await Promise.all([
    loadJson("data/boundaries/lincolnshire-administrative.geojson"),
    loadJson("data/boundaries/lincolnshire-ceremonial.geojson"),
    loadJson("data/test-towns.json"),
  ]);

  const rows = towns.map((town) => {
    const point = [town.lon, town.lat];
    return {
      name: town.name,
      administrative: isInsideBoundary(point, administrative) ? "INSIDE" : "OUTSIDE",
      ceremonial: isInsideBoundary(point, ceremonial) ? "INSIDE" : "OUTSIDE",
    };
  });

  const nameWidth = Math.max(...rows.map((r) => r.name.length), "Town".length);
  const pad = (s, w) => s.padEnd(w);

  console.log(`${pad("Town", nameWidth)}  Administrative  Ceremonial`);
  console.log(`${"-".repeat(nameWidth)}  --------------  ----------`);
  for (const row of rows) {
    console.log(`${pad(row.name, nameWidth)}  ${pad(row.administrative, 14)}  ${row.ceremonial}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
