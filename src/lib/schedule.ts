import { candidateCities, type DayRow, type PlanInput, type Schedule, type Sponsor, type Stop } from "./contracts";

const DAY = 86_400_000;
const ESTIMATE = "Drive estimates use haversine × 1.25 at 90 km/h; not road routing.";
type Point = { lat: number; lon: number };

/** Explicit weekday policy shared by scheduling, previews and user-facing copy. */
export const showDayPolicies: Record<PlanInput["showDayPreference"], string> = {
  compact: "Earliest feasible show days; no optional Thursday–Saturday waits.",
  thu_sat: "Prefer Thursday–Saturday shows; fall back to the earliest feasible days when the window cannot fit.",
};

function distance(a: Point, b: Point): number {
  const radians = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * radians / 2) ** 2
    + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin((b.lon - a.lon) * radians / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

function routeKm(stops: Stop[], departure: Point): number {
  let km = 0;
  let previous = departure;
  for (const stop of stops) { km += distance(previous, stop) * 1.25; previous = stop; }
  return km;
}

function orderStops(stops: Stop[], departure: Point): Stop[] {
  const remaining = [...stops];
  const nearest: Stop[] = [];
  let previous = departure;
  while (remaining.length) {
    let best = 0;
    for (let i = 1; i < remaining.length; i++) {
      if (distance(previous, remaining[i]) < distance(previous, remaining[best])) best = i;
    }
    const [stop] = remaining.splice(best, 1);
    nearest.push(stop);
    previous = stop;
  }
  // Open route: departure stays fixed, with no invented return-to-origin leg.
  let best = routeKm(nearest, departure) < routeKm(stops, departure) ? nearest : [...stops];
  let km = routeKm(best, departure);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
        const nextKm = routeKm(candidate, departure);
        if (nextKm < km - 1e-8) { best = candidate; km = nextKm; improved = true; }
      }
    }
  }
  return best;
}

function dateValue(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
}

function makeRows(stops: Stop[], input: PlanInput, departure: Point, preferWeekdays: boolean): DayRow[] {
  const rows: DayRow[] = [];
  let day = dateValue(input.startDate);
  let previous = departure;
  let streak = 0;
  // Compact skips only the optional Thu–Sat wait; mandatory rest days still apply.
  const relaxWeekdays = input.showDayPreference === "compact" || !preferWeekdays;
  const append = (row: Omit<DayRow, "date">) => {
    rows.push({ ...row, date: new Date(day).toISOString().slice(0, 10) });
    day += DAY;
    streak = row.kind === "show" ? streak + 1 : 0;
  };
  const rest = (city: string, cityId: string | null, reason: string) => append({
    kind: "rest", city, cityId, neighborhood: "", venue: "", driveKm: 0, driveHours: 0, reason, warnings: [], support: [], sponsors: [],
  });
  for (const stop of stops) {
    if (streak >= 5) rest("Rest day (location unconfirmed)", null, "Rest after five consecutive shows; no lodging selected.");
    let remainingKm = distance(previous, stop) * 1.25;
    const dailyKm = input.maxDriveHours * 90;
    while (remainingKm > dailyKm) {
      append({ kind: "travel", cityId: null, city: "Travel day (no stop selected)", neighborhood: "", venue: "",
        driveKm: dailyKm, driveHours: input.maxDriveHours, reason: `In transit to ${stop.name}; overnight stop not selected.`, warnings: [], support: [], sponsors: [] });
      remainingKm -= dailyKm;
    }
    if (!relaxWeekdays && !input.alreadyPlayed.includes(stop.id) && !input.alreadyPlayed.includes(stop.name)) {
      while (![4, 5, 6].includes(new Date(day).getUTCDay())) rest("Non-show day (location unconfirmed)", null, "Non-show day for the Thursday–Saturday preference; no lodging selected.");
    }
    const venue = stop.venues.find((v) => v.id === stop.selectedVenueId);
    const warnings = [...stop.warnings];
    if (!venue) warnings.push(stop.venues.length
      ? "No venue selected for the working route; review the available candidates."
      : "No venue candidates were returned; further venue research is required.");
    else warnings.push("Venue candidate only; availability and capacity are not verified.");
    append({ kind: "show", cityId: stop.id, city: stop.name,
      neighborhood: stop.selectedNeighborhood ?? venue?.neighborhood ?? "", venue: venue?.name ?? "",
      driveKm: remainingKm, driveHours: remainingKm / 90,
      reason: "Selected city; venue and routing require operational confirmation.", warnings,
      support: stop.supportGroups.flatMap((g) => g.candidates.filter((c) => stop.selectedSupportIds.includes(c.entity.id)).map((c) => g.kind === "podcast" ? `Program crossover: ${c.entity.name}` : g.kind === "comedian" ? `${input.tourType === "podcast" ? "Guest comic" : "Opening comic"}: ${c.entity.name}` : c.entity.name)), sponsors: [] });
    previous = stop;
  }
  return rows;
}

