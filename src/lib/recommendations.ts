import type { Entity, Evidence, PlanInput, Sponsor, Stop, SupportCandidate, SupportGroup, TourPlan } from "./contracts";
import { compareFits } from "./comparison";
import { contributions, normalizeEntity, QlooError, type QlooRow } from "./qloo";
import { rankScore } from "./scoring";
import { activationSpot } from "./venue-review";
import { isComedian } from "./entity-policy";
import { performanceStatusLimit, screenPerformers } from "./performance-eligibility";

export type RowsCall = (step: string, params: Record<string, string>, message: string, endpoint?: "/v2/insights" | "/entities") => Promise<{ values: QlooRow[]; evidence: Evidence }>;

export async function recommend(input: PlanInput, headliner: Entity, stops: Stop[], call: RowsCall, previous?: TourPlan, signal?: AbortSignal): Promise<Sponsor[]> {
  const seeds = [input.headlinerId, ...input.anchorIds];
  const allIds = [...new Set(stops.flatMap((s) => s.retainedPlaceIds))];
  if (allIds.length > 54) throw new QlooError("Retained place set exceeds the six-stop limit.", 422);
  async function observe(id: string) {
    if (!allIds.length) return { values: [], evidence: [] };
    const response = await call("Fixed-place comparison", { "filter.type": "urn:entity:place", "signal.interests.entities": id, "filter.results.entities": allIds.join(","), take: String(allIds.length) }, "Measure a candidate against exactly the retained tour places.");
    const seen = new Map(response.values.filter((r) => allIds.includes(r.entity_id.toLowerCase())).map((r) => [r.entity_id.toLowerCase(), r.query?.affinity ?? null]));
    // Keep requested IDs in the observation array; an omitted result is explicitly null.
    return { values: allIds.map((placeId) => ({ placeId, value: seen.get(placeId) ?? null })), evidence: [response.evidence] };
  }
  const onlySponsorChange = previous && input.headlinerId === previous.input.headlinerId && input.tourType === previous.input.tourType && JSON.stringify(input.anchorIds) === JSON.stringify(previous.input.anchorIds) && JSON.stringify(allIds) === JSON.stringify([...new Set(previous.stops.flatMap((s) => s.retainedPlaceIds))]) && stops.every((s) => JSON.stringify(s.retainedPlaceIds) === JSON.stringify(previous.stops.find((old) => old.id === s.id)?.retainedPlaceIds));
  if (onlySponsorChange) {
    for (const stop of stops) {
      const old = previous.stops.find((s) => s.id === stop.id);
      if (old) { stop.supportGroups = old.supportGroups; stop.selectedSupportIds = old.selectedSupportIds; }
    }
  } else {
    const kinds: SupportGroup["kind"][] = input.tourType === "music" ? ["artist"] : input.tourType === "standup" ? ["comedian"] : ["podcast", "comedian"];
    for (const kind of kinds) {
      const params: Record<string, string> = { "filter.type": `urn:entity:${kind === "comedian" ? "person" : kind}`, "signal.interests.entities": headliner.id, "filter.exclude.entities": headliner.id, take: "20" };
      if (kind === "comedian") params["filter.tags"] = "urn:tag:genre:person:comedian";
      if (headliner.popularity !== null && input.tourType !== "podcast") params["filter.popularity.max"] = String(input.tourType === "music" ? Math.max(0, headliner.popularity - 0.01) : headliner.popularity);
      const result = await call("S5", params, `Discover ${kind} support candidates with headliner audience evidence.`);
      const discovered = [...new Map(result.values.map(normalizeEntity).filter((e) => e.id !== headliner.id && e.type === params["filter.type"] && (kind !== "comedian" || isComedian(e))).map((e) => [e.id, e])).values()].slice(0, 20);
      const eligibilityEvidence: Evidence[] = [];
      let detailedEntities: Entity[] = [];
      if (discovered.length) {
        // Every support kind resolves full records before truncation. A thin
        // Insights row is not sufficient for identity or biographical checks.
        const details = await call("S5 eligibility", { entity_ids: discovered.map((e) => e.id).join(",") }, "Resolve support details before biographical checks; unavailable records are withheld.", "/entities");
        eligibilityEvidence.push(details.evidence);
        const byId = new Map(details.values.map(normalizeEntity).map((e) => [e.id, e]));
        detailedEntities = discovered.flatMap((entity) => {
          const detailed = byId.get(entity.id);
          return detailed && detailed.type === params["filter.type"] && (kind !== "comedian" || isComedian(detailed)) ? [detailed] : [];
        });
      }
      const screened = await screenPerformers(detailedEntities, signal);
      const entities = screened.eligible;
      const withheld = discovered.length - entities.length;
      const pre = entities.slice(0, input.tourType === "podcast" ? 3 : 5);
      const observed = await Promise.all(pre.map((e) => observe(e.id)));
      for (const stop of stops) {
        const compared = compareFits(pre.map((e, i) => ({ id: e.id, baseScore: rankScore(i + 1, entities.length), values: observed[i].values.filter((v) => stop.retainedPlaceIds.includes(v.placeId)) })), stop.retainedPlaceIds);
        const candidates: SupportCandidate[] = pre.map((entity, i) => ({ entity, rank: i + 1, fit: compared.get(entity.id)!, placeAffinities: observed[i].values.filter((v) => stop.retainedPlaceIds.includes(v.placeId)), evidence: [result.evidence, ...eligibilityEvidence, ...(screened.evidenceById.get(entity.id) ?? []), ...observed[i].evidence] }));
        if (candidates.every((c) => c.fit.status === "comparable")) candidates.sort((a, b) => b.fit.score! - a.fit.score!);
        stop.supportGroups.push({ kind, candidates: candidates.slice(0, 3), warnings: [...(withheld ? ["Candidates with recorded deaths or unavailable eligible identity records were withheld."] : []), performanceStatusLimit, ...(screened.unlinked ? ["Some candidates have no Qloo-linked Wikidata record; their life status remains unverified."] : []), ...(pre.length < 3 ? ["Fewer than three eligible candidates returned."] : []), ...(headliner.popularity === null ? ["Popularity cap unavailable; booking scale is unverified."] : [])] });
      }
    }
    for (const stop of stops) stop.selectedSupportIds = stop.selectedSupportIds.filter((id) => stop.supportGroups.some((g) => g.candidates.some((c) => c.entity.id === id)));
  }
  const tagsUnchanged = previous && JSON.stringify(input.sponsorIncludeTags) === JSON.stringify(previous.input.sponsorIncludeTags) && JSON.stringify(input.sponsorExcludeTags) === JSON.stringify(previous.input.sponsorExcludeTags);
  if (onlySponsorChange && tagsUnchanged) return previous.sponsors;
  const brandParams: Record<string, string> = { "filter.type": "urn:entity:brand", "signal.interests.entities": seeds.join(","), "feature.explainability": "true", take: "20" };
  if (input.sponsorIncludeTags.length) { brandParams["filter.tags"] = input.sponsorIncludeTags.join(","); brandParams["operator.filter.tags"] = "union"; }
  if (input.sponsorExcludeTags.length) brandParams["filter.exclude.tags"] = input.sponsorExcludeTags.join(",");
  const ranked = await call("S6", brandParams, "Discover brands under the requested tag conditions.");
  const baseline = await call("S6 baseline", { ...brandParams, "signal.interests.entities": headliner.id }, "Compare headliner-only brand ranks for anchor delta.");
  const brands = [...new Map(ranked.values.filter((r) => normalizeEntity(r).type === "urn:entity:brand").map((r) => [r.entity_id.toLowerCase(), r])).values()];
  const pre = brands.slice(0, 3);
  const observations = await Promise.all(pre.map((r) => observe(r.entity_id.toLowerCase())));
  const fits = compareFits(pre.map((r, i) => ({ id: r.entity_id.toLowerCase(), baseScore: rankScore(i + 1, brands.length), values: observations[i].values })), allIds);
  const sponsors: Sponsor[] = pre.map((row, i) => {
    const entity = normalizeEntity(row), baselineIndex = baseline.values.findIndex((r) => r.entity_id.toLowerCase() === entity.id);
    return { entity, rank: i + 1, fit: fits.get(entity.id)!, anchorDelta: baselineIndex < 0 ? null : baselineIndex - i, explainability: contributions(row, seeds),
      activationSpots: stops.map((stop) => activationSpot(stop, observations[i].values)),
      placeAffinities: observations[i].values, evidence: [ranked.evidence, baseline.evidence, ...observations[i].evidence] };
  });
  if (sponsors.every((s) => s.fit.status === "comparable")) sponsors.sort((a, b) => b.fit.score! - a.fit.score!);
  return sponsors;
}
