// Dependency-free point-in-polygon check, shared between the browser app
// (imported as a plain <script type="module">) and Node build/verify
// scripts. No Node-specific APIs are used inside the exported function.

// Standard ray-casting (even-odd rule) test for a point against a single
// linear ring. `ring` is an array of [lon, lat] pairs (GeoJSON winding order
// does not matter for even-odd).
function isInsideRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// A GeoJSON Polygon's `coordinates` is an array of rings: the first is the
// exterior, any subsequent rings are holes. Even-odd over all rings means a
// point inside an even number of rings (0, 2, ...) is outside; inside an odd
// number of rings is inside - which naturally handles holes as long as we
// XOR the per-ring test, i.e. exterior XOR hole1 XOR hole2 ...
function isInsidePolygonCoords(point, polygonCoords) {
  let inside = false;
  for (const ring of polygonCoords) {
    if (isInsideRing(point, ring)) inside = !inside;
  }
  return inside;
}

function isInsideGeometry(point, geometry) {
  if (!geometry) return false;
  if (geometry.type === "Polygon") {
    return isInsidePolygonCoords(point, geometry.coordinates);
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.some((polygonCoords) =>
      isInsidePolygonCoords(point, polygonCoords)
    );
  }
  return false;
}

/**
 * Returns true if `point` ([lon, lat]) is inside the boundary described by
 * `geojson`, which may be a Feature, FeatureCollection, or a bare
 * Polygon/MultiPolygon geometry. For a FeatureCollection, the point is
 * considered inside if it's inside any one of the contained features
 * (union semantics).
 */
export function isInsideBoundary(point, geojson) {
  if (!geojson) return false;

  if (geojson.type === "FeatureCollection") {
    return geojson.features.some((feature) => isInsideBoundary(point, feature));
  }

  if (geojson.type === "Feature") {
    return isInsideGeometry(point, geojson.geometry);
  }

  // Bare geometry (Polygon/MultiPolygon).
  return isInsideGeometry(point, geojson);
}
