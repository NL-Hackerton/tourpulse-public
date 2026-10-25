import type { TourPlan } from "./contracts";
/** Synthetic values for isolated domain tests; never used by product execution. */
export function syntheticPlan(): TourPlan {
  const artist = "00000000-0000-4000-8000-000000000001", city = "00000000-0000-4000-8000-000000000002", venue = "00000000-0000-4000-8000-000000000003";
  const evidence = { endpoint: "/v2/insights", params: {}, fetchedAt: "2026-10-20T00:00:00Z", cached: true };
  return {
    id: "synthetic", revision: 1, generatedAt: evidence.fetchedAt,
    input: { tourType: "music", headlinerId: artist, anchorIds: [], stopCount: 2, startDate: "2026-10-22", endDate: "2026-11-20", startCity: "Philadelphia", maxDriveHours: 5, showDayPreference: "compact", capacity: 300, alreadyPlayed: [], candidateCityIds: [], neighborhoods: [], sponsorIncludeTags: [], sponsorExcludeTags: [], nicheWeight: 0.3, proposalPreferences: { proposalType: "on_site_activation", focusCityId: null, constraints: [] } },
    headliner: { id: artist, name: "Synthetic Artist", type: "urn:entity:artist", popularity: 0.5, tags: [], location: null, description: "" }, anchors: [],
    seedEvidence: [{ ...evidence, endpoint: "/entities", params: { entity_ids: artist } }],
    candidateCities: [{ id: city, name: "Philadelphia", lat: 39.9526, lon: -75.1652, evidence }],
    stops: [{ id: city, name: "Philadelphia", lat: 39.9526, lon: -75.1652, destinationRank: 1, destinationScore: 1, affinity: 0.8, sceneFit: 0.8, cityFit: 0.92, anchorDelta: 0, explainability: {}, cells: [],
      venues: [{ id: venue, name: "Synthetic Venue", lat: 39.95, lon: -75.16, affinity: 0.8, address: "Synthetic street", website: "", neighborhood: "", tags: [], explainability: {}, evidence }], partners: [], evidence: [evidence], warnings: [], selectedNeighborhood: null, selectedVenueId: null, selectedPartnerIds: [], supportGroups: [], selectedSupportIds: [], retainedPlaceIds: [venue], confirmations: [], venueDecisions: [] }],
    sponsors: [], selectedSponsorId: null, sponsorChecks: [], brief: null, trace: [], warnings: [], archivedResearch: [],
    schedule: { feasible: true, rows: [], orderedStopIds: [city], totalKm: 0, originalKm: 0, travelDays: 0, extraDays: 0, suggestions: [], warnings: [] },
  };
}
