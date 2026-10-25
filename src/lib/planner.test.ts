import assert from "node:assert/strict";
import test from "node:test";
import { createTour } from "./planner";
import { syntheticPlan } from "./domain-fixture";

test("unchanged previous nodes are reusable without refetching Qloo or carrying old brief", async () => {
  const p = syntheticPlan(), second = structuredClone(p.stops[0]);
  second.id = "00000000-0000-4000-8000-000000000004"; second.name = "Synthetic second city"; second.destinationRank = 2;
  p.stops.push(second); p.candidateCities.push({ ...p.candidateCities[0], id: second.id, name: second.name });
  const before = structuredClone(p);
  const result = await createTour(p.input, () => {}, undefined, p);
  assert.equal(result.revision, 2); assert.equal(result.id, p.id);
  assert.deepEqual(result.stops[0].venues, p.stops[0].venues); assert.deepEqual(result.stops[0].evidence, p.stops[0].evidence);
  assert.equal(result.brief, null); assert.deepEqual(p, before);
});
test("a cached resolved headliner cannot cross an invalid mode boundary", async () => {
  const p = syntheticPlan(); p.input.tourType = "standup";
  await assert.rejects(createTour(p.input, () => {}, undefined, p), (error: unknown) => error instanceof Error && "status" in error && error.status === 400);
});
test("a resolved headliner with a recorded death cannot be reused for a new performance plan", async () => {
  const p = syntheticPlan(); p.headliner.deathDate = "2020-04-15";
  await assert.rejects(createTour(p.input, () => {}, undefined, p), (error: unknown) => error instanceof Error && "status" in error && error.status === 400);
});
test("recalculating the same stops preserves an absent market's archived research unchanged", async () => {
  const p = syntheticPlan(), second = structuredClone(p.stops[0]);
  second.id = "00000000-0000-4000-8000-000000000004"; second.name = "Synthetic second city"; second.destinationRank = 2;
  p.stops.push(second); p.candidateCities.push({ ...p.candidateCities[0], id: second.id, name: second.name });
  p.archivedResearch = [{ id: "00000000-0000-4000-8000-000000000005", name: "Synthetic absent market",
    places: [{ id: p.stops[0].venues[0].id, name: p.stops[0].venues[0].name }],
    venueDecisions: [{ entityId: p.stops[0].venues[0].id, venueName: p.stops[0].venues[0].name, status: "exclude", reason: "The sourced room does not meet this plan's needs.", decidedAt: "2026-10-21T00:00:00Z", needsReview: false }],
    confirmations: [] }];
  const before = structuredClone(p);
  const result = await createTour(p.input, () => {}, undefined, p);
  assert.deepEqual(result.archivedResearch, before.archivedResearch);
  assert.deepEqual(result.stops.map((stop) => stop.venueDecisions), p.stops.map((stop) => stop.venueDecisions));
  assert.deepEqual(p, before);
});
test("recalculation keeps a live market's notes-only historical research without duplicating it", async () => {
  const p = syntheticPlan(), earlierVenue = "00000000-0000-4000-8000-000000000006";
  const second = structuredClone(p.stops[0]);
  second.id = "00000000-0000-4000-8000-000000000004"; second.name = "Synthetic second city"; second.destinationRank = 2;
  p.stops.push(second); p.candidateCities.push({ ...p.candidateCities[0], id: second.id, name: second.name });
  p.archivedResearch = [{ id: p.stops[0].id, name: p.stops[0].name,
    places: [{ id: earlierVenue, name: "Earlier room" }], venueDecisions: [],
    confirmations: [{ entityId: earlierVenue, field: "fee", value: "Quoted terms from an earlier search", sourceUrl: "https://example.com/earlier", checkedAt: "2026-10-21T00:00:00Z", forDate: null, needsReconfirmation: true }] }];
  const before = structuredClone(p);
  const result = await createTour(p.input, () => {}, undefined, p);
  assert.deepEqual(result.archivedResearch, before.archivedResearch);
  assert.deepEqual(result.stops[0].confirmations, []);
  assert.deepEqual(p, before);
});
