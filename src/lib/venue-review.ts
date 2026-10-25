import type { Confirmation, Place, Stop, TourPlan, VenueDecision } from "./contracts";

export const decisionLabels: Record<VenueDecision["status"], string> = {
  shortlist: "Shortlisted for follow-up", hold: "On hold", exclude: "Excluded",
};
const checkFields = ["capacity", "operating", "availability", "fee"] as const;
export const checkNames: Record<Confirmation["field"], string> = {
  capacity: "room capacity and configuration", operating: "current operations", availability: "date availability", fee: "fee and terms",
};

export function activationSpot(stop: Stop, observations: readonly { placeId: string; value: number | null }[]) {
  const excluded = new Set(stop.venueDecisions.filter((decision) => decision.status === "exclude").map((decision) => decision.entityId));
  let best: { placeId: string; value: number } | null = null;
  for (const observation of observations) {
    if (observation.value === null || !stop.retainedPlaceIds.includes(observation.placeId) || excluded.has(observation.placeId)) continue;
    if (!best || observation.value > best.value) best = { placeId: observation.placeId, value: observation.value };
  }
  return { stopId: stop.id, placeId: best?.placeId ?? null, affinity: best?.value ?? null };
}
/** Show date the working route assigns to a market, or null when it has none. */
export function scheduledShowDate(plan: TourPlan, stopId: string): string | null {
  return plan.schedule.rows.find((row) => row.kind === "show" && row.cityId === stopId)?.date ?? null;
}
/** A check counts toward a venue's current review only when it is not marked
 * for reconfirmation and its applies-date matches the scheduled show; an
 * availability check additionally needs that exact date. Shared by the
 * dossier and every export so a check is never current in one and stale in another. */
export function checkIsCurrent(note: Confirmation, showDate: string | null): boolean {
  return !note.needsReconfirmation && (!note.forDate || note.forDate === showDate) && (note.field !== "availability" || (showDate !== null && note.forDate === showDate));
}
/** The four check kinds with no current note, in a fixed order. */
export function missingCheckFields(currentNotes: readonly Confirmation[]): Confirmation["field"][] {
  return checkFields.filter((field) => !currentNotes.some((note) => note.field === field));
}
/** A recorded check is evidence to inspect, not an automatic pass or booking. */
export function venueReview(plan: TourPlan, stop: Stop, place: Place) {
  const showDate = scheduledShowDate(plan, stop.id);
  const notes = stop.confirmations.filter((note) => note.entityId === place.id);
  const currentNotes = notes.filter((note) => checkIsCurrent(note, showDate));
  const missingChecks = missingCheckFields(currentNotes).map((field) => checkNames[field]);
  const decision = stop.venueDecisions.find((item) => item.entityId === place.id) ?? null;
  const signals = [plan.headliner, ...plan.anchors].filter((entity) => (place.explainability[entity.id] ?? 0) > 0).map((entity) => entity.name);
  return { decision, notes, currentNotes, missingChecks, showDate,
    tasteReason: signals.length ? `Qloo reports contributions from ${signals.join(", ")}.` : `Returned by Qloo for this audience within ${stop.name}'s market boundary.`,
    nextStep: decision?.status === "exclude" ? "Review the exclusion before adding this venue to the working route."
      : decision?.needsReview ? "Revisit your decision: the plan or recorded checks changed."
      : missingChecks.length ? `Check ${missingChecks.join(", ")} before outreach.` : "Review the recorded findings and contact the venue; recorded checks do not confirm a booking.",
  };
}
