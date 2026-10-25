import assert from "node:assert/strict";
import test from "node:test";
import { planInputSchema, proposalPreferencesSchema, type Stop, type TourPlan } from "./contracts";
import { syntheticPlan } from "./domain-fixture";
import { applyAction } from "./actions";
import { validateProposedAction } from "./ai-policy";
import { briefFacts } from "./ai-facts";
import { proposalTarget } from "./proposal-preferences";

const bostonId = "00000000-0000-4000-8000-000000000004";
const bostonVenueId = "00000000-0000-4000-8000-000000000005";

// Pittsburgh-like first stop with a selected venue, Boston second stop without one.
function twoMarketPlan(): TourPlan {
  const plan = syntheticPlan(), first = plan.stops[0];
  first.selectedVenueId = first.venues[0].id;
  const boston: Stop = { ...structuredClone(first), id: bostonId, name: "Synthetic Boston", selectedVenueId: null,
    venues: [{ ...first.venues[0], id: bostonVenueId, name: "Synthetic Boston Venue" }], retainedPlaceIds: [bostonVenueId] };
  plan.stops.push(boston);
  plan.candidateCities.push({ ...plan.candidateCities[0], id: bostonId, name: boston.name });
  return plan;
}
const onSite = (focusCityId: string | null) => ({ proposalType: "on_site_activation" as const, focusCityId, constraints: [] });

test("saving preferences clears the old proposal and keeps route, schedule and current plus historical research", async () => {
  const previous = twoMarketPlan();
  previous.stops[0].confirmations = [{ entityId: previous.stops[0].venues[0].id, field: "availability", value: "User checked", sourceUrl: "https://example.invalid/source", checkedAt: "2026-10-20T00:00:00Z", forDate: "2026-10-22", needsReconfirmation: false }];
  previous.stops[0].venueDecisions = [{ entityId: previous.stops[0].venues[0].id, venueName: "Synthetic Venue", status: "shortlist", reason: "Room fits the plan.", decidedAt: "2026-10-20T00:00:00Z", needsReview: false }];
  previous.archivedResearch = [{ id: "00000000-0000-4000-8000-000000000009", name: "Synthetic absent market", confirmations: [], venueDecisions: [], places: [] }];
  previous.schedule.rows = [{ kind: "show", date: "2026-10-22", cityId: previous.stops[0].id, city: previous.stops[0].name, neighborhood: "", venue: "Synthetic Venue", driveKm: 0, driveHours: 0, reason: "Synthetic", warnings: [], support: [], sponsors: [] }];
  previous.brief = { planId: previous.id, revision: 1, brandId: "synthetic-brand", createdAt: previous.generatedAt, model: "synthetic-model", title: "Old", summary: "Old", proposalType: "on_site_activation", sections: [], emailSubject: "Old", emailBody: "Old", facts: [], warnings: [] };
  const before = structuredClone(previous);
  const preferences = { proposalType: "in_kind_support" as const, focusCityId: null, constraints: ["no_extra_days" as const, "no_onsite_activation" as const] };
  const result = await applyAction(previous, { type: "set_proposal_preferences", preferences }, () => {});
  assert.deepEqual(previous, before);
  assert.equal(result.revision, previous.revision + 1);
  assert.equal(result.brief, null);
  // Canonical order, every chosen constraint retained.
  assert.deepEqual(result.input.proposalPreferences, { proposalType: "in_kind_support", focusCityId: null, constraints: ["no_onsite_activation", "no_extra_days"] });
  assert.deepEqual({ ...result.input, proposalPreferences: null }, { ...previous.input, proposalPreferences: null });
  assert.deepEqual(result.schedule, previous.schedule);
  assert.deepEqual(result.stops, previous.stops);
  assert.deepEqual(result.archivedResearch, previous.archivedResearch);
  assert.deepEqual(result.sponsors, previous.sponsors);
});

