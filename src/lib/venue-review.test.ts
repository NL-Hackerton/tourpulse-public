import assert from "node:assert/strict";
import test from "node:test";
import { applyAction } from "./actions";
import { syntheticPlan } from "./domain-fixture";
import { scheduleTour } from "./schedule";
import { activationSpot, venueReview } from "./venue-review";
import { validateProposedAction } from "./ai-policy";

function planned() {
  const plan = syntheticPlan();
  plan.schedule = scheduleTour(plan.stops, plan.input);
  return plan;
}

test("excluding the selected venue clears the working route and prevents reselection until reviewed", async () => {
  const previous = planned(), stop = previous.stops[0], venue = stop.venues[0];
  stop.selectedVenueId = venue.id;
  const excluded = await applyAction(previous, { type: "review_venue", cityId: stop.id, decision: {
    entityId: venue.id, venueName: venue.name, status: "exclude", reason: "The sourced room configuration does not meet this plan's needs.", decidedAt: new Date().toISOString(), needsReview: false,
  } }, () => {});
  assert.equal(previous.stops[0].selectedVenueId, venue.id);
  assert.equal(excluded.stops[0].selectedVenueId, null);
  assert.equal(excluded.schedule.rows.find((row) => row.kind === "show")?.venue, "");
  await assert.rejects(applyAction(excluded, { type: "select_venue", cityId: stop.id, venueId: venue.id }, () => {}), /excluded/);
  const reviewed = await applyAction(excluded, { type: "review_venue", cityId: stop.id, decision: {
    ...excluded.stops[0].venueDecisions[0], status: "hold", reason: "A different room configuration is now under review.",
  } }, () => {});
  const selected = await applyAction(reviewed, { type: "select_venue", cityId: stop.id, venueId: venue.id }, () => {});
  assert.equal(selected.stops[0].selectedVenueId, venue.id);
  assert.equal(selected.stops[0].venueDecisions[0].status, "hold");
});

test("a changed show date or new sourced finding makes a previous venue judgment need review", async () => {
  const plan = planned(), stop = plan.stops[0], venue = stop.venues[0];
  stop.venueDecisions = [{ entityId: venue.id, venueName: venue.name, status: "shortlist", reason: "Keep for a capacity and terms check.", decidedAt: new Date().toISOString(), needsReview: false }];
  const changed = await applyAction(plan, { type: "set_dates", startDate: "2026-10-29", endDate: "2026-11-20" }, () => {});
  assert.equal(changed.stops[0].venueDecisions[0].needsReview, true);
  assert.equal(plan.stops[0].venueDecisions[0].needsReview, false);
  const checked = await applyAction(plan, { type: "confirm_place", cityId: stop.id, confirmation: {
    entityId: venue.id, field: "capacity", value: "Synthetic source states a different seated layout.", sourceUrl: "https://example.com/room", checkedAt: new Date().toISOString(), forDate: null, needsReconfirmation: false,
  } }, () => {});
  assert.equal(checked.stops[0].venueDecisions[0].needsReview, true);
});

test("a sourced check must cite a public web address, never a local or IP host", async () => {
  const plan = planned(), stop = plan.stops[0], venue = stop.venues[0];
  const check = (sourceUrl: string) => applyAction(plan, { type: "confirm_place", cityId: stop.id, confirmation: {
    entityId: venue.id, field: "capacity", value: "Published seated layout", sourceUrl, checkedAt: "2026-10-21T00:00:00Z", forDate: null, needsReconfirmation: false,
  } }, () => {});
  for (const url of ["http://127.0.0.1/private", "http://2130706433/", "http://[::1]/", "http://localhost:3000/", "https://intranet/room", "https://printer.local/", "https://venue.corp/sheet", "https://user:pw@example.com/"]) await assert.rejects(check(url), /public http\(s\) web address/, url);
  const saved = await check("https://www.example.com/venue/room.pdf");
  assert.equal(saved.stops[0].confirmations.at(-1)?.sourceUrl, "https://www.example.com/venue/room.pdf");
});

test("date-mismatched availability and stale notes do not count as current checks", () => {
  const plan = planned(), stop = plan.stops[0], venue = stop.venues[0];
  stop.confirmations = [
    { entityId: venue.id, field: "capacity", value: "300 seated", sourceUrl: "https://example.com/room", checkedAt: "2026-10-20T00:00:00Z", forDate: null, needsReconfirmation: false },
    { entityId: venue.id, field: "availability", value: "Available on the checked date only", sourceUrl: "https://example.com/dates", checkedAt: "2026-10-20T00:00:00Z", forDate: "2026-12-01", needsReconfirmation: false },
    { entityId: venue.id, field: "fee", value: "Old quoted terms", sourceUrl: "https://example.com/terms", checkedAt: "2026-10-20T00:00:00Z", forDate: null, needsReconfirmation: true },
  ];
  const review = venueReview(plan, stop, venue);
  assert.deepEqual(review.currentNotes.map((note) => note.field), ["capacity"]);
  assert.equal(review.notes.length, 3);
  assert.equal(review.decision, null);
});

