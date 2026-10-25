import assert from "node:assert/strict";
import test from "node:test";
import { scheduleTour } from "./schedule";
import { scheduleSchema, type PlanInput, type Stop } from "./contracts";

function stop(id: string, lat = 39.9526, lon = -75.1652): Stop {
  return { id, name: id, lat, lon, destinationRank: 1, destinationScore: 1,
    affinity: null, sceneFit: null, cityFit: 1, anchorDelta: null,
    explainability: {}, cells: [], venues: [], partners: [], evidence: [], warnings: [],
    selectedNeighborhood: null, selectedVenueId: null, selectedPartnerIds: [], supportGroups: [], selectedSupportIds: [], retainedPlaceIds: [], confirmations: [], venueDecisions: [] };
}
function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return { tourType: "music", candidateCityIds: [], neighborhoods: [], sponsorIncludeTags: [], sponsorExcludeTags: [], nicheWeight: 0.3,
    headlinerId: "00000000-0000-4000-8000-000000000001", anchorIds: [], stopCount: 2,
    startDate: "2026-10-19", endDate: "2026-11-30", startCity: "Philadelphia", maxDriveHours: 5, showDayPreference: "compact",
    capacity: 300, alreadyPlayed: [], proposalPreferences: { proposalType: "on_site_activation", focusCityId: null, constraints: [] }, ...overrides };
}

test("splits long legs without duplicating distance or violating daily cap", () => {
  const stops = [stop("far", 42.3601, -71.0589), stop("near", 40.7128, -74.006)];
  const before = structuredClone(stops);
  const result = scheduleTour(stops, input({ maxDriveHours: 1 }));
  assert.equal(result.feasible, true);
  assert.ok(scheduleSchema.safeParse(result).success);
  assert.ok(result.travelDays > 0);
  assert.ok(result.rows.every((row) => row.driveHours <= 1 && row.driveKm <= 90));
  assert.ok(Math.abs(result.rows.reduce((sum, row) => sum + row.driveKm, 0) - result.totalKm) < 1e-7);
  assert.ok(result.totalKm <= result.originalKm + 1e-7);
  assert.deepEqual(new Set(result.orderedStopIds), new Set(stops.map((item) => item.id)));
  assert.deepEqual(stops, before);
  assert.equal(result.rows.filter((row) => row.kind === "show").length, 2);
});

test("compact policy avoids optional Thursday-Saturday waits that the explicit policy adds", () => {
  const stops = [stop("one"), stop("two")];
  const compact = scheduleTour(stops, input());
  assert.deepEqual(compact.rows.map((row) => row.date), ["2026-10-19", "2026-10-20"]);
  assert.equal(compact.rows.every((row) => row.kind === "show"), true);
  const preferred = scheduleTour(stops, input({ showDayPreference: "thu_sat" }));
  assert.deepEqual(preferred.rows.filter((row) => row.kind === "show").map((row) => row.date), ["2026-10-22", "2026-10-23"]);
  assert.equal(preferred.rows.filter((row) => row.kind === "rest").length, 3);
  assert.ok(preferred.warnings.every((warning) => !warning.includes("relaxed")));
  const fallback = scheduleTour(stops, input({ showDayPreference: "thu_sat", endDate: "2026-10-20" }));
  assert.equal(fallback.feasible, true);
  assert.deepEqual(fallback.rows.map((row) => row.date), ["2026-10-19", "2026-10-20"]);
  assert.ok(fallback.warnings.some((warning) => warning.includes("relaxed")));
  const compactFits = scheduleTour(stops, input({ endDate: "2026-10-20" }));
  assert.equal(compactFits.feasible, true);
  assert.ok(compactFits.warnings.every((warning) => !warning.includes("relaxed")));
});

test("infeasible plans have no valid-looking rows and only tested drop suggestions", () => {
  const result = scheduleTour([stop("one"), stop("two")], input({ endDate: "2026-10-19" }));
  assert.equal(result.feasible, false);
  assert.deepEqual(result.rows, []);
  assert.equal(result.extraDays, 1);
  assert.ok(result.suggestions.some((suggestion) => suggestion.includes("Drop one")));
  assert.equal(scheduleTour([stop("two")], input({ endDate: "2026-10-19" })).feasible, true);
  const distant = scheduleTour([stop("far1", 0, 0), stop("far2", 0, 1)], input({ endDate: "2026-10-19", maxDriveHours: 1 }));
  assert.equal(distant.feasible, false);
  assert.ok(!distant.suggestions.some((suggestion) => suggestion.startsWith("Drop ")));
});

test("six consecutive shows need a rest day; missing venues do not remove stops", () => {
  const stops = Array.from({ length: 6 }, (_, i) => stop(`city-${i}`));
  const result = scheduleTour(stops, input({ alreadyPlayed: stops.map((item) => item.id) }));
  assert.deepEqual(result.rows.map((row) => row.kind), ["show", "show", "show", "show", "show", "rest", "show"]);
  assert.equal(result.rows[5].date, "2026-10-24");
  assert.ok(result.rows.filter((row) => row.kind === "show").every((row) => row.venue === "" && row.warnings.length > 0));
  assert.ok(result.warnings.some((warning) => warning.includes("Radius clause")));
  const short = scheduleTour(stops, input({ alreadyPlayed: stops.map((item) => item.id), endDate: "2026-10-24" }));
  assert.equal(short.feasible, false);
  assert.equal(short.extraDays, 1);
});

test("travel cannot replace the mandatory rest after five shows; empty input is explicit", () => {
  const stops = Array.from({ length: 6 }, (_, i) => stop(`city-${i}`, i === 5 ? 42.3601 : 39.9526, i === 5 ? -71.0589 : -75.1652));
  const result = scheduleTour(stops, input({ maxDriveHours: 1, alreadyPlayed: stops.map((item) => item.id) }));
  assert.ok(result.rows.some((row) => row.kind === "travel"));
  assert.equal(result.rows[5].kind, "rest");
  assert.equal(result.rows[5].driveHours, 0);
  assert.equal(result.rows[6].kind, "travel");
  const empty = scheduleTour([], input());
  assert.equal(empty.feasible, true);
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.totalKm, 0);
  assert.ok(empty.warnings.some((warning) => warning.includes("No selected stops")));
});

test("invalid dates and non-finite coordinates cannot produce an itinerary", () => {
  assert.equal(scheduleTour([stop("x")], input({ startDate: "2026-02-30" })).feasible, false);
  assert.equal(scheduleTour([stop("x", NaN)], input()).feasible, false);
});
