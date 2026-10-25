import type { Cell, Place } from "./contracts";
import { decodeGeohash, neighborhoodScore, rankScore } from "./scoring";

export function encodeGeohash(lat: number, lon: number, precision = 5): string {
  const alphabet = "0123456789bcdefghjkmnpqrstuvwxyz";
  let south = -90, north = 90, west = -180, east = 180, longitude = true, result = "", bits = 0, value = 0;
  while (result.length < precision) {
    const midpoint = longitude ? (west + east) / 2 : (south + north) / 2;
    const upper = (longitude ? lon : lat) >= midpoint;
    value = value * 2 + Number(upper);
    if (longitude) { if (upper) west = midpoint; else east = midpoint; }
    else { if (upper) south = midpoint; else north = midpoint; }
    longitude = !longitude;
    if (++bits === 5) { result += alphabet[value]; bits = 0; value = 0; }
  }
  return result;
}
export function aggregateNeighborhoods(places: Place[], nicheWeight: number): Cell[] {
  const ranked = [...new Map(places.filter((p) => p.lat !== null && p.lon !== null && p.affinity !== null).map((p) => [p.id, p])).values()].sort((a, b) => b.affinity! - a.affinity!);
  const groups = new Map<string, number[]>();
  ranked.forEach((place, i) => {
    const hash = encodeGeohash(place.lat!, place.lon!);
    const values = groups.get(hash) ?? [];
    values.push(rankScore(i + 1, ranked.length)); groups.set(hash, values);
  });
  const maxCount = Math.max(0, ...[...groups.values()].map((values) => values.length));
  return [...groups].map(([geohash, values]) => {
    const affinityRank = values.reduce((a, b) => a + b, 0) / values.length;
    const popularity = Math.log1p(values.length) / Math.log1p(maxCount);
    return { geohash, affinityRank, popularity, score: neighborhoodScore(affinityRank, popularity, nicheWeight), ...decodeGeohash(geohash), contributions: {} };
  }).sort((a, b) => b.score - a.score).slice(0, 24);
}
