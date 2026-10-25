type Coordinate = { lat: number | null; lon: number | null };

/** A provider geocoder must not move a recommendation into a namesake market. */
export function withinMarket(point: Coordinate, center: Coordinate, radiusKm = 30): boolean {
  if (point.lat === null || point.lon === null || center.lat === null || center.lon === null) return false;
  if (![point.lat, point.lon, center.lat, center.lon, radiusKm].every(Number.isFinite) || radiusKm < 0) return false;
  if (Math.abs(point.lat) > 90 || Math.abs(center.lat) > 90 || Math.abs(point.lon) > 180 || Math.abs(center.lon) > 180) return false;
  const radians = Math.PI / 180;
  const h = Math.sin((point.lat - center.lat) * radians / 2) ** 2
    + Math.cos(point.lat * radians) * Math.cos(center.lat * radians) * Math.sin((point.lon - center.lon) * radians / 2) ** 2;
  const distanceKm = 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
  return distanceKm <= radiusKm;
}
