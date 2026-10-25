import assert from "node:assert/strict";
import test from "node:test";
import { applyAction } from "./actions";
import { validateProposedAction } from "./ai-policy";
import type { Stop, TourPlan } from "./contracts";
import { syntheticPlan } from "./domain-fixture";
import { archiveMarket, planMarketResearch } from "./market-archive";
import { scheduleTour } from "./schedule";
import { activationSpot } from "./venue-review";

const otherCity = "00000000-0000-4000-8000-000000000004";

function investmentPlan() {
  const plan = syntheticPlan(), stop = plan.stops[0], venue = stop.venues[0];
  stop.selectedVenueId = venue.id;
  stop.venueDecisions = [{ entityId: venue.id, venueName: venue.name, status: "exclude", reason: "The sourced room does not meet this plan's needs.", decidedAt: "2026-10-21T00:00:00Z", needsReview: false }];
  stop.confirmations = [{ entityId: venue.id, field: "capacity", value: "Published seated configuration", sourceUrl: "https://example.com/room", checkedAt: "2026-10-21T00:00:00Z", forDate: null, needsReconfirmation: false }];
  plan.schedule = scheduleTour(plan.stops, plan.input);
  return { plan, stop, venue };
}

/** A market rebuilt from Qloo for a new revision: no carried selections or research. */
function rebuiltStop(original: Stop, venueIds: string[]): Stop {
  const rebuilt = structuredClone(original);
  rebuilt.selectedVenueId = null; rebuilt.selectedPartnerIds = []; rebuilt.selectedSupportIds = [];
  rebuilt.venueDecisions = []; rebuilt.confirmations = [];
  rebuilt.venues = rebuilt.venues.filter((place) => venueIds.includes(place.id));
  rebuilt.retainedPlaceIds = rebuilt.venues.map((place) => place.id);
  return rebuilt;
}

function otherMarket(): Stop {
  return { ...rebuiltStop(syntheticPlan().stops[0], []), id: otherCity, name: "Synthetic other market" };
}

test("an absent market keeps its complete user research with lightweight place names only", () => {
  const { plan, stop, venue } = investmentPlan();
  const archived = planMarketResearch(plan, [otherMarket()]);
  assert.equal(archived.length, 1);
  assert.deepEqual(Object.keys(archived[0]).sort(), ["confirmations", "id", "name", "places", "venueDecisions"]);
  assert.equal(archived[0].id, stop.id);
  assert.deepEqual(archived[0].places, [{ id: venue.id, name: venue.name }]);
  assert.deepEqual(archived[0].venueDecisions, stop.venueDecisions);
  assert.deepEqual(archived[0].confirmations, stop.confirmations);
  assert.equal(plan.archivedResearch.length, 0);
  assert.deepEqual(archiveMarket({ ...stop, venueDecisions: [], confirmations: [] }).places, []);
});

test("a market that leaves keeps its exclusion effective through recalculation and return, and no old selection is restored", async () => {
  const { plan, stop, venue } = investmentPlan();
  const absent = [otherMarket()];
  const away = structuredClone(plan);
  away.stops = absent; away.archivedResearch = planMarketResearch(plan, absent); away.revision = 2;
  away.schedule = scheduleTour(away.stops, away.input);
  const awayEdited = await applyAction(away, { type: "set_drive", maxDriveHours: 4 }, () => {});
  assert.deepEqual(awayEdited.archivedResearch, away.archivedResearch);

  const returns = structuredClone(awayEdited);
  returns.stops = [...absent, rebuiltStop(stop, [venue.id])];
  returns.archivedResearch = planMarketResearch(returns, returns.stops);
  assert.deepEqual(returns.archivedResearch, []);
  const returned = returns.stops[1];
  assert.equal(returned.selectedVenueId, null);
  assert.deepEqual(returned.venueDecisions.map((decision) => [decision.entityId, decision.status, decision.needsReview]), [[venue.id, "exclude", true]]);
  assert.equal(returned.confirmations[0].needsReconfirmation, true);
  assert.equal(activationSpot(returned, [{ placeId: venue.id, value: 0.9 }]).placeId, null);

  assert.throws(() => validateProposedAction(returns, { type: "select_venue", cityId: stop.id, venueId: venue.id }, new Map(), new Map(), "use the venue"), /excluded/);
  await assert.rejects(applyAction(returns, { type: "select_venue", cityId: stop.id, venueId: venue.id }, () => {}), /Review that decision/);
  assert.equal(returns.stops[1].selectedVenueId, null);

  // Leaving again re-archives one record only; repeated recalculation never duplicates it.
  const leftAgain = planMarketResearch(returns, [absent[0]]);
  assert.equal(leftAgain.length, 1);
  assert.equal(leftAgain[0].id, stop.id);
  assert.deepEqual(planMarketResearch({ ...returns, archivedResearch: leftAgain }, [absent[0]]), leftAgain);
});

