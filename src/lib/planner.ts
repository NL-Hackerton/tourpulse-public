import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { candidateCities, planInputSchema, planSchema, type Cell, type City, type Evidence, type Place, type PlanEvent, type PlanInput, type Stop, type TourPlan, type Trace } from "./contracts";
import { cityFit, decodeGeohash, meanAffinity, neighborhoodScore, rankScore } from "./scoring";
import { scheduleTour } from "./schedule";
import { withinMarket } from "./geography";
import { aggregateNeighborhoods } from "./neighborhoods";
import { recommend } from "./recommendations";
import { allowedAnchor, catalogDestination, isAdultEntertainment, validHeadliner } from "./entity-policy";
import { cellRowSchema, contributions, entityRows, normalizeEntity, qloo, QlooError, safeError, verifySponsorTags, type QlooResponse, type QlooRow } from "./qloo";
import { planMarketResearch } from "./market-archive";
import { performanceStatusLimit, screenPerformers } from "./performance-eligibility";

function coordinates(row: QlooRow) {
  return { lat: row.location?.lat ?? row.location?.latitude ?? row.properties?.geocode?.latitude ?? null, lon: row.location?.lon ?? row.location?.longitude ?? row.properties?.geocode?.longitude ?? null };
}
function toPlace(row: QlooRow, evidence: Evidence, seeds: string[]): Place {
  const website = row.properties?.website ?? "";
  return { id: row.entity_id.toLowerCase(), name: row.name, ...coordinates(row), affinity: row.query?.affinity ?? null,
    address: row.properties?.address ?? "", neighborhood: row.properties?.neighborhood ?? "",
    website: /^https?:\/\//i.test(website) ? website : "", tags: (row.tags ?? []).map((tag) => tag.id).filter(Boolean), explainability: contributions(row, seeds), evidence };
}
export async function createTour(rawInput: PlanInput, emit: (event: PlanEvent) => void, signal?: AbortSignal, previous?: TourPlan, requiredStopIds?: readonly string[]): Promise<TourPlan> {
  const input = planInputSchema.parse(rawInput), trace: Trace[] = [];
  function report(value: Trace) { signal?.throwIfAborted(); trace.push(value); emit({ type: "trace", trace: value }); }
  const verifiedTags = await verifySponsorTags([...input.sponsorIncludeTags, ...input.sponsorExcludeTags], signal);
  if (verifiedTags) report({ step: "S6 tag validation", message: "Verify requested brand tags against Qloo's catalog.", status: "ok", count: verifiedTags.tags.length, ms: verifiedTags.ms, evidence: verifiedTags.evidence });
  async function call<T>(step: string, endpoint: "/search" | "/entities" | "/v2/insights", params: Record<string, string>, parse: (r: QlooResponse) => T[], message: string) {
    signal?.throwIfAborted(); const start = performance.now();
    try {
      const response = await qloo(endpoint, params, signal), values = parse(response);
      report({ step, message, status: values.length ? "ok" : "empty", count: values.length, ms: performance.now() - start, evidence: response.evidence });
      return { values, evidence: response.evidence };
    } catch (error) {
      signal?.throwIfAborted(); report({ step, message: safeError(error), status: "error", count: 0, ms: performance.now() - start, evidence: error instanceof QlooError ? error.evidence : null }); throw error;
    }
  }
  const rows = (step: string, params: Record<string, string>, message: string, endpoint: "/v2/insights" | "/entities" = "/v2/insights") => call(step, endpoint, params, (r) => entityRows(r.body), message);
  const seeds = [input.headlinerId, ...input.anchorIds].map((id) => id.toLowerCase());
  const sameAudience = previous && previous.input.tourType === input.tourType && previous.input.headlinerId === input.headlinerId && JSON.stringify(previous.input.anchorIds) === JSON.stringify(input.anchorIds);
  const seedResolution = sameAudience
    ? { values: [previous.headliner, ...previous.anchors], evidence: previous.seedEvidence }
    : await call("S1", "/entities", { entity_ids: seeds.join(",") }, (r) => entityRows(r.body).map(normalizeEntity), "Resolve selected taste entities.")
      .then(({ values, evidence }) => ({ values, evidence: [evidence] }));
  const resolved = seedResolution.values;
  const byId = new Map(resolved.map((e) => [e.id, e])), headliner = byId.get(seeds[0]);
  if (!headliner || !validHeadliner(headliner, input.tourType)) throw new QlooError("Choose a headliner of the selected mode with verified category evidence and no recorded death. Current activity and availability still need checking.", 400);
  if (!sameAudience) {
    const started = performance.now();
    const screened = await screenPerformers([headliner], signal);
    report({ step: "S1 eligibility", message: "Check only the headliner's Qloo-linked biographical record; anchors are cultural references.", status: screened.eligible.length ? "ok" : "empty", count: screened.eligible.length, ms: performance.now() - started, evidence: screened.evidence });
    if (!screened.eligible.length) throw new QlooError("The headliner has a recorded death or an unresolved linked biographical record. Choose another performance headliner; historical entities may still be cultural anchors.", 400, screened.evidence);
    if (screened.evidence) seedResolution.evidence.push(screened.evidence);
  }
  const anchors = input.anchorIds.map((id) => byId.get(id.toLowerCase()));
  if (anchors.some((e) => !e || !allowedAnchor(e))) throw new QlooError("Every anchor must resolve to a supported taste entity.", 400);
  const validAnchors = anchors.filter((e) => e !== undefined);
  let cities: City[];
  const sameCities = previous && JSON.stringify(previous.input.candidateCityIds) === JSON.stringify(input.candidateCityIds);
  if (sameCities) cities = previous.candidateCities;
  else if (input.candidateCityIds.length) {
    const result = await call("S2 resolve", "/entities", { entity_ids: input.candidateCityIds.join(",") }, (r) => entityRows(r.body), "Resolve the exact custom destination set.");
    cities = input.candidateCityIds.map((id) => {
      const row = result.values.find((r) => r.entity_id.toLowerCase() === id.toLowerCase());
      const entity = row ? normalizeEntity(row) : null;
      if (!entity || entity.type !== "urn:entity:destination" || !entity.location || !entity.country) throw new QlooError("Every replacement must be a verified destination with coordinates and an evidenced country.", 400);
      return { id: entity.id, name: entity.name, ...entity.location, country: entity.country, countrySource: entity.countrySource, evidence: result.evidence };
    });
  } else {
    cities = [];
    for (const city of candidateCities) {
      const result = await call("S2 resolve", "/search", { query: city.name, types: "urn:entity:destination", take: "8" }, (r) => entityRows(r.body), `Resolve ${city.name}.`);
      const exact = result.values.find((r) => {
        const entity = normalizeEntity(r);
        return entity.type === "urn:entity:destination" && catalogDestination(r.name, entity.location)?.name === city.name
          && /^(?:us|usa|united states(?: of america)?)$/i.test(entity.country ?? "");
      });
      if (!exact) throw new QlooError(`Could not unambiguously resolve ${city.name}.`);
      const identity = normalizeEntity(exact);
      cities.push({ id: identity.id, ...city, country: identity.country, countrySource: identity.countrySource, evidence: result.evidence });
    }
  }
  if (input.neighborhoods.some((n) => !cities.some((c) => c.id === n.cityId))) throw new QlooError("Neighborhood city is outside the candidate set.", 400);
  const destinationParams = { "filter.type": "urn:entity:destination", "filter.results.entities": cities.map((c) => c.id).join(","), take: String(cities.length), "feature.explainability": "true" };
  let ranked: { city: City; rank: number; affinity: number | null; why: Record<string, number>; evidence: Evidence[]; delta: number | null }[];
  if (sameAudience && sameCities) ranked = previous.stops.map((s) => ({ city: cities.find((c) => c.id === s.id)!, rank: s.destinationRank, affinity: s.affinity, why: s.explainability, evidence: s.evidence.filter((e) => e.params["filter.type"] === "urn:entity:destination"), delta: s.anchorDelta }));
  else {
    const anchored = await rows("S2", { ...destinationParams, "signal.interests.entities": seeds.join(",") }, "Rank the same candidate destination set.");
    const baseline = await rows("S2 baseline", { ...destinationParams, "signal.interests.entities": seeds[0] }, "Measure headliner-only destination ranks.");
    const rank = (values: QlooRow[]) => [...new Map(values.filter((r) => cities.some((c) => c.id === r.entity_id.toLowerCase()) && r.query?.affinity != null).map((r) => [r.entity_id.toLowerCase(), r])).values()].sort((a, b) => b.query!.affinity! - a.query!.affinity!);
    ranked = rank(anchored.values).map((r, i) => { const base = rank(baseline.values).findIndex((b) => b.entity_id === r.entity_id); return { city: cities.find((c) => c.id === r.entity_id.toLowerCase())!, rank: i + 1, affinity: r.query?.affinity ?? null, why: contributions(r, seeds), evidence: [anchored.evidence, baseline.evidence], delta: base < 0 ? null : base - i }; });
  }
  if (ranked.length < input.stopCount) throw new QlooError("Not enough ranked destinations for this stop count.", 422);
  // A replacement preserves all user-selected stops; ranking still uses the entire changed set.
  if (requiredStopIds && (requiredStopIds.length !== input.stopCount || new Set(requiredStopIds).size !== requiredStopIds.length)) throw new QlooError("Explicit stop choices must be distinct and match the requested stop count.", 400);
  const preferred = requiredStopIds ?? (previous && sameAudience && !sameCities && input.candidateCityIds.length ? input.candidateCityIds.filter((id) => previous.stops.some((s) => s.id === id) || !previous.candidateCities.some((c) => c.id === id)) : []);
  const chosen = preferred.length === input.stopCount ? ranked.filter((r) => preferred.includes(r.city.id)) : ranked.slice(0, input.stopCount);
  if (chosen.length !== input.stopCount) throw new QlooError("Qloo did not rank every required replacement stop; no partial itinerary was published.", 422);
  const stops: Stop[] = [];
  for (const destination of chosen) {
    const city = destination.city, id = city.id, old = previous?.stops.find((s) => s.id === id);
    const neighborhood = input.neighborhoods.find((n) => n.cityId === id)?.geohash ?? null;
    const reusable = sameAudience && old && old.selectedNeighborhood === neighborhood && input.capacity === previous.input.capacity;
    const destinationScore = sameAudience && sameCities && old ? old.destinationScore : rankScore(destination.rank, ranked.length);
    if (reusable) {
      stops.push({ ...old, destinationRank: destination.rank, destinationScore, affinity: destination.affinity, cityFit: cityFit(destinationScore, old.sceneFit), anchorDelta: destination.delta, explainability: destination.why,
        cells: old.cells.map((c) => ({ ...c, score: neighborhoodScore(c.affinityRank, c.popularity, input.nicheWeight) })).sort((a, b) => b.score - a.score),
        evidence: sameCities ? old.evidence : [...old.evidence.filter((e) => e.params["filter.type"] !== "urn:entity:destination"), ...destination.evidence], supportGroups: [] }); continue;
    }
    const cityLocation = { "filter.location": `POINT(${city.lon} ${city.lat})`, "filter.location.radius": "30000" }, warnings: string[] = [], evidence = [city.evidence, ...destination.evidence];
    let cells: Cell[] = [], fallback = false;
    if (sameAudience && old) {
      cells = old.cells.map((c) => ({ ...c, score: neighborhoodScore(c.affinityRank, c.popularity, input.nicheWeight) })).sort((a, b) => b.score - a.score);
      evidence.push(...old.evidence.filter((e) => e.params["filter.type"] === "urn:heatmap" || e.params.page !== undefined));
      warnings.push(...old.warnings.filter((warning) => warning.startsWith("Heatmap access denied")));
    }
    else try {
      const heatmap = await call("S3", "/v2/insights", { "filter.type": "urn:heatmap", ...cityLocation, "signal.interests.entities": seeds.join(",") }, (r) => {
        if (!r.body.results || Array.isArray(r.body.results)) throw new QlooError("Unexpected heatmap response.");
        return z.array(cellRowSchema).parse(r.body.results.heatmap ?? []);
      }, `Discover neighborhoods in ${city.name}.`);
      evidence.push(heatmap.evidence);
      cells = heatmap.values.map((r): Cell => ({ geohash: r.location.geohash, affinityRank: r.query.affinity_rank, popularity: r.query.popularity, score: neighborhoodScore(r.query.affinity_rank, r.query.popularity, input.nicheWeight), ...decodeGeohash(r.location.geohash), contributions: Object.fromEntries(Object.entries(r.query).filter(([key, value]) => /^entity_.*_affinity_rank$/.test(key) && typeof value === "number").map(([key, value]) => [key, Number(value)])) })).filter((c) => withinMarket(c, city)).sort((a, b) => b.score - a.score).slice(0, 24);
    } catch (error) {
      signal?.throwIfAborted(); if (!(error instanceof QlooError && error.status === 403)) throw error;
      fallback = true; if (error.evidence) evidence.push(error.evidence);
      warnings.push("Heatmap access denied; neighborhoods use observed place-coordinate aggregation, not heatmap values.");
    }
    if (fallback) {
      const raw: Place[] = [];
      for (let page = 1; page <= 3; page++) {
        const result = await rows("S3 place aggregation", { "filter.type": "urn:entity:place", ...cityLocation, "signal.interests.entities": seeds.join(","), take: "50", page: String(page) }, "Aggregate real in-market place coordinates into geohash neighborhoods.");
        evidence.push(result.evidence); raw.push(...result.values.map((r) => toPlace(r, result.evidence, seeds)).filter((p) => withinMarket(p, city)));
        if (result.values.length < 50) break;
      }
      cells = aggregateNeighborhoods(raw, input.nicheWeight);
    }
    const point = neighborhood ? cells.find((c) => c.geohash === neighborhood) : cells[0];
    if (neighborhood && (!point || !withinMarket(point, city))) throw new QlooError("Select a verified in-market neighborhood cell.", 400);
    const venueTags = input.tourType === "music" ? input.capacity < 500 ? ["live_music_venue", "night_club"] : ["concert_hall", "performing_arts_theater"] : input.tourType === "standup" && input.capacity < 500 ? ["comedy_club"] : input.capacity < 500 ? ["performing_arts_theater", "comedy_club"] : ["performing_arts_theater", "auditorium"];
    async function discover(kind: string, tags: string[]): Promise<Place[]> {
      const locations = point ? [ { "filter.location": `POINT(${point.lon} ${point.lat})`, "filter.location.radius": "3000" }, { "filter.location": `POINT(${point.lon} ${point.lat})`, "filter.location.radius": "6000" }, cityLocation ] : [cityLocation];
      for (const location of locations) {
        const result = await rows("S4", { "filter.type": "urn:entity:place", "signal.interests.entities": seeds.join(","), "filter.tags": tags.map((t) => `urn:tag:genre:place:${t}`).join(","), "operator.filter.tags": "union", "feature.explainability": "true", take: "20", ...location }, `Find ${kind} within ${city.name}'s fixed market boundary.`);
        evidence.push(result.evidence);
        const inMarket = result.values.map((r) => toPlace(r, result.evidence, seeds)).filter((p) => withinMarket(p, city));
        const places = [...new Map(inMarket.filter((p) => !isAdultEntertainment(p.tags)).map((p) => [p.id, p])).values()];
        if (inMarket.length > places.length) warnings.push(`Qloo returned adult-entertainment ${kind} in ${city.name}; they are not offered as candidates.`);
        if (places.length) return places;
      }
      warnings.push(`No ${kind} in the verified 30 km boundary.`); return [];
    }
    const rawVenues = await discover("venues", venueTags), rawPartners = await discover("partners", ["record_store", "book_store", "restaurant:bar"]);
    const sceneFit = meanAffinity([...new Map([...rawVenues, ...rawPartners].map((p) => [p.id, p])).values()].map((p) => p.affinity));
    const venues = rawVenues.slice(0, 3), partners = rawPartners.slice(0, 6), retainedPlaceIds = [...new Set([...venues, ...partners].map((p) => p.id))];
    stops.push({ id, name: city.name, lat: city.lat, lon: city.lon, destinationRank: destination.rank, destinationScore, affinity: destination.affinity, sceneFit, cityFit: cityFit(destinationScore, sceneFit), anchorDelta: destination.delta, explainability: destination.why, cells, venues, partners, evidence, warnings,
      selectedNeighborhood: neighborhood, selectedVenueId: sameAudience && old && venues.some((v) => v.id === old.selectedVenueId) ? old.selectedVenueId : null,
      selectedPartnerIds: sameAudience && old ? old.selectedPartnerIds.filter((selected) => partners.some((p) => p.id === selected)) : [],
      supportGroups: [], selectedSupportIds: sameAudience && old ? old.selectedSupportIds : [], retainedPlaceIds,
      confirmations: old ? old.confirmations.filter((confirmation) => retainedPlaceIds.includes(confirmation.entityId) || old.venueDecisions.some((decision) => decision.entityId === confirmation.entityId)) : [],
      venueDecisions: old ? old.venueDecisions.map((decision) => ({ ...decision, needsReview: decision.needsReview || !sameAudience || input.capacity !== previous!.input.capacity })) : [] });
  }
  // Research for a market that returns to the same plan is merged back without
  // restoring its old selections; exclusions remain effective until reviewed.
  const archivedResearch = planMarketResearch(previous, stops);
  const sponsors = await recommend(input, headliner, stops, rows, sameAudience ? previous : undefined, signal);
  const selectedSponsorId = sameAudience && sponsors.some((s) => s.entity.id === previous.selectedSponsorId) ? previous.selectedSponsorId : null;
  const schedule = scheduleTour(stops, input, sponsors, selectedSponsorId);
  if (previous) {
    const dates = new Map(schedule.rows.filter((r) => r.kind === "show").map((r) => [r.cityId, r.date]));
    const oldDates = new Map(previous.schedule.rows.filter((r) => r.kind === "show").map((r) => [r.cityId, r.date]));
    for (const stop of stops) if (dates.get(stop.id) !== oldDates.get(stop.id)) {
      stop.confirmations = stop.confirmations.map((c) => ({ ...c, needsReconfirmation: c.needsReconfirmation || c.forDate !== null || c.field === "availability" }));
      stop.venueDecisions = stop.venueDecisions.map((decision) => ({ ...decision, needsReview: true }));
    }
  }
  // Sponsor purpose checks are user research: kept even when a brand is no
  // longer returned, where they are shown as outside the current candidates.
  const plan = planSchema.parse({ id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, generatedAt: new Date().toISOString(), input, headliner, anchors: validAnchors, seedEvidence: seedResolution.evidence, candidateCities: cities, stops, archivedResearch, sponsors, selectedSponsorId, sponsorChecks: previous?.sponsorChecks ?? [], brief: null, schedule, trace, warnings: ["Qloo affinity and exploratory weighted scores are not ticket demand, compatibility percentages, or sales forecasts.", "Drive distances are estimates, not live road routing.", "Candidate selection is not a booking. Capacity, operating status, availability and fees require sourced confirmation.", "Scene Fit uses unique raw returned in-market places; support and sponsor comparisons use the bounded retained set."] });
  plan.warnings.push(performanceStatusLimit);
  if (!headliner.wikidataId) plan.warnings.push("The headliner has no Qloo-linked Wikidata record; current activity must be checked independently.");
  signal?.throwIfAborted(); emit({ type: "result", plan }); return plan;
}
