import { planInputSchema, schedulePreviewSchema, type PlanAction, type Schedule, type SchedulePreview, type TourPlan } from "./contracts";
import { scheduleTour, showDayPolicies } from "./schedule";

/** Local edits that can be re-scheduled from retained evidence without provider calls. */
function isLocalScheduleAction(action: PlanAction): action is Extract<PlanAction, { type: "set_dates" | "set_drive" | "set_show_days" }> {
  return action.type === "set_dates" || action.type === "set_drive" || action.type === "set_show_days";
}

function summary(schedule: Schedule) {
  const showDays = schedule.rows.filter((row) => row.kind === "show").length;
  const travelDays = schedule.rows.filter((row) => row.kind === "travel").length;
  return {
    feasible: schedule.feasible,
    totalDays: schedule.rows.length,
    showDays,
    travelDays,
    nonShowDays: schedule.rows.length - showDays - travelDays,
    endDate: schedule.rows.at(-1)?.date ?? null,
    extraDays: schedule.extraDays,
  };
}

function showDates(schedule: Schedule): Map<string, string> {
  const dates = new Map<string, string>();
  for (const row of schedule.rows) if (row.kind === "show" && row.cityId) dates.set(row.cityId, row.date);
  return dates;
}

/**
 * Pure comparison of the current schedule with the schedule the same stops would
 * produce under a local date/drive/weekday edit. No provider call, no mutation.
 */
export function previewScheduleChange(plan: TourPlan, action: PlanAction): SchedulePreview | null {
  if (!isLocalScheduleAction(action)) return null;
  const input = { ...plan.input };
  if (action.type === "set_dates") { input.startDate = action.startDate; input.endDate = action.endDate; }
  else if (action.type === "set_drive") input.maxDriveHours = action.maxDriveHours;
  else if (action.type === "set_show_days") input.showDayPreference = action.preference;
  // An edit that breaks the plan contract is reported by the action validator instead of faking a schedule.
  const parsed = planInputSchema.safeParse(input);
  if (!parsed.success) return null;

  const before = scheduleTour(plan.stops, plan.input, plan.sponsors, plan.selectedSponsorId);
  const after = scheduleTour(plan.stops, parsed.data, plan.sponsors, plan.selectedSponsorId);
  const beforeDates = showDates(before), afterDates = showDates(after);
  const cities = new Map(plan.stops.map((stop) => [stop.id, stop.name]));
  const ordered = [...afterDates.keys(), ...[...beforeDates.keys()].filter((id) => !afterDates.has(id))];
  const changes = ordered.map((id) => ({ city: cities.get(id) ?? id, before: beforeDates.get(id) ?? null, after: afterDates.get(id) ?? null }));

  const warnings: string[] = [`Show-day policy: ${showDayPolicies[parsed.data.showDayPreference]}`];
  const moved = changes.filter((entry) => entry.before !== entry.after && entry.before && entry.after).length;
  if (!after.feasible) {
    const extra = after.extraDays;
    warnings.push(`No itinerary fits this window under the new limits: ${extra} more day${extra === 1 ? "" : "s"} would be required beyond ${parsed.data.endDate}.`);
    warnings.push("Current show dates cannot be kept; show, travel and calendar-day counts are unknown until the window, stops or daily drive change.");
  } else {
    if (after.warnings.some((warning) => warning.includes("relaxed")))
      warnings.push("The Thursday–Saturday preference cannot fit this window, so the new schedule falls back to the earliest feasible show days.");
    const optionalWaits = after.rows.filter((row) => row.kind !== "show" && row.reason.includes("Thursday–Saturday preference")).length;
    if (optionalWaits) warnings.push(`${optionalWaits} optional non-show day${optionalWaits === 1 ? "" : "s"} wait${optionalWaits === 1 ? "s" : ""} for Thursday–Saturday; the compact policy omits these waits.`);
    if (after.travelDays > before.travelDays) warnings.push(`The new daily drive limit adds ${after.travelDays - before.travelDays} travel day${after.travelDays - before.travelDays === 1 ? "" : "s"}.`);
    if (moved) warnings.push(`${moved} show date${moved === 1 ? "" : "s"} change relative to the current schedule.`);
  }

  return schedulePreviewSchema.parse({ before: summary(before), after: summary(after), showDates: changes, warnings });
}
