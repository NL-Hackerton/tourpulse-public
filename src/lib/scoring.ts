// Non-nullable scores return NaN for invalid numeric inputs; callers must show
// insufficient evidence rather than converting missing evidence into a zero.
export function rankScore(rank: number, count: number): number {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(rank) || rank < 1 || rank > count) return NaN;
  return count === 1 ? 1 : 1 - (rank - 1) / (count - 1);
}

export function meanAffinity(values: (number | null)[]): number | null {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (!finite.length) return null;
  // Divide before summing to avoid overflow for otherwise finite observations.
  return finite.reduce((sum, value) => sum + value / finite.length, 0);
}

export function cityFit(destination: number | null, scene: number | null): number | null {
  if (destination === null || !Number.isFinite(destination)) return null;
  return scene === null || !Number.isFinite(scene) ? destination : 0.6 * destination + 0.4 * scene;
}

export function neighborhoodScore(affinityRank: number, popularity: number, lambda = 0.3): number {
  if (![affinityRank, popularity, lambda].every(Number.isFinite) || affinityRank < 0 || affinityRank > 1 || popularity < 0 || popularity > 1 || lambda < 0 || lambda > 0.6) return NaN;
  return affinityRank ** (1 - lambda) * popularity ** lambda;
}

export function decodeGeohash(hash: string): { lat: number; lon: number } {
  const alphabet = "0123456789bcdefghjkmnpqrstuvwxyz";
  if (!hash || !/^[0123456789bcdefghjkmnpqrstuvwxyz]+$/i.test(hash)) throw new RangeError("Invalid geohash");
  let south = -90, north = 90, west = -180, east = 180;
  let longitude = true;
  for (const character of hash.toLowerCase()) {
    const value = alphabet.indexOf(character);
    for (let mask = 16; mask; mask >>= 1) {
      if (longitude) {
        const middle = (west + east) / 2;
        if (value & mask) west = middle; else east = middle;
      } else {
        const middle = (south + north) / 2;
        if (value & mask) south = middle; else north = middle;
      }
      longitude = !longitude;
    }
  }
  return { lat: (south + north) / 2, lon: (west + east) / 2 };
}
