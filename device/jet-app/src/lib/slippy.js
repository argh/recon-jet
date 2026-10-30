// Web Mercator "slippy map" arithmetic: the projection OSM raster tiles use. A tile is 256 px;
// at zoom z the world is 2^z tiles across. Pure functions; the map mode does the I/O.
export const TILE = 256;
const MAX_LAT = 85.0511287798;   // the Mercator cutoff

export const clampLat = (lat) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));

/** lon/lat (degrees) at zoom z -> world pixel {x, y} (0 .. 2^z*256). */
export function project(lat, lon, z) {
  const n = TILE * 2 ** z;
  const x = (lon + 180) / 360 * n;
  const s = Math.sin(clampLat(lat) * Math.PI / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return { x, y };
}

/** World pixel {x, y} at zoom z -> {lat, lon} (degrees). */
export function unproject(x, y, z) {
  const n = TILE * 2 ** z;
  const lon = x / n * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  return { lat, lon };
}

/** The tiles whose 256 px squares intersect the viewport [left,top, w,h] in world pixels at zoom z.
 * Returns { z, tiles: [{x, y, sx, sy}] } where sx/sy is the tile's top-left in screen pixels
 * (viewport-relative). Tiles off the edges of the world are skipped. */
export function coverViewport(left, top, w, h, z) {
  const span = 2 ** z;
  const x0 = Math.floor(left / TILE), x1 = Math.floor((left + w - 1) / TILE);
  const y0 = Math.floor(top / TILE), y1 = Math.floor((top + h - 1) / TILE);
  const tiles = [];
  for (let ty = y0; ty <= y1; ty++) {
    if (ty < 0 || ty >= span) continue;   // no wrap in latitude
    for (let tx = x0; tx <= x1; tx++) {
      const wx = ((tx % span) + span) % span;   // longitude wraps
      tiles.push({ x: wx, y: ty, sx: tx * TILE - left, sy: ty * TILE - top });
    }
  }
  return { z, tiles };
}