test("conflicting or misplaced preferences are rejected with an explanation, never silently dropped", async () => {
  const plan = twoMarketPlan();
  const conflict = proposalPreferencesSchema.safeParse({ proposalType: "on_site_activation", focusCityId: bostonId, constraints: ["no_onsite_activation"] });
  assert.equal(conflict.success, false);
  assert.match(conflict.error!.issues.map((issue) => issue.message).join(" "), /conflicts/);
  assert.equal(proposalPreferencesSchema.safeParse({ proposalType: "tour_grant", focusCityId: null, constraints: ["no_merch_sales", "no_merch_sales"] }).success, false);
  assert.equal(proposalPreferencesSchema.safeParse({ proposalType: "tour_grant", focusCityId: bostonId, constraints: [] }).success, false);
  assert.equal(proposalPreferencesSchema.safeParse({ proposalType: "tour_grant", focusCityId: null, constraints: [], note: "free text" }).success, false);
  await assert.rejects(applyAction(plan, { type: "set_proposal_preferences", preferences: { proposalType: "on_site_activation", focusCityId: bostonId, constraints: ["no_onsite_activation"] } }, () => {}));
  await assert.rejects(applyAction(plan, { type: "set_proposal_preferences", preferences: onSite(null) }, () => {}), /target market/);
  await assert.rejects(applyAction(plan, { type: "set_proposal_preferences", preferences: onSite("00000000-0000-4000-8000-000000000099") }, () => {}), /current route/);
  // A target market may be saved before any venue there is chosen.
  assert.equal((await applyAction(plan, { type: "set_proposal_preferences", preferences: onSite(bostonId) }, () => {})).input.proposalPreferences.focusCityId, bostonId);
});

test("plan input requires explicit proposal preferences instead of inventing a default", () => {
  const input: Record<string, unknown> = { ...syntheticPlan().input };
  delete input.proposalPreferences;
  assert.equal(planInputSchema.safeParse(input).success, false);
});

test("the assistant cannot choose or change proposal preferences", () => {
  const plan = twoMarketPlan();
  assert.throws(() => validateProposedAction(plan, { type: "set_proposal_preferences", preferences: { proposalType: "tour_grant", focusCityId: null, constraints: [] } }, new Map(), new Map(), "Switch the proposal to a tour grant."), /Proposal preferences controls/);
});

test("an on-site proposal targets only the saved market and never borrows another market's venue", () => {
  const plan = twoMarketPlan();
  plan.input.proposalPreferences = onSite(null);
  assert.equal(proposalTarget(plan).status, "blocked");
  plan.input.proposalPreferences = onSite(bostonId);
  const missingVenue = proposalTarget(plan);
  assert.equal(missingVenue.status, "blocked");
  assert.match(missingVenue.status === "blocked" ? missingVenue.reason : "", /Synthetic Boston/);
  plan.stops[1].selectedVenueId = bostonVenueId;
  const ready = proposalTarget(plan);
  assert.ok(ready.status === "ready" && ready.scope === "market");
  assert.equal(ready.stop.id, bostonId);
  assert.equal(ready.venue.id, bostonVenueId);
  plan.stops[1].venueDecisions = [{ entityId: bostonVenueId, venueName: "Synthetic Boston Venue", status: "exclude", reason: "Room does not fit.", decidedAt: "2026-10-20T00:00:00Z", needsReview: false }];
  assert.equal(proposalTarget(plan).status, "blocked");
  plan.stops = plan.stops.filter((stop) => stop.id !== bostonId);
  const gone = proposalTarget(plan);
  assert.ok(gone.status === "blocked" && /no longer in the route/.test(gone.reason));
});

test("tour-wide purposes need no selected venue and record user choices as user facts, not Qloo evidence", () => {
  const plan = syntheticPlan();
  plan.stops[0].selectedVenueId = null;
  plan.input.proposalPreferences = { proposalType: "tour_grant", focusCityId: null, constraints: ["no_attendee_signups"] };
  assert.deepEqual(proposalTarget(plan), { status: "ready", scope: "tour" });
  const evidence = { endpoint: "/v2/analysis/compare", params: {}, fetchedAt: "2026-10-20T00:00:00Z", cached: false };
  const sponsor = { entity: { ...plan.headliner, id: "00000000-0000-4000-8000-000000000008", name: "Synthetic Brand", type: "urn:entity:brand" }, rank: 1,
    fit: { score: null, baseScore: 0.5, placeAffinity: null, status: "insufficient_evidence" as const, observedPlaces: 0, totalPlaces: 0, warnings: [] },
    anchorDelta: null, explainability: {}, activationSpots: [], placeAffinities: [], evidence: [evidence] };
  const facts = briefFacts(plan, sponsor, [], [], evidence);
  const choices = facts.filter((fact) => fact.id.startsWith("proposal_"));
  assert.deepEqual(choices.map((fact) => [fact.id, fact.kind, fact.evidence.length]), [["proposal_goal", "user", 0], ["proposal_scope", "user", 0], ["proposal_constraint_1", "user", 0]]);
  assert.equal(facts.find((fact) => fact.id === "proposal_scope")?.value, "Tour-wide");
  assert.equal(facts.some((fact) => fact.id.endsWith("_venue")), false);
});
