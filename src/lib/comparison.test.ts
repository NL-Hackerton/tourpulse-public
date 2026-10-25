import assert from "node:assert/strict";
import test from "node:test";
import { compareFits } from "./comparison";
import { aggregateNeighborhoods, encodeGeohash } from "./neighborhoods";
import type { Place } from "./contracts";

test("same-set comparison requires every candidate and every non-null place", () => {
  const result = compareFits([{ id: "a", baseScore: 1, values: [{ placeId: "p", value: 0.5 }] }, { id: "b", baseScore: 0, values: [{ placeId: "p", value: null }] }], ["p"]);
  assert.equal(result.get("a")?.score, null); assert.equal(result.get("b")?.status, "insufficient_evidence");
  assert.equal(compareFits([{ id: "a", baseScore: 1, values: [{ placeId: "other", value: 1 }] }], ["p"]).get("a")?.score, null);
  assert.equal(compareFits([{ id: "a", baseScore: 1, values: [] }], []).get("a")?.score, null);
});
test("weight and leave-one-place sensitivity withhold superiority", () => {
  const weight = compareFits([{ id: "a", baseScore: 0.6, values: [{ placeId: "p", value: 0 }] }, { id: "b", baseScore: 0.4, values: [{ placeId: "p", value: 0.4 }] }], ["p"]);
  assert.equal(weight.get("a")?.status, "sensitive"); assert.equal(weight.get("a")?.score, null);
  const loo = compareFits([{ id: "a", baseScore: 0.6, values: [{ placeId: "p", value: 0 }, { placeId: "q", value: 1 }] }, { id: "b", baseScore: 0.5, values: [{ placeId: "p", value: 1 }, { placeId: "q", value: 0 }] }], ["p", "q"]);
  assert.equal(loo.get("a")?.status, "sensitive");
});
test("stable complete evidence yields the documented exploratory weighted fit", () => {
  const result = compareFits([{ id: "a", baseScore: 1, values: [{ placeId: "p", value: 0.8 }] }, { id: "b", baseScore: 0, values: [{ placeId: "p", value: 0.2 }] }], ["p"]);
  assert.equal(result.get("a")?.status, "comparable"); assert.equal(result.get("a")?.score, 0.92);
});
test("place fallback deduplicates raw IDs and uses actual coordinate geohashes", () => {
  const place: Place = { id: "p", name: "Synthetic", lat: 39.9526, lon: -75.1652, affinity: 0.5, address: "", neighborhood: "", website: "", tags: [], explainability: {}, evidence: { endpoint: "/v2/insights", params: {}, fetchedAt: "2026-10-20T00:00:00Z", cached: false } };
  assert.equal(encodeGeohash(place.lat!, place.lon!), "dr4e3");
  const cells = aggregateNeighborhoods([place, place], 0.3);
  assert.equal(cells.length, 1); assert.equal(cells[0].affinityRank, 1); assert.equal(cells[0].popularity, 1);
});
