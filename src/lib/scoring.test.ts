import assert from "node:assert/strict";
import test from "node:test";
import { cityFit, decodeGeohash, meanAffinity, neighborhoodScore, rankScore } from "./scoring";

test("scores distinguish absent evidence from zero and handle single results", () => {
  assert.equal(rankScore(1, 1), 1);
  assert.equal(rankScore(1, 3), 1);
  assert.equal(rankScore(2, 3), 0.5);
  assert.equal(rankScore(3, 3), 0);
  assert.ok(Number.isNaN(rankScore(1, 0)));
  assert.ok(Number.isNaN(rankScore(Infinity, 3)));
  assert.equal(meanAffinity([]), null);
  assert.equal(meanAffinity([null, NaN, Infinity]), null);
  assert.equal(meanAffinity([null, 0, 0.8]), 0.4);
  assert.equal(cityFit(null, 0.8), null);
  assert.equal(cityFit(0.8, null), 0.8);
  assert.equal(cityFit(0, 0), 0);
  assert.ok(Math.abs(cityFit(1, 0.5)! - 0.8) < 1e-12);
  assert.equal(neighborhoodScore(0.5, 0, 0), 0.5);
  assert.ok(neighborhoodScore(0.8, 0.8) > neighborhoodScore(0.8, 0.2));
  assert.ok(Number.isNaN(neighborhoodScore(NaN, 0.5)));
});

test("geohashes use actual precision and reject unsupported characters", () => {
  const decoded = decodeGeohash("u4pruydqqvj");
  assert.ok(Math.abs(decoded.lat - 57.64911) < 0.00001);
  assert.ok(Math.abs(decoded.lon - 10.40744) < 0.00001);
  assert.deepEqual(decodeGeohash("s"), { lat: 22.5, lon: 22.5 });
  assert.deepEqual(decodeGeohash("S"), decodeGeohash("s"));
  for (const invalid of ["", "a", "abc!", " s"]) assert.throws(() => decodeGeohash(invalid), RangeError);
});
