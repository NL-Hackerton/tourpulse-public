import "server-only";
import { actionSchema, planSchema, sponsorCheckLimit, type PlanAction, type PlanEvent, type TourPlan } from "./contracts";
import { createTour } from "./planner";
import { scheduleTour } from "./schedule";
import { QlooError } from "./qloo";
import { allowedAnchor } from "./entity-policy";
import { activationSpot } from "./venue-review";
import { proposalPreferencesIssue } from "./proposal-preferences";

export async function applyAction(previous: TourPlan, rawAction: PlanAction, emit: (event: PlanEvent) => void, signal?: AbortSignal): Promise<TourPlan> {
  const started = performance.now();
  const action = actionSchema.parse(rawAction), plan = structuredClone(planSchema.parse(previous));
  signal?.throwIfAborted();
  let recalculate = false;
  let requiredStopIds: string[] | undefined;
  const stop = "cityId" in action ? plan.stops.find((s) => s.id === action.cityId) : undefined;
  if ("cityId" in action && action.type !== "forget_market_research" && !stop) throw new QlooError("The target city is not a stop in this revision.", 400);
  // User-planning input only: no Qloo request, schedule rebuild or research change.
  const commitLocal = (message: string) => {
    plan.brief = null; plan.revision = previous.revision + 1; plan.generatedAt = new Date().toISOString();
    const activity = { step: "Local action", message, status: "ok" as const, count: 0, ms: performance.now() - started, evidence: null };
    plan.trace = [...plan.trace.filter((trace) => trace.step !== "Local action"), activity];
    const result = planSchema.parse(plan); signal?.throwIfAborted();
    emit({ type: "trace", trace: activity }); emit({ type: "result", plan: result }); return result;
  };
  switch (action.type) {
    case "set_mode":
      plan.input.tourType = action.tourType; plan.input.headlinerId = action.headlinerId;
      plan.input.anchorIds = plan.anchors.filter((e) => e.id !== action.headlinerId && allowedAnchor(e)).map((e) => e.id);
      plan.input.neighborhoods = []; recalculate = true; break;
    case "set_headliner":
      plan.input.headlinerId = action.headlinerId;
      plan.input.anchorIds = plan.input.anchorIds.filter((id) => id !== action.headlinerId); recalculate = true; break;
    case "set_anchors":
      // createTour resolves every changed seed against Qloo and validates anchor types.
      plan.input.anchorIds = action.ids; recalculate = true; break;
    case "set_dates": plan.input.startDate = action.startDate; plan.input.endDate = action.endDate; break;
    case "set_drive": plan.input.maxDriveHours = action.maxDriveHours; break;
    case "set_show_days": plan.input.showDayPreference = action.preference; break;
    case "set_capacity": plan.input.capacity = action.capacity; recalculate = true; break;
    case "replace_city":
      if (plan.stops.some((s) => s.id === action.replacementId)) throw new QlooError("Replacement destination is already a selected stop.", 400);
      plan.input.candidateCityIds = [...new Set(plan.candidateCities.map((c) => c.id === action.cityId ? action.replacementId : c.id))];
      requiredStopIds = plan.stops.map((s) => s.id === action.cityId ? action.replacementId : s.id);
      plan.input.neighborhoods = plan.input.neighborhoods.filter((n) => n.cityId !== action.cityId); recalculate = true; break;
    case "select_neighborhood":
      if (!stop!.cells.some((c) => c.geohash === action.geohash)) throw new QlooError("Neighborhood is not a verified cell in this revision.", 400);
      plan.input.neighborhoods = [...plan.input.neighborhoods.filter((n) => n.cityId !== action.cityId), { cityId: action.cityId, geohash: action.geohash }]; recalculate = true; break;
    case "select_venue":
      if (!stop!.venues.some((v) => v.id === action.venueId)) throw new QlooError("Venue is outside this revision's retained candidates.", 400);
      if (stop!.venueDecisions.some((decision) => decision.entityId === action.venueId && decision.status === "exclude")) throw new QlooError("This venue is excluded from your shortlist. Review that decision before using it.", 422);
      stop!.selectedVenueId = action.venueId; break;
    case "select_partner":
      if (!stop!.partners.some((p) => p.id === action.placeId)) throw new QlooError("Partner is outside this revision's retained candidates.", 400);
      stop!.selectedPartnerIds = action.selected ? [...new Set([...stop!.selectedPartnerIds, action.placeId])] : stop!.selectedPartnerIds.filter((id) => id !== action.placeId); break;
    case "select_support": {
      const group = stop!.supportGroups.find((g) => g.candidates.some((c) => c.entity.id === action.candidateId));
      if (!group) throw new QlooError("Support candidate is not in this revision.", 400);
      stop!.selectedSupportIds = [...stop!.selectedSupportIds.filter((id) => !group.candidates.some((c) => c.entity.id === id)), action.candidateId]; break;
    }
    case "select_sponsor":
      if (!plan.sponsors.some((s) => s.entity.id === action.brandId)) throw new QlooError("Sponsor candidate is not in this revision.", 400);
      plan.selectedSponsorId = action.brandId; break;
    case "set_sponsor_tags": plan.input.sponsorIncludeTags = action.include; plan.input.sponsorExcludeTags = action.exclude; recalculate = true; break;
    case "confirm_place":
      if (!stop!.retainedPlaceIds.includes(action.confirmation.entityId)) throw new QlooError("Confirmation must refer to a retained place in this stop.", 400);
      stop!.confirmations = [...stop!.confirmations.filter((c) => !(c.entityId === action.confirmation.entityId && c.field === action.confirmation.field && c.forDate === action.confirmation.forDate)), action.confirmation];
      stop!.venueDecisions = stop!.venueDecisions.map((decision) => decision.entityId === action.confirmation.entityId ? { ...decision, needsReview: true } : decision); break;
    case "review_venue": {
      const venue = stop!.venues.find((candidate) => candidate.id === action.decision.entityId);
      if (!venue) throw new QlooError("Review a venue returned for this stop.", 400);
      if (!stop!.venueDecisions.some((decision) => decision.entityId === venue.id) && stop!.venueDecisions.length >= 12) throw new QlooError("This market has twelve saved decisions. Forget an assessment in the decision history before adding another; no exclusion was discarded.", 422);
      stop!.venueDecisions = [...stop!.venueDecisions.filter((decision) => decision.entityId !== venue.id), { ...action.decision, venueName: venue.name, decidedAt: new Date().toISOString(), needsReview: false }];
      if (action.decision.status === "exclude" && stop!.selectedVenueId === venue.id) stop!.selectedVenueId = null;
      break;
    }
    case "forget_venue_decision":
      if (!stop!.venueDecisions.some((decision) => decision.entityId === action.entityId)) throw new QlooError("No saved venue decision exists for this market and candidate.", 400);
      stop!.venueDecisions = stop!.venueDecisions.filter((decision) => decision.entityId !== action.entityId);
      if (!stop!.retainedPlaceIds.includes(action.entityId)) stop!.confirmations = stop!.confirmations.filter((confirmation) => confirmation.entityId !== action.entityId);
      break;
    case "forget_market_research": {
      // Only the listed historical records are removed. A live market's current
      // checks and decisions stay untouched, as does the route.
      if (!plan.archivedResearch.some((market) => market.id === action.cityId)) throw new QlooError("No historical research is saved for this market.", 400);
      plan.archivedResearch = plan.archivedResearch.filter((market) => market.id !== action.cityId);
      break;
    }
    case "set_proposal_preferences": {
      const issue = proposalPreferencesIssue(plan, action.preferences);
      if (issue) throw new QlooError(issue, 422);
      plan.input.proposalPreferences = action.preferences;
      return commitLocal("Saved proposal preferences as user planning input; the route, schedule, research and Qloo source evidence are unchanged.");
    }
    case "record_sponsor_check": {
      const sponsor = plan.sponsors.find((candidate) => candidate.entity.id === action.check.brandId);
      if (!sponsor) throw new QlooError("Record a purpose check for a sponsor candidate returned in this revision.", 400);
      // The stored name always comes from the returned candidate, never from the request.
      const check = { ...action.check, brandName: sponsor.entity.name };
      const others = plan.sponsorChecks.filter((saved) => !(saved.brandId === check.brandId && saved.purpose === check.purpose));
      if (others.length >= sponsorCheckLimit) throw new QlooError("This plan has twenty-four saved sponsor purpose checks. Forget one before adding another; no check was discarded.", 422);
      plan.sponsorChecks = [...others, check];
      return commitLocal("Saved your sourced sponsor purpose check as user research; the route, schedule, research and Qloo source evidence are unchanged.");
    }
    case "forget_sponsor_check": {
      if (!plan.sponsorChecks.some((saved) => saved.brandId === action.brandId && saved.purpose === action.purpose)) throw new QlooError("No sponsor purpose check is saved for this brand and purpose.", 400);
      plan.sponsorChecks = plan.sponsorChecks.filter((saved) => !(saved.brandId === action.brandId && saved.purpose === action.purpose));
      return commitLocal("Explicitly forgot a sponsor purpose check; the route, schedule, research and Qloo source evidence are unchanged.");
    }
  }
  if (action.type === "review_venue" || action.type === "forget_venue_decision") {
    plan.sponsors = plan.sponsors.map((sponsor) => ({ ...sponsor, activationSpots: sponsor.activationSpots.map((spot) => spot.stopId === stop!.id ? activationSpot(stop!, sponsor.placeAffinities) : spot) }));
  }
  if (recalculate) return createTour(plan.input, emit, signal, previous, requiredStopIds);
  // Validation also rejects reversed date windows without issuing a Qloo request.
  plan.brief = null; plan.revision = previous.revision + 1; plan.generatedAt = new Date().toISOString();
  plan.schedule = scheduleTour(plan.stops, plan.input, plan.sponsors, plan.selectedSponsorId);
  const oldDates = new Map(previous.schedule.rows.filter((r) => r.kind === "show").map((r) => [r.cityId, r.date]));
  const newDates = new Map(plan.schedule.rows.filter((r) => r.kind === "show").map((r) => [r.cityId, r.date]));
  for (const s of plan.stops) if (oldDates.get(s.id) !== newDates.get(s.id)) {
    s.confirmations = s.confirmations.map((c) => ({ ...c, needsReconfirmation: c.needsReconfirmation || c.forDate !== null || c.field === "availability" }));
    s.venueDecisions = s.venueDecisions.map((decision) => ({ ...decision, needsReview: true }));
  }
  const actionMessage = action.type === "forget_venue_decision" ? "Explicitly forgot a venue assessment and its attached notes if the venue was archived; Qloo source evidence is unchanged."
    : action.type === "forget_market_research" ? "Explicitly forgot the listed historical research records; the current route and current market research are unchanged."
    : `${action.type.replaceAll("_", " ")}; source evidence reused without a new Qloo request.`;
  const activity = { step: "Local action", message: actionMessage, status: "ok" as const, count: 0, ms: performance.now() - started, evidence: null };
  plan.trace = [...plan.trace.filter((trace) => trace.step !== "Local action"), activity];
  const result = planSchema.parse(plan); signal?.throwIfAborted();
  emit({ type: "trace", trace: activity }); emit({ type: "result", plan: result }); return result;
}
