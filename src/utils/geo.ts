/**
 * Straight-line geometry.
 *
 * This is the fallback, never the answer. Roads do not go straight: a driver 2 km
 * away on the wrong side of the Lahore Canal has to reach a crossing and come
 * back, so crow-flies distance can be a third of the real drive. Use OSRM for
 * anything an operator acts on, and this only when OSRM cannot be reached.
 */

const EARTH_RADIUS_M = 6_371_008.8;

const toRad = (deg: number) => (deg * Math.PI) / 180;

export interface LatLng {
  lat: number;
  lng: number;
}

/** Great-circle distance in metres. */
export function haversineMetres(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Is this a coordinate we can actually use?
 *
 * (0, 0) is in the Gulf of Guinea and is what a half-filled form or a failed
 * geocode leaves behind, so it is treated as absent rather than plotted.
 */
export function plottable(lat: number | null, lng: number | null): boolean {
  if (lat === null || lng === null) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}
