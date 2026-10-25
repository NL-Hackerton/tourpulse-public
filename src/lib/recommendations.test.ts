import assert from "node:assert/strict";
import test from "node:test";
import { recommend, type RowsCall } from "./recommendations";
import { syntheticPlan } from "./domain-fixture";
import { rowSchema } from "./qloo";
import type { TourPlan, TourType } from "./contracts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function scenario(mode: TourType, missing = false): { plan: TourPlan; call: RowsCall } {
  const plan = syntheticPlan(); plan.input.tourType = mode;
  plan.headliner.type = mode === "music" ? "urn:entity:artist" : mode === "standup" ? "urn:entity:person" : "urn:entity:podcast";
  plan.headliner.tags = mode === "standup" ? ["urn:tag:genre:person:comedian"] : [];
  const original = plan.stops[0];
  plan.stops = [0, 1].map((city) => {
    const venues = [0, 1, 2].map((offset) => ({ ...original.venues[0], id: id(100 + city * 10 + offset), name: `Synthetic place ${city}-${offset}` }));
    return { ...structuredClone(original), id: id(10 + city), name: `Synthetic city ${city}`, venues, retainedPlaceIds: venues.map((place) => place.id), supportGroups: [] };
  });
  const places = plan.stops.flatMap((stop) => stop.venues);
  const call: RowsCall = async (_step, params, _message, endpoint = "/v2/insights") => {
    const evidence = { endpoint, params, fetchedAt: "2026-10-20T00:00:00Z", cached: false };
    if (endpoint === "/entities") return {
      values: params.entity_ids.split(",").map((entity_id) => {
        const type = Number(entity_id.slice(-3)) >= 250 ? "urn:entity:person" : mode === "music" ? "urn:entity:artist" : "urn:entity:podcast";
        return rowSchema.parse({ entity_id, name: `Synthetic detailed candidate ${entity_id}`, types: [type], tags: type === "urn:entity:person" ? [{ id: "urn:tag:genre:person:comedian" }] : [] });
      }),
      evidence,
    };
    if (params["filter.type"] === "urn:entity:place") {
      const candidate = Number(params["signal.interests.entities"].slice(-3));
      const position = candidate % 50;
      const wanted = new Set(params["filter.results.entities"].split(","));
      const values = places.flatMap((place, index) => {
        if (!wanted.has(place.id) || (missing && position === 1 && index === 0)) return [];
        const affinity = candidate >= 300 ? position === 1 ? 0.95 : position === 0 ? 0.2 : 0.01
          : position === 0 ? index < 3 ? 0.2 : 0.9 : position === 1 ? index < 3 ? 0.9 : 0.2 : 0.01;
        return [rowSchema.parse({ entity_id: place.id, name: place.name, types: ["urn:entity:place"], query: { affinity: affinity + index * 0.001 } })];
      });
      return { values, evidence };
    }
    const type = params["filter.type"], start = type === "urn:entity:brand" ? 300 : type === "urn:entity:person" ? 250 : 200;
    const values = Array.from({ length: 20 }, (_, i) => rowSchema.parse({ entity_id: id(start + i), name: `Synthetic candidate ${start + i}`, types: [type], tags: type === "urn:entity:person" ? [{ id: "urn:tag:genre:person:comedian" }] : [] }));
    if (type === "urn:entity:person") values.unshift(rowSchema.parse({ entity_id: id(999), name: "Synthetic comedy actor without stand-up evidence", types: [type], tags: [{ id: "urn:tag:genre:media:media:comedy" }] }));
    return { values, evidence };
  };
  return { plan, call };
}

for (const mode of ["music", "standup", "podcast"] as const) test(`${mode} recommendations reflect each city's observed places without confusing programs and people`, async () => {
  const { plan, call } = scenario(mode);
  const sponsors = await recommend(plan.input, plan.headliner, plan.stops, call);
  for (const group of plan.stops[0].supportGroups) {
    const start = group.kind === "comedian" ? 250 : 200;
    assert.equal(group.candidates[0].entity.id, id(start + 1));
    const other = plan.stops[1].supportGroups.find((candidate) => candidate.kind === group.kind)!;
    assert.equal(other.candidates[0].entity.id, id(start));
    assert.ok(group.candidates.every((candidate) => candidate.fit.status === "comparable" && candidate.entity.id !== id(999)));
    assert.ok(group.candidates.every((candidate) => candidate.entity.type === `urn:entity:${group.kind === "comedian" ? "person" : group.kind}`));
  }
  assert.equal(sponsors[0].entity.id, id(301));
  assert.equal(sponsors[0].activationSpots.find((spot) => spot.stopId === plan.stops[1].id)?.placeId, id(112));
});

test("one candidate's missing place evidence prevents mixed-denominator superiority claims", async () => {
  const { plan, call } = scenario("music", true);
  const sponsors = await recommend(plan.input, plan.headliner, plan.stops, call);
  const support = plan.stops[0].supportGroups[0].candidates;
  assert.equal(support[0].entity.id, id(200));
  assert.ok(support.every((candidate) => candidate.fit.score === null && candidate.fit.status === "insufficient_evidence"));
  assert.equal(sponsors[0].entity.id, id(300));
  assert.ok(sponsors.every((candidate) => candidate.fit.score === null));
});

for (const mode of ["music", "standup", "podcast"] as const) {
  test(`${mode} detail records remove historical, missing and wrong-type candidates before ranking`, async () => {
    const { plan, call } = scenario(mode);
    const start = mode === "standup" ? 250 : 200;
    const checked: RowsCall = async (step, params, message, endpoint) => {
      const response = await call(step, params, message, endpoint);
      if (endpoint !== "/entities") return response;
      return { ...response, values: response.values.filter((row) => row.entity_id !== id(start + 1)).map((row) =>
        row.entity_id === id(start) ? { ...row, properties: { date_of_death: "2020-04-15" } }
          : row.entity_id === id(start + 2) ? { ...row, types: ["urn:entity:brand"] } : row) };
    };
    await recommend(plan.input, plan.headliner, plan.stops, checked);
    for (const stop of plan.stops) {
      const group = stop.supportGroups[0];
      assert.deepEqual(group.candidates.map((candidate) => candidate.entity.id), [id(start + 3), id(start + 4), id(start + 5)]);
      assert.ok(group.candidates.every((candidate) => candidate.evidence.some((entry) => entry.endpoint === "/entities")));
    }
  });

  test(`${mode} detail lookup failure cannot become an unchecked result`, async () => {
    const { plan, call } = scenario(mode);
    const unavailable: RowsCall = async (step, params, message, endpoint) => {
      if (endpoint === "/entities") throw new Error("Detail lookup unavailable");
      return call(step, params, message, endpoint);
    };
    await assert.rejects(recommend(plan.input, plan.headliner, plan.stops, unavailable), /Detail lookup unavailable/);
    assert.deepEqual(plan.stops[0].supportGroups, []);
  });
}
