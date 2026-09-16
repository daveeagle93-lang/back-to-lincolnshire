#!/usr/bin/env node
// Builds simplified, Leaflet-ready boundary files from the raw Nominatim
// GeoJSON fetched by scripts/fetch-boundaries.mjs.
//
// Simplification: `npx mapshaper@0.6.115 -i <raw> -simplify 20% -o <out>`
// (default weighted Visvalingam algorithm). 20% was chosen by testing 10/15/20%
// against the three raw files: it keeps enough vertices for good positional
// fidelity at county scale on a Leaflet map, while the largest output
// (Lincolnshire) still comes in at ~82KB - comfortably under the ~200KB
// ceiling and close to the <100KB stretch goal. See README/report for the
// size comparison at each percentage.
//
// Rerunnable: re-run any time the raw files are refetched.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(REPO_ROOT, "data", "boundaries", "raw");
const OUT_DIR = path.join(REPO_ROOT, "data", "boundaries");

const SIMPLIFY_PCT = "20%";

function simplify(inputPath, outputPath) {
  execFileSync(
    "npx",
    ["--yes", "mapshaper@0.6.115", "-i", inputPath, "-simplify", SIMPLIFY_PCT, "-o", outputPath],
    { stdio: "pipe" }
  );
  return outputPath;
}

async function simplifyToFeature(rawFile) {
  const inputPath = path.join(RAW_DIR, rawFile);
  const tmpOut = path.join(os.tmpdir(), `simplified-${rawFile}-${Date.now()}.geojson`);
  simplify(inputPath, tmpOut);
  const fc = JSON.parse(await readFile(tmpOut, "utf8"));
  // mapshaper always emits a FeatureCollection; we fed it a single Feature,
  // so pull that single feature back out.
  return fc.features[0];
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  // Output is minified (no pretty-print indentation) - these files are
  // fetched by the browser app, and indentation alone would roughly 2.5x
  // the size (as seen with the raw/ files) for no benefit at runtime.

  // --- Administrative: Lincolnshire only, single Feature ---
  const lincolnshireFeature = await simplifyToFeature("lincolnshire.geojson");
  const adminPath = path.join(OUT_DIR, "lincolnshire-administrative.geojson");
  await writeFile(adminPath, JSON.stringify(lincolnshireFeature) + "\n", "utf8");

  // --- Ceremonial: Lincolnshire + North Lincolnshire + North East Lincolnshire ---
  const northLincsFeature = await simplifyToFeature("north-lincolnshire.geojson");
  const northEastLincsFeature = await simplifyToFeature("north-east-lincolnshire.geojson");

  const ceremonialCollection = {
    type: "FeatureCollection",
    features: [lincolnshireFeature, northLincsFeature, northEastLincsFeature],
  };
  const ceremonialPath = path.join(OUT_DIR, "lincolnshire-ceremonial.geojson");
  await writeFile(ceremonialPath, JSON.stringify(ceremonialCollection) + "\n", "utf8");

  for (const p of [adminPath, ceremonialPath]) {
    const { size } = await import("node:fs").then((fs) => fs.promises.stat(p));
    console.log(`${path.relative(REPO_ROOT, p)}: ${(size / 1024).toFixed(1)} KB`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
