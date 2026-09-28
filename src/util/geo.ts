const EARTH_RADIUS_M = 6371000;
const DEG = Math.PI / 180;

export function localMeters(lat: number, lon: number, refLat: number, refLon: number) {
  const x = EARTH_RADIUS_M * (lon - refLon) * DEG * Math.cos(refLat * DEG);
  const y = EARTH_RADIUS_M * (lat - refLat) * DEG;
  return { x, y };
}

export function distance3d(aLat: number, aLon: number, aDepth: number, bLat: number, bLon: number, bDepth: number): number {
  const d = localMeters(bLat, bLon, aLat, aLon);
  const dz = bDepth - aDepth;
  return Math.hypot(d.x, d.y, dz);
}

export function bearingWeights(stations: Array<{ latitude: number; longitude: number }>, lat: number, lon: number): { min: number; condition: number } {
  if (stations.length < 2) return { min: 0, condition: 1 };
  let sx = 0, sy = 0;
  for (const station of stations) {
    const p = localMeters(station.latitude, station.longitude, lat, lon);
    const r = Math.max(Math.hypot(p.x, p.y), 1);
    sx += p.x / r;
    sy += p.y / r;
  }
  const resultant = Math.hypot(sx, sy) / stations.length;
  return { min: 1 - resultant, condition: resultant };
}
