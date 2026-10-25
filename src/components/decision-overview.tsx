"use client";

import { ChevronRight } from "lucide-react";
import type { TourPlan } from "@/lib/contracts";
import { decisionLabels, venueReview } from "@/lib/venue-review";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const revisitHint = "Marked when you save a newer source check for the venue, when its show date moves, or when its market returns to the route. Your earlier reason is kept; review it and save it again. Until then it does not count as shortlisted.";

// One row per market in route order: the working venue and the user's judgment
// of it. A row opens that market's venue research.
export default function DecisionOverview({ plan, onReview }: { plan: TourPlan; onReview: (cityId: string) => void }) {
  const decisions = plan.stops.flatMap((stop) => stop.venueDecisions.filter((decision) => stop.venues.some((venue) => venue.id === decision.entityId)));
  const archivedCount = plan.stops.reduce((total, stop) => total + stop.venueDecisions.length, 0) - decisions.length;
  const historicalRecords = plan.archivedResearch.length;
  const shortlist = decisions.filter((decision) => decision.status === "shortlist" && !decision.needsReview).length;
  const excluded = decisions.filter((decision) => decision.status === "exclude").length;
  const revisit = decisions.filter((decision) => decision.needsReview).length;
  return <section className="decision-overview" aria-label="Venue research queue">
    <div className="decision-overview-heading"><div><h2>Venue research</h2><p>One row per market in route order. Open a row to assess its venue candidates.</p></div>
      <div className="decision-tally">
        <span className="decision-badge shortlist">{count(shortlist, "shortlisted", "shortlisted")}</span>
        {excluded > 0 && <span className="decision-badge exclude">{count(excluded, "excluded", "excluded")}</span>}
        {revisit > 0 && <span className="decision-badge review" title={revisitHint}>{count(revisit, "to revisit", "to revisit")}</span>}
        {archivedCount > 0 && <span className="decision-badge unreviewed">{count(archivedCount, "archived", "archived")}</span>}
        {historicalRecords > 0 && <span className="decision-badge unreviewed">{count(historicalRecords, "historical record", "historical records")}</span>}
      </div>
    </div>
    {revisit > 0 && <p className="field-hint decision-review-note">{revisitHint}</p>}
    <div className="research-queue-head" aria-hidden="true"><span /><span>Market and venue</span><span className="research-queue-reason">Your reason</span><span>Status</span><span /></div>
    <ol className="research-queue">{plan.schedule.orderedStopIds.map((id, index) => {
      const stop = plan.stops.find((candidate) => candidate.id === id);
      if (!stop) return null;
      const selected = stop.venues.find((venue) => venue.id === stop.selectedVenueId);
      const review = selected ? venueReview(plan, stop, selected) : null;
      const status = review?.decision ? review.decision.needsReview ? "Revisit decision" : decisionLabels[review.decision.status] : "Needs assessment";
      const venueLabel = selected?.name ?? (stop.venues.length ? "No venue chosen" : "No venue candidates returned");
      const reasonId = `research-reason-${id}`;
      return <li key={id}><button className="research-queue-row" aria-label={`Review ${stop.name}: ${venueLabel}, ${status}`} aria-describedby={review?.decision ? reasonId : undefined} onClick={() => onReview(id)}>
        <span className="research-queue-num">{index + 1}</span>
        <span className="research-queue-market"><strong>{stop.name}</strong><span>{venueLabel}</span></span>
        <span className="research-queue-reason" id={reasonId}>{review?.decision ? <><span className="sr-only">Your reason: </span>{review.decision.reason}</> : null}</span>
        <span className={`decision-badge ${review?.decision ? review.decision.needsReview ? "review" : review.decision.status : "unreviewed"}`}>{status}</span>
        <ChevronRight size={16} aria-hidden="true" />
      </button></li>;
    })}</ol>
  </section>;
}
