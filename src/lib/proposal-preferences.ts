import { proposalPreferencesSchema, type Place, type ProposalConstraint, type ProposalType, type Stop, type TourPlan } from "./contracts";

// Shared by the Sponsors controls and the server so the Draft button and the
// generator always agree on the saved purpose, target market and venue.
export const proposalTypeCopy: Record<ProposalType, { label: string; description: string }> = {
  on_site_activation: { label: "On-site audience activation", description: "A conditional brand presence for show audiences at one market's selected venue, subject to venue and brand agreement." },
  in_kind_support: { label: "In-kind touring essentials", description: "Products or services that could support the touring party, crew and production across the route, not an audience sales booth." },
  tour_grant: { label: "Tour-support discussion", description: "An open conversation about the scope of tour-wide support. No amount is proposed or implied." },
};

export const proposalConstraintLabels: Record<ProposalConstraint, string> = {
  no_onsite_activation: "No on-site activation at shows",
  no_attendee_signups: "No attendee sign-ups, surveys or feedback collection",
  no_merch_sales: "No merchandise or product sales",
  no_extra_days: "No added dates or tour days",
};

export type ProposalTarget =
  | { status: "ready"; scope: "tour" }
  | { status: "ready"; scope: "market"; stop: Stop; stopIndex: number; venue: Place }
  | { status: "blocked"; reason: string; stop: Stop | null };

/** Resolve the saved proposal scope. Never falls back to another market or venue. */
export function proposalTarget(plan: TourPlan): ProposalTarget {
  const { proposalType, focusCityId } = plan.input.proposalPreferences;
  if (proposalType !== "on_site_activation") return { status: "ready", scope: "tour" };
  if (focusCityId === null) return { status: "blocked", reason: "Choose and save a target market for the on-site activation.", stop: null };
  const stopIndex = plan.stops.findIndex((stop) => stop.id === focusCityId);
  if (stopIndex < 0) return { status: "blocked", reason: "The saved target market is no longer in the route. Choose and save a current target market.", stop: null };
  const stop = plan.stops[stopIndex];
  const venue = stop.venues.find((candidate) => candidate.id === stop.selectedVenueId);
  if (!venue) return { status: "blocked", reason: `Choose a venue candidate in ${stop.name} for the on-site activation.`, stop };
  if (stop.venueDecisions.some((decision) => decision.entityId === venue.id && decision.status === "exclude")) return { status: "blocked", reason: `The selected ${stop.name} venue is excluded. Review that decision or choose another ${stop.name} venue.`, stop };
  return { status: "ready", scope: "market", stop, stopIndex, venue };
}

/** Why these preferences cannot be saved for this plan, or null when they can. */
export function proposalPreferencesIssue(plan: TourPlan, raw: unknown): string | null {
  const parsed = proposalPreferencesSchema.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((issue) => issue.message).join(" ");
  const { proposalType, focusCityId } = parsed.data;
  if (proposalType === "on_site_activation") {
    if (focusCityId === null) return "Choose a target market in the current route for the on-site activation.";
    if (!plan.stops.some((stop) => stop.id === focusCityId)) return "The target market must be a stop in the current route.";
  }
  return null;
}
