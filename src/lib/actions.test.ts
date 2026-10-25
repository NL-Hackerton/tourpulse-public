import assert from "node:assert/strict";
import test from "node:test";
import { applyAction } from "./actions";
import { syntheticPlan } from "./domain-fixture";
import { validHeadliner } from "./entity-policy";

test("within-set selection uses the actual previous snapshot, never mutates it, and invalidates brief", async () => {
  const previous = syntheticPlan();
  previous.brief = { planId: previous.id, revision: 1, brandId: "synthetic-brand", createdAt: previous.generatedAt, model: "synthetic-model", title: "Old selection", summary: "Stale after selection", proposalType: "in_kind_support", sections: [], emailSubject: "Old draft", emailBody: "Old text", facts: [], warnings: [] };
  const before = structuredClone(previous);
  const result = await applyAction(previous, { type: "select_venue", cityId: previous.stops[0].id, venueId: previous.stops[0].venues[0].id }, () => {});
  assert.deepEqual(previous, before); assert.equal(result.revision, 2); assert.equal(result.id, previous.id);
  assert.equal(result.stops[0].selectedVenueId, previous.stops[0].venues[0].id);
  assert.equal(result.schedule.rows.find((r) => r.kind === "show")?.venue, "Synthetic Venue");
  assert.equal(result.brief, null); assert.deepEqual(result.stops[0].evidence, previous.stops[0].evidence);
});
test("foreign city, venue, support, sponsor and confirmation IDs are rejected before Qloo", async () => {
  const p = syntheticPlan(), foreign = "00000000-0000-4000-8000-000000000099";
  await assert.rejects(applyAction(p, { type: "select_venue", cityId: foreign, venueId: foreign }, () => {}), /not a stop/);
  await assert.rejects(applyAction(p, { type: "select_venue", cityId: p.stops[0].id, venueId: foreign }, () => {}), /outside/);
  await assert.rejects(applyAction(p, { type: "select_support", cityId: p.stops[0].id, candidateId: foreign }, () => {}), /not in/);
  await assert.rejects(applyAction(p, { type: "select_sponsor", brandId: foreign }, () => {}), /not in/);
});
test("date changes preserve Qloo evidence but mark dated confirmations for recheck", async () => {
  const p = syntheticPlan();
  p.stops[0].confirmations = [{ entityId: p.stops[0].venues[0].id, field: "availability", value: "User checked", sourceUrl: "https://example.invalid/source", checkedAt: "2026-10-20T00:00:00Z", forDate: "2026-10-22", needsReconfirmation: false }];
  p.schedule.rows = [{ kind: "show", date: "2026-10-22", cityId: p.stops[0].id, city: p.stops[0].name, neighborhood: "", venue: "", driveKm: 0, driveHours: 0, reason: "Synthetic", warnings: [], support: [], sponsors: [] }];
  const result = await applyAction(p, { type: "set_dates", startDate: "2026-11-01", endDate: "2026-11-20" }, () => {});
  assert.equal(result.stops[0].confirmations[0].needsReconfirmation, true);
  assert.deepEqual(result.stops[0].evidence, p.stops[0].evidence);
  await assert.rejects(applyAction(p, { type: "set_dates", startDate: "2026-11-20", endDate: "2026-11-01" }, () => {}));
});
test("mode headliner validation requires comedian tags and podcast program identity", () => {
  const artist = syntheticPlan().headliner;
  assert.equal(validHeadliner(artist, "music"), true); assert.equal(validHeadliner(artist, "standup"), false);
  const person = { ...artist, type: "urn:entity:person" };
  assert.equal(validHeadliner(person, "standup"), false);
  assert.equal(validHeadliner({ ...person, tags: ["urn:tag:genre:person:comedian"] }, "standup"), true);
  assert.equal(validHeadliner({ ...person, tags: ["urn:tag:wikipedia_category:wikidata:american_stand_up_comedians"] }, "standup"), true);
  assert.equal(validHeadliner({ ...person, tags: ["urn:tag:genre:media:media:comedy"] }, "standup"), false);
  assert.equal(validHeadliner(person, "podcast"), false);
  assert.equal(validHeadliner({ ...person, type: "urn:entity:podcast" }, "podcast"), true);
});