test("notes-only research for a candidate that no longer returns stays historical, survives edits, and is restored stale when its place returns", async () => {
  // A sourced check with no venue judgment in an active market.
  const plan = syntheticPlan(), stop = plan.stops[0], venue = stop.venues[0];
  stop.confirmations = [{ entityId: venue.id, field: "capacity", value: "Published seated configuration", sourceUrl: "https://example.com/room", checkedAt: "2026-10-21T00:00:00Z", forDate: null, needsReconfirmation: false }];
  plan.schedule = scheduleTour(plan.stops, plan.input);
  assert.deepEqual(planMarketResearch(plan, plan.stops), []);
  assert.equal(stop.confirmations.length, 1);

  // The market leaves the route: the note is archived with its saved name.
  const away = structuredClone(plan);
  away.stops = [otherMarket()];
  away.archivedResearch = planMarketResearch(plan, away.stops);
  assert.equal(away.archivedResearch.length, 1);
  assert.deepEqual(away.archivedResearch[0].places, [{ id: venue.id, name: venue.name }]);
  assert.equal(away.archivedResearch[0].venueDecisions.length, 0);

  // It returns with different candidates; the original venue is not offered, so
  // its note must not vanish and must not be restored as a live check.
  const returns = structuredClone(away);
  returns.stops = [...away.stops, rebuiltStop(stop, [])];
  returns.stops[1].venues = [{ ...venue, id: "00000000-0000-4000-8000-000000000009", name: "Another returned room" }];
  returns.stops[1].retainedPlaceIds = returns.stops[1].venues.map((place) => place.id);
  returns.archivedResearch = planMarketResearch(returns, returns.stops);
  const orphan = returns.archivedResearch.find((market) => market.id === stop.id);
  assert.ok(orphan);
  assert.deepEqual(orphan.places, [{ id: venue.id, name: venue.name }]);
  assert.equal(orphan.confirmations.length, 1);
  assert.equal(orphan.confirmations[0].entityId, venue.id);
  assert.equal(orphan.confirmations[0].needsReconfirmation, true);
  assert.equal(returns.stops[1].confirmations.length, 0);

  // An unrelated saved edit carries it unchanged.
  returns.schedule = scheduleTour(returns.stops, returns.input);
  const edited = await applyAction(returns, { type: "set_drive", maxDriveHours: 4 }, () => {});
  assert.deepEqual(edited.archivedResearch, returns.archivedResearch);

  // Further recalculation keeps it rather than dropping it.
  const recalculated = planMarketResearch(edited, edited.stops);
  assert.deepEqual(recalculated.find((market) => market.id === stop.id), edited.archivedResearch.find((market) => market.id === stop.id));
  assert.deepEqual(planMarketResearch({ ...edited, archivedResearch: recalculated }, edited.stops), recalculated);

  // When the original venue returns, only its note comes back, marked stale.
  const venueReturns = structuredClone(edited);
  venueReturns.stops = [...venueReturns.stops.slice(0, 1), rebuiltStop(stop, [venue.id])];
  venueReturns.archivedResearch = planMarketResearch(venueReturns, venueReturns.stops);
  assert.equal(venueReturns.archivedResearch.length, 0);
  const restored = venueReturns.stops[1];
  assert.equal(restored.confirmations.length, 1);
  assert.equal(restored.confirmations[0].entityId, venue.id);
  assert.equal(restored.confirmations[0].needsReconfirmation, true);
  assert.equal(restored.selectedVenueId, null);
});

test("a check and judgment merge back into a live market even when only its archived history remains", () => {
  const { plan, stop, venue } = investmentPlan();
  const archived = planMarketResearch(plan, [otherMarket()]);
  const returns = { ...plan, archivedResearch: archived, stops: [rebuiltStop(stop, [])] } satisfies TourPlan;
  returns.stops[0].venues = [{ ...venue, id: "00000000-0000-4000-8000-000000000009", name: "Another returned room" }];
  returns.stops[0].retainedPlaceIds = [returns.stops[0].venues[0].id];
  assert.deepEqual(planMarketResearch(returns, returns.stops), []);
  assert.deepEqual(returns.stops[0].venueDecisions.map((decision) => [decision.entityId, decision.status, decision.needsReview]), [[venue.id, "exclude", true]]);
  assert.equal(returns.stops[0].selectedVenueId, null);
  // The excluded venue's sourced check is restored with its decision, and is not
  // duplicated in the historical archive.
  assert.deepEqual(returns.stops[0].confirmations.map((confirmation) => confirmation.entityId), [venue.id]);
});

test("forgetting historical research only removes that archive entry, even for a live market", async () => {
  const { plan, stop, venue } = investmentPlan();
  // The live market still has its own venue/decision, while its historical entry
  // records a note for a candidate that is no longer offered.
  const live = rebuiltStop(stop, [venue.id]);
  live.venueDecisions = stop.venueDecisions.map((decision) => ({ ...decision, needsReview: true }));
  const orphan = archiveMarket({ ...stop, venueDecisions: [], confirmations: [{ ...stop.confirmations[0], needsReconfirmation: true }] });
  plan.stops = [live];
  plan.archivedResearch = [orphan];
  plan.schedule = scheduleTour(plan.stops, plan.input);
  const routeBefore = { stops: structuredClone(plan.stops), schedule: structuredClone(plan.schedule) };
  const unknown = "00000000-0000-4000-8000-000000000099";

  const forgotten = await applyAction(plan, { type: "forget_market_research", cityId: stop.id }, () => {});
  assert.deepEqual(forgotten.archivedResearch, []);
  assert.deepEqual(forgotten.stops, routeBefore.stops);
  assert.deepEqual(forgotten.schedule, routeBefore.schedule);
  assert.equal(forgotten.stops[0].confirmations.length, 0);
  assert.equal(forgotten.stops[0].venueDecisions.length, 1);
  assert.equal(forgotten.revision, plan.revision + 1);
  assert.match(forgotten.trace.at(-1)!.message, /Explicitly forgot the listed historical research/);

  await assert.rejects(applyAction(plan, { type: "forget_market_research", cityId: unknown }, () => {}), /No historical research/);
  assert.throws(() => validateProposedAction(plan, { type: "forget_market_research", cityId: stop.id }, new Map(), new Map(), "forget this market"), /historical research controls/);
  assert.equal(plan.archivedResearch.length, 1);

  // A forgotten entry is not resurrected by a later recalculation of the same live market.
  assert.deepEqual(planMarketResearch(forgotten, forgotten.stops), []);
  assert.equal(forgotten.stops[0].confirmations.length, 0);
});