test("an excluded venue is not reused as a sponsor activation suggestion", () => {
  const stop = planned().stops[0], venue = stop.venues[0];
  const partnerId = "00000000-0000-4000-8000-000000000007";
  stop.retainedPlaceIds.push(partnerId);
  const observations = [{ placeId: venue.id, value: 0.9 }, { placeId: partnerId, value: 0.7 }];
  stop.venueDecisions = [{ entityId: venue.id, venueName: venue.name, status: "exclude", reason: "The room does not meet the configuration requirement.", decidedAt: "2026-10-21T00:00:00Z", needsReview: false }];
  assert.equal(activationSpot(stop, observations).placeId, partnerId);
  assert.equal(activationSpot(stop, [{ placeId: venue.id, value: 0.9 }]).placeId, null);
  stop.venueDecisions = [];
  assert.equal(activationSpot(stop, observations).placeId, venue.id);
});

test("preview and apply both reject an exclusion until the user explicitly forgets it", async () => {
  const plan = planned(), stop = plan.stops[0], venue = stop.venues[0];
  stop.venueDecisions = [{ entityId: venue.id, venueName: venue.name, status: "exclude", reason: "The room does not meet the requirement.", decidedAt: "2026-10-21T00:00:00Z", needsReview: false }];
  const selection = { type: "select_venue" as const, cityId: stop.id, venueId: venue.id };
  assert.throws(() => validateProposedAction(plan, selection, new Map(), new Map(), "Use the venue"), /excluded/);
  const cleared = await applyAction(plan, { type: "forget_venue_decision", cityId: stop.id, entityId: venue.id }, () => {});
  assert.equal(cleared.stops[0].selectedVenueId, null);
  assert.equal(validateProposedAction(cleared, selection, new Map(), new Map(), "Use the venue").type, "select_venue");
  assert.equal(plan.stops[0].venueDecisions[0].status, "exclude");
});

test("a full decision history preserves exclusions and can be freed without abandoning the plan", async () => {
  const plan = planned(), stop = plan.stops[0], venue = stop.venues[0];
  stop.venueDecisions = Array.from({ length: 12 }, (_, index) => ({
    entityId: `00000000-0000-4000-8000-${(index + 20).toString(16).padStart(12, "0")}`,
    venueName: `Previously returned venue ${index}`, status: "exclude" as const,
    reason: "An earlier room configuration did not meet the requirement.",
    decidedAt: "2026-10-21T00:00:00Z", needsReview: true,
  }));
  const action = { type: "review_venue" as const, cityId: stop.id, decision: {
    entityId: venue.id, venueName: "Untrusted supplied name", status: "hold" as const,
    reason: "Check the current venue configuration.", decidedAt: "2026-10-21T00:00:00Z", needsReview: false,
  } };
  await assert.rejects(applyAction(plan, action, () => {}), { status: 422 });
  const freed = await applyAction(plan, { type: "forget_venue_decision", cityId: stop.id, entityId: stop.venueDecisions[0].entityId }, () => {});
  const recorded = await applyAction(freed, action, () => {});
  assert.equal(recorded.stops[0].venueDecisions.length, 12);
  assert.equal(recorded.stops[0].venueDecisions.find((decision) => decision.entityId === venue.id)?.venueName, venue.name);
  assert.equal(plan.stops[0].venueDecisions.length, 12);
});

test("forgetting an archive removes attached notes, while current-venue checks remain available", async () => {
  for (const archived of [false, true]) {
    const plan = planned(), stop = plan.stops[0], venue = stop.venues[0];
    stop.venueDecisions = [{ entityId: venue.id, venueName: venue.name, status: "hold", reason: "Confirm the current room configuration.", decidedAt: "2026-10-21T00:00:00Z", needsReview: false }];
    stop.confirmations = [{ entityId: venue.id, field: "capacity", value: "Published seated configuration", sourceUrl: "https://example.com/room", checkedAt: "2026-10-21T00:00:00Z", forDate: null, needsReconfirmation: false }];
    if (archived) { stop.venues = []; stop.retainedPlaceIds = []; }
    const result = await applyAction(plan, { type: "forget_venue_decision", cityId: stop.id, entityId: venue.id }, () => {});
    assert.equal(result.stops[0].venueDecisions.length, 0);
    assert.equal(result.stops[0].confirmations.length, archived ? 0 : 1);
    assert.equal(plan.stops[0].confirmations.length, 1);
  }
});
