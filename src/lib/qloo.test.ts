import assert from "node:assert/strict";
import test from "node:test";
import { rowSchema, normalizeEntity } from "./qloo";
import { allowedAnchor, isAdultEntertainment, validHeadliner } from "./entity-policy";

const artist = {
  entity_id: "12345678-1234-4234-8234-123456789abc",
  name: "Synthetic artist",
  types: ["urn:entity:artist"],
};

test("search tag_id and insights id retain the same category identity", () => {
  const fromSearch = rowSchema.parse({ ...artist, tags: [{ tag_id: "urn:tag:genre:synthetic", name: "Synthetic" }] });
  const fromInsights = rowSchema.parse({ ...artist, tags: [{ id: "urn:tag:genre:synthetic", name: "Synthetic" }] });
  assert.deepEqual(fromSearch.tags, [{ id: "urn:tag:genre:synthetic", name: "Synthetic", type: "" }]);
  assert.deepEqual(fromInsights.tags, fromSearch.tags);
  assert.equal(normalizeEntity(fromSearch).type, "urn:entity:artist");
});

test("unidentifiable and non-string provider tags are rejected instead of silently losing categories", () => {
  assert.equal(rowSchema.safeParse({ ...artist, tags: [{ name: "Missing identifier" }] }).success, false);
  assert.equal(rowSchema.safeParse({ ...artist, tags: [{ tag_id: 42 }] }).success, false);
});

test("adult-entertainment places are recognized from any Qloo tag family, without catching nearby-district names", () => {
  assert.equal(isAdultEntertainment(["urn:tag:category:place:adult_entertainment_club", "urn:tag:genre:place:night_club"]), true);
  assert.equal(isAdultEntertainment(["urn:tag:activity_type:qloo:adult_entertainment"]), true);
  assert.equal(isAdultEntertainment(["urn:tag:genre:place:night_club", "urn:tag:nearby_attraction:qloo:strip_district", "urn:tag:offerings:place:adult_classes"]), false);
});

test("normalized entities preserve verified categories and coordinates without inventing popularity", () => {
  const row = rowSchema.parse({ ...artist, location: { latitude: 40, longitude: -74 }, tags: [{ tag_id: "urn:tag:genre:synthetic" }], properties: { capacity: 500 } });
  const entity = normalizeEntity(row);
  assert.deepEqual(entity.tags, ["urn:tag:genre:synthetic"]);
  assert.deepEqual(entity.location, { lat: 40, lon: -74 });
  assert.equal(entity.popularity, null);
  assert.equal(normalizeEntity(rowSchema.parse(artist)).location, null);
});

test("type-only taxonomy markers mean unknown metadata, not a fabricated tag ID or an invalid artist", () => {
  const row = rowSchema.parse({ ...artist, tags: [
    { id: "urn:tag:genre:synthetic", name: "Synthetic" },
    { type: "urn:tag:voice_type:qloo" },
  ] });
  const entity = normalizeEntity(row);
  assert.equal(entity.id, artist.entity_id);
  assert.deepEqual(entity.tags, ["urn:tag:genre:synthetic"]);
});

test("destination country uses provider names and a coordinate-bound fixed catalog, never a namesake guess", () => {
  const destination = { ...artist, types: ["urn:entity:destination"] };
  const reported = normalizeEntity(rowSchema.parse({ ...destination, name: "Synthetic Canadian city", location: { lat: 45, lon: -73 }, properties: { country: "Canada" } }));
  assert.equal(reported.country, "Canada");
  assert.equal(reported.countrySource, "qloo");
  const fixed = normalizeEntity(rowSchema.parse({ ...destination, name: "Washington", location: { lat: 38.9, lon: -77.04 } }));
  assert.equal(fixed.country, "United States of America");
  assert.equal(fixed.countrySource, "fixed_catalog");
  const namesake = normalizeEntity(rowSchema.parse({ ...destination, name: "Washington", location: { lat: 47.5, lon: -122.3 } }));
  assert.equal(namesake.country, null);
  const unknownShape = normalizeEntity(rowSchema.parse({ ...artist, properties: { country: ["Canada"] } }));
  assert.equal(unknownShape.country, null);
});

test("recorded death prevents performance headlining but not cultural-anchor use", () => {
  const person = { ...artist, types: ["urn:entity:person"], tags: [{ id: "urn:tag:genre:person:comedian" }] };
  const historical = normalizeEntity(rowSchema.parse({ ...person, properties: { date_of_death: "2020-04-15" } }));
  assert.equal(historical.deathDate, "2020-04-15");
  assert.equal(validHeadliner(historical, "standup"), false);
  assert.equal(allowedAnchor(historical), true);
  const unknown = normalizeEntity(rowSchema.parse(person));
  assert.equal(unknown.deathDate, null);
  assert.equal(validHeadliner(unknown, "standup"), true);
  assert.equal(validHeadliner({ ...historical, type: "urn:entity:artist" }, "music"), false);
});

test("Wikidata identity comes only from the provider's exact linked ID, never a name or URL", () => {
  const linked = normalizeEntity(rowSchema.parse({ ...artist, properties: { external: { wikidata: { id: "q1779" } } } }));
  assert.equal(linked.wikidataId, "Q1779");
  const unlinked = normalizeEntity(rowSchema.parse({ ...artist, name: "Q1779", properties: { description: "Q1779" } }));
  assert.equal(unlinked.wikidataId, null);
  const invalid = normalizeEntity(rowSchema.parse({ ...artist, properties: { external: { wikidata: { id: "https://example.com/Q1779" } } } }));
  assert.equal(invalid.wikidataId, null);
});
