import assert from "node:assert/strict";
import test from "node:test";
import { previewScheduleChange } from "./schedule-preview";
import { syntheticPlan } from "./domain-fixture";

const farCityId = "00000000-0000-4000-8000-000000000004";
function twoStopPlan() {
  const plan = syntheticPlan();
  plan.stops.push({ ...structuredClone(plan.stops[0]), id: farCityId, name: "Synthetic Far City", lat: 42.3601, lon: -71.0589 });
  plan.input.stopCount = 2;
  return plan;
}

test("a weekday-policy preview shows the concrete dates and non-show days a change would add", () => {
  const plan = syntheticPlan();
  plan.input.startDate = "2026-10-19";
  plan.input.endDate = "2026-11-30";
  const before = JSON.stringify(plan);
  const preview = previewScheduleChange(plan, { type: "set_show_days", preference: "thu_sat" });
  assert.ok(preview);
  assert.equal(JSON.stringify(plan), before, "preview must not mutate the plan");
  assert.deepEqual([preview.before.showDays, preview.before.nonShowDays, preview.before.totalDays], [1, 0, 1]);
  assert.deepEqual([preview.after.showDays, preview.after.nonShowDays, preview.after.totalDays], [1, 3, 4]);
  assert.deepEqual(preview.showDates, [{ city: "Philadelphia", before: "2026-10-19", after: "2026-10-22" }]);
});

test("compact removes optional waits, thu_sat falls back in a short window, and an impossible window reports extra days", () => {
  const preferred = twoStopPlan();
  preferred.input.startDate = "2026-10-19";
  preferred.input.endDate = "2026-11-30";
  preferred.input.showDayPreference = "thu_sat";
  const compact = previewScheduleChange(preferred, { type: "set_show_days", preference: "compact" });
  assert.ok(compact);
  assert.deepEqual(compact.showDates.map((entry) => entry.before), ["2026-10-22", "2026-10-24"]);
  assert.deepEqual(compact.showDates.map((entry) => entry.after), ["2026-10-19", "2026-10-21"]);
  assert.deepEqual([compact.before.nonShowDays, compact.after.nonShowDays], [3, 0]);

  const fallback = previewScheduleChange(preferred, { type: "set_dates", startDate: "2026-10-19", endDate: "2026-10-22" });
  assert.ok(fallback);
  assert.equal(fallback.after.feasible, true);

  const impossible = previewScheduleChange(preferred, { type: "set_dates", startDate: "2026-10-19", endDate: "2026-10-19" });
  assert.ok(impossible);
  assert.equal(impossible.after.feasible, false);
  assert.equal(impossible.after.showDays, 0);
  assert.equal(impossible.after.extraDays, 2);
  assert.equal(impossible.before.feasible, true);
});

test("a tighter drive limit previews added travel days; provider-only actions and invalid windows get no preview", () => {
  const plan = twoStopPlan();
  const drive = previewScheduleChange(plan, { type: "set_drive", maxDriveHours: 1 });
  assert.ok(drive);
  assert.equal(drive.before.travelDays, 1);
  assert.equal(drive.after.travelDays, 6);
  assert.equal(previewScheduleChange(plan, { type: "set_capacity", capacity: 500 }), null);
  assert.equal(previewScheduleChange(plan, { type: "set_dates", startDate: "2026-11-20", endDate: "2026-10-19" }), null);
});
