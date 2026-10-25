import assert from "node:assert/strict";
import test from "node:test";
import { withinMarket } from "./geography";

const dc = { lat: 38.9072, lon: -77.0369 };

test("a Washington, D.C. market rejects Seattle even when a geocoder resolves Washington state", () => {
  assert.equal(withinMarket({ lat: 47.6137, lon: -122.3144 }, dc), false);
  assert.equal(withinMarket({ lat: 38.9167, lon: -77.0291 }, dc), true);
});

test("market boundary rejects missing/invalid coordinates and honors the distance limit", () => {
  assert.equal(withinMarket({ lat: null, lon: -77 }, dc), false);
  assert.equal(withinMarket({ lat: NaN, lon: -77 }, dc), false);
  assert.equal(withinMarket({ lat: 138, lon: -77 }, dc), false);
  assert.equal(withinMarket(dc, dc, 0), true);
  assert.equal(withinMarket({ lat: dc.lat + 0.5, lon: dc.lon }, dc), false);
  assert.equal(withinMarket({ lat: dc.lat + 0.1, lon: dc.lon }, dc), true);
});
