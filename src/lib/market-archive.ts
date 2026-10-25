import type { ArchivedMarketResearch, Confirmation, Stop, TourPlan, VenueDecision } from "./contracts";
import { QlooError } from "./qloo";

type MarketSource = { name: string; decisions: VenueDecision[]; confirmations: Confirmation[]; places: Map<string, string> };

const confirmationKey = (confirmation: Confirmation) => `${confirmation.entityId}|${confirmation.field}|${confirmation.forDate ?? ""}`;

function sourceOfStop(stop: Stop): MarketSource {
  const places = new Map<string, string>();
  for (const place of [...stop.venues, ...stop.partners]) places.set(place.id, place.name);
  for (const decision of stop.venueDecisions) if (!places.has(decision.entityId)) places.set(decision.entityId, decision.venueName);
  return { name: stop.name, decisions: stop.venueDecisions.map((decision) => ({ ...decision })), confirmations: stop.confirmations.map((confirmation) => ({ ...confirmation })), places };
}

function sourceOfArchive(market: ArchivedMarketResearch): MarketSource {
  const places = new Map(market.places.map((place) => [place.id, place.name] as const));
  for (const decision of market.venueDecisions) if (!places.has(decision.entityId)) places.set(decision.entityId, decision.venueName);
  return { name: market.name, decisions: market.venueDecisions.map((decision) => ({ ...decision })), confirmations: market.confirmations.map((confirmation) => ({ ...confirmation })), places };
}

function mergeSources(base: MarketSource, extra: MarketSource): MarketSource {
  const decisions = new Map(base.decisions.map((decision) => [decision.entityId, decision]));
  for (const decision of extra.decisions) decisions.set(decision.entityId, decision);
  const confirmations = new Map(base.confirmations.map((confirmation) => [confirmationKey(confirmation), confirmation]));
  for (const confirmation of extra.confirmations) confirmations.set(confirmationKey(confirmation), confirmation);
  return { name: base.name, decisions: [...decisions.values()], confirmations: [...confirmations.values()], places: new Map([...base.places, ...extra.places]) };
}

function archivedEntry(id: string, name: string, confirmations: Confirmation[], decisions: VenueDecision[], places: Map<string, string>): ArchivedMarketResearch {
  const referenced = [...new Set([...decisions.map((decision) => decision.entityId), ...confirmations.map((confirmation) => confirmation.entityId)])];
  return { id, name, confirmations, venueDecisions: decisions, places: referenced.map((placeId) => ({ id: placeId, name: places.get(placeId) ?? placeId })) };
}

/** A complete historical record for a market, keeping user research only. */
export function archiveMarket(stop: Stop): ArchivedMarketResearch {
  const source = sourceOfStop(stop);
  return archivedEntry(stop.id, stop.name, source.confirmations, source.decisions, source.places);
}

/**
 * Recompute historical user research for a new revision.
 *
 * Every previous decision is merged back into its live stop before ranking. A
 * decision restored from history keeps its status (an exclusion stays
 * effective) and is marked for review; a decision already in the route keeps its
 * own review state. A recorded check is restored as stale only when its place is
 * retained or has a saved decision. Checks for places a live market no longer
 * offers stay in the archive as notes-only records with their saved names, so
 * they survive unrelated edits and later recalculations and are restored stale
 * if the place returns. Markets that left keep their complete research. No old
 * selection is ever restored, and exceeding the twelve-decision cap fails the
 * recalculation instead of evicting a decision.
 */
export function planMarketResearch(previous: TourPlan | undefined, stops: Stop[]): ArchivedMarketResearch[] {
  if (!previous) return [];
  const priorStops = new Map(previous.stops.map((stop) => [stop.id, stop]));
  const archivedById = new Map(previous.archivedResearch.map((market) => [market.id, market]));
  const live = new Set(stops.map((stop) => stop.id));
  const archived: ArchivedMarketResearch[] = [];

  for (const stop of stops) {
    const prior = priorStops.get(stop.id);
    const market = archivedById.get(stop.id);
    if (!prior && !market) continue;
    const priorSource = prior ? sourceOfStop(prior) : null;
    const history = market ? sourceOfArchive(market) : null;
    const decisions = new Map<string, VenueDecision>();
    for (const decision of history?.decisions ?? []) decisions.set(decision.entityId, { ...decision, needsReview: true });
    for (const decision of priorSource?.decisions ?? []) {
      // A live decision keeps its own review state, but never clears a review
      // required by the restored history.
      decisions.set(decision.entityId, { ...decision, needsReview: decision.needsReview || Boolean(decisions.get(decision.entityId)?.needsReview) });
    }
    for (const decision of stop.venueDecisions) decisions.set(decision.entityId, { ...decision, needsReview: decision.needsReview || Boolean(decisions.get(decision.entityId)?.needsReview) });
    const checks = new Map<string, Confirmation>();
    for (const confirmation of stop.confirmations) checks.set(confirmationKey(confirmation), confirmation);
    if (decisions.size > 12) throw new QlooError("This market's saved and current venue decisions exceed the twelve-decision limit. No decision was discarded; forget a saved assessment in the decision history first.", 422);
    stop.venueDecisions = [...decisions.values()];

    // A check stays live only while its place is retained or has a saved decision;
    // both are inspectable in the stop's dossier. Everything else becomes
    // historical notes rather than disappearing with the candidate set.
    const orphanNotes = new Map<string, Confirmation>();
    const restore = (confirmation: Confirmation) => {
      const key = confirmationKey(confirmation);
      if (!stop.retainedPlaceIds.includes(confirmation.entityId) && !decisions.has(confirmation.entityId)) orphanNotes.set(key, { ...confirmation, needsReconfirmation: true });
      else if (!checks.has(key)) checks.set(key, { ...confirmation, needsReconfirmation: true });
    };
    for (const [key, confirmation] of checks) {
      if (stop.retainedPlaceIds.includes(confirmation.entityId) || decisions.has(confirmation.entityId)) continue;
      orphanNotes.set(key, { ...confirmation, needsReconfirmation: true });
      checks.delete(key);
    }
    for (const confirmation of history?.confirmations ?? []) restore(confirmation);
    for (const confirmation of priorSource?.confirmations ?? []) restore(confirmation);
    stop.confirmations = [...checks.values()];
    if (orphanNotes.size) archived.push(archivedEntry(stop.id, stop.name, [...orphanNotes.values()], [], new Map([...(priorSource?.places ?? []), ...(history?.places ?? [])])));
  }

  // Everything absent from the new route keeps its complete research: any
  // history already archived plus whatever its previous stop carried.
  for (const stop of previous.stops) {
    if (live.has(stop.id)) continue;
    const market = archivedById.get(stop.id);
    if (!market) {
      if (stop.confirmations.length === 0 && stop.venueDecisions.length === 0) continue;
      archived.push(archiveMarket(stop));
      continue;
    }
    const source = mergeSources(sourceOfArchive(market), sourceOfStop(stop));
    if (source.decisions.length === 0 && source.confirmations.length === 0) continue;
    archived.push(archivedEntry(stop.id, source.name, source.confirmations, source.decisions, source.places));
  }
  for (const market of previous.archivedResearch) {
    if (live.has(market.id) || priorStops.has(market.id)) continue;
    if (market.venueDecisions.length === 0 && market.confirmations.length === 0) continue;
    archived.push(archivedEntry(market.id, market.name, market.confirmations, market.venueDecisions, new Map(market.places.map((place) => [place.id, place.name] as const))));
  }
  return archived;
}
