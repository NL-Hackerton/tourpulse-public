import assert from "node:assert/strict";
import test from "node:test";
import { parseLifeRecords } from "./wikidata";
import { screenPerformers } from "./performance-eligibility";
import { syntheticPlan } from "./domain-fixture";
import type { Entity, Evidence } from "./contracts";

const value = { type: "time", value: { time: "+1971-07-06T00:00:00Z" } };
const claim = (rank = "normal", snaktype = "value") => ({ rank, mainsnak: { property: "P570", snaktype, ...(snaktype === "value" ? { datavalue: value } : {}) } });
const item = (P570: unknown[]) => ({ entities: { Q1: { id: "Q1", claims: { P570 } } } });

test("P570 parsing separates recorded death, unknown date, novalue and deprecated claims", () => {
  assert.deepEqual(parseLifeRecords(item([claim()]), ["Q1"]), [{ id: "Q1", present: true, deathRecorded: true }]);
  assert.equal(parseLifeRecords(item([claim("normal", "somevalue")]), ["Q1"])[0].deathRecorded, true);
  assert.equal(parseLifeRecords(item([claim("normal", "novalue")]), ["Q1"])[0].deathRecorded, false);
  assert.equal(parseLifeRecords(item([claim("deprecated")]), ["Q1"])[0].deathRecorded, false);
  assert.equal(parseLifeRecords(item([]), ["Q1"])[0].deathRecorded, false);
});

test("preferred Wikidata statements supersede normal ones without reviving deprecated claims", () => {
  assert.equal(parseLifeRecords(item([claim(), claim("preferred", "novalue")]), ["Q1"])[0].deathRecorded, false);
  assert.equal(parseLifeRecords(item([claim("normal", "novalue"), claim("preferred")]), ["Q1"])[0].deathRecorded, true);
});

test("missing linked entities differ from omitted, malformed and API-error responses", () => {
  assert.deepEqual(parseLifeRecords({ entities: { Q1: { id: "Q1", missing: "" } } }, ["Q1"]), [{ id: "Q1", present: false, deathRecorded: false }]);
  assert.throws(() => parseLifeRecords({ entities: {} }, ["Q1"]));
  assert.throws(() => parseLifeRecords({ entities: { Q1: { id: "Q2", claims: {} } } }, ["Q1"]));
  assert.throws(() => parseLifeRecords({ entities: { Q1: { id: "Q1" } } }, ["Q1"]));
  assert.throws(() => parseLifeRecords({ entities: {}, error: { code: "maxlag" } }, ["Q1"]));
  assert.throws(() => parseLifeRecords(item([{ rank: "normal", mainsnak: { property: "P570", snaktype: "value", datavalue: { type: "string", value: "unknown" } } }]), ["Q1"]));
});

test("an explicit Wikidata redirect preserves the requested identity without accepting an unrelated item", () => {
  const redirected = { entities: { Q1: { id: "Q2", redirects: { from: "Q1", to: "Q2" }, claims: { P570: [claim()] } } } };
  assert.deepEqual(parseLifeRecords(redirected, ["Q1"]), [{ id: "Q1", present: true, deathRecorded: true }]);
  assert.throws(() => parseLifeRecords({ entities: { Q1: { ...redirected.entities.Q1, redirects: { from: "Q3", to: "Q2" } } } }, ["Q1"]));
  assert.throws(() => parseLifeRecords({ entities: { Q1: { ...redirected.entities.Q1, redirects: { from: "Q1", to: "Q3" } } } }, ["Q1"]));
});

const source: Evidence = { provider: "wikidata", endpoint: "https://www.wikidata.org/w/api.php", params: { ids: "Q1|Q2|Q3" }, fetchedAt: "2026-10-23T00:00:00Z", cached: false };
const entity = (id: string, wikidataId: string | null, deathDate: string | null = null): Entity => ({ ...syntheticPlan().headliner, id, wikidataId, deathDate });

test("a Qloo-linked death or missing item is withheld while unlinked status remains explicitly unverified", async () => {
  const candidates = [entity("historical", "Q1"), entity("no-death-record", "Q2"), entity("missing", "Q3"), entity("unlinked", null), entity("qloo-death", null, "2001-01-01")];
  const result = await screenPerformers(candidates, undefined, async () => ({ records: [
    { id: "Q1", present: true, deathRecorded: true }, { id: "Q2", present: true, deathRecorded: false }, { id: "Q3", present: false, deathRecorded: false },
  ], evidence: source }));
  assert.deepEqual(result.eligible.map((e) => e.id), ["no-death-record", "unlinked"]);
  assert.equal(result.withheld, 3);
  assert.equal(result.unlinked, 1);
  assert.deepEqual(result.evidenceById.get("no-death-record"), [source]);
  assert.equal(result.evidenceById.has("unlinked"), false);
});

test("an external lookup failure propagates rather than accepting linked candidates as alive", async () => {
  await assert.rejects(screenPerformers([entity("linked", "Q1")], undefined, async () => { throw new Error("upstream unavailable"); }), /upstream unavailable/);
});