export function scheduleTour(stops: Stop[], input: PlanInput, sponsors: Sponsor[] = [], selectedSponsorId: string | null = null): Schedule {
  const departure = candidateCities.find((city) => city.name === input.startCity);
  const start = dateValue(input.startDate), end = dateValue(input.endDate);
  const validCoordinates = stops.every((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lon)
    && Math.abs(stop.lat) <= 90 && Math.abs(stop.lon) <= 180);
  if (!departure || !Number.isFinite(start) || !Number.isFinite(end) || end < start
    || !Number.isFinite(input.maxDriveHours) || input.maxDriveHours <= 0 || !validCoordinates
    || new Set(stops.map((stop) => stop.id)).size !== stops.length) {
    return { feasible: false, rows: [], orderedStopIds: [], totalKm: 0, originalKm: 0, travelDays: 0, extraDays: 0,
      suggestions: ["Provide valid dates, distinct stops, coordinates, departure city, and a positive daily drive limit."], warnings: ["Invalid scheduling inputs."] };
  }
  const ordered = orderStops(stops, departure);
  const originalKm = routeKm(stops, departure), totalKm = routeKm(ordered, departure);
  const availableDays = Math.floor((end - start) / DAY) + 1;
  let rows = makeRows(ordered, input, departure, true);
  const warnings = [ESTIMATE];
  if (rows.length > availableDays) {
    rows = makeRows(ordered, input, departure, false);
    // Only the explicit Thursday–Saturday policy has an optional wait to disclose as relaxed.
    if (input.showDayPreference === "thu_sat") warnings.push("The Thursday–Saturday preference does not fit this window; it is relaxed to the earliest feasible show days.");
  }
  if (rows.length > availableDays) {
    const extraDays = rows.length - availableDays;
    const suggestions = [`Needs ${extraDays} more day${extraDays === 1 ? "" : "s"} beyond ${input.endDate}.`];
    for (const stop of ordered) {
      const reduced = orderStops(stops.filter((candidate) => candidate.id !== stop.id), departure);
      if (makeRows(reduced, input, departure, false).length <= availableDays) suggestions.push(`Drop ${stop.name} (${stop.id}) to fit the current window.`);
    }
    if (suggestions.length === 1) suggestions.push("No single-stop removal fits the current window.");
    return { feasible: false, rows: [], orderedStopIds: ordered.map((stop) => stop.id), totalKm, originalKm,
      travelDays: 0, extraDays, suggestions, warnings: [...warnings, "No valid itinerary: required travel and rest days exceed the end date."] };
  }
  const sponsor = sponsors.find((candidate) => candidate.entity.id === selectedSponsorId);
  if (sponsor) for (const row of rows) if (row.kind === "show") row.sponsors = [sponsor.entity.name];
  const byId = new Map(ordered.map((stop) => [stop.id, stop]));
  const shows = rows.filter((row) => row.kind === "show");
  for (let i = 0; i < shows.length; i++) {
    for (let j = i + 1; j < shows.length; j++) {
      const a = byId.get(shows[i].cityId!), b = byId.get(shows[j].cityId!);
      if (a && b && distance(a, b) <= 97 && (dateValue(shows[j].date) - dateValue(shows[i].date)) / DAY <= 30) {
        const warning = `Radius clause review: ${a.name} and ${b.name} are within 97 km and 30 days; review actual contracts.`;
        warnings.push(warning); shows[i].warnings.push(warning); shows[j].warnings.push(warning);
      }
    }
  }
  if (!stops.length) warnings.push("No selected stops; no shows scheduled.");
  return { feasible: true, rows, orderedStopIds: ordered.map((stop) => stop.id), totalKm, originalKm,
    travelDays: rows.filter((row) => row.kind === "travel").length, extraDays: 0, suggestions: [], warnings };
}
