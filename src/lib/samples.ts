import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defaultProposalPreferences, planInputSchema, presetSeeds, planSchema, presetResponseSchema, runSchema, tourTypeSchema, type PlanEvent, type PlanInput, type RunSnapshot, type TourPlan, type TourType } from "./contracts";
import { readCache, redis, ServiceError } from "./cache";
import { QlooError, searchEntities } from "./qloo";
import { createTour } from "./planner";
import { scheduleTour } from "./schedule";

const presets = presetSeeds;
const sampleSchema = z.object({ provenance: z.literal("operator-warmed-canonical-preset"), mode: tourTypeSchema, savedAt: z.iso.datetime(), run: runSchema });
export async function resolvePreset(mode: TourType, signal?: AbortSignal) {
  const preset = presets[mode];
  async function resolve(name: string, type: string) {
    const result = await searchEntities(name, type, signal);
    const entity = result.entities.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase() && candidate.type === `urn:entity:${type}`);
    if (!entity) throw new QlooError("The preset could not resolve its verified entities. Use entity search instead.", 422);
    return entity;
  }
  const headliner = await resolve(preset.headliner[0], preset.headliner[1]);
  const anchors = [];
  for (const anchor of preset.anchors) anchors.push(await resolve(anchor[0], anchor[1]));
  return presetResponseSchema.parse({ tourType: mode, headliner, anchors });
}
export async function canonicalSampleInput(mode: TourType, startDate: string, signal?: AbortSignal): Promise<PlanInput> {
  const date = z.iso.date().parse(startDate);
  const preset = await resolvePreset(mode, signal);
  return planInputSchema.parse({ tourType: mode, headlinerId: preset.headliner.id, anchorIds: preset.anchors.map((anchor) => anchor.id), stopCount: 4, startDate: date, endDate: new Date(Date.parse(date) + 13 * 86400000).toISOString().slice(0, 10), startCity: "Boston", maxDriveHours: 4, showDayPreference: "compact", capacity: 500, alreadyPlayed: [], candidateCityIds: [], neighborhoods: [], sponsorIncludeTags: [], sponsorExcludeTags: [], nicheWeight: 0.3, proposalPreferences: defaultProposalPreferences() });
}
/** A shared sample carries no user research: no brief, notes, judgments or sponsor purpose checks. */
export function sampleCarriesUserMaterial(plan: TourPlan): boolean {
  return Boolean(plan.brief) || plan.archivedResearch.length > 0 || plan.sponsorChecks.length > 0 || plan.stops.some((stop) => stop.confirmations.length > 0 || stop.venueDecisions.length > 0);
}
export async function saveSample(rawPlan: TourPlan, signal?: AbortSignal): Promise<RunSnapshot> {
  // Operator-only helper. No public mutation route calls this function or promotes a guest run.
  const plan = planSchema.parse(rawPlan);
  const rejected = new ServiceError("Only an unmodified canonical preset plan may become a shared sample.", 400);
  if (plan.revision !== 1 || sampleCarriesUserMaterial(plan)) throw rejected;
  const canonical = await canonicalSampleInput(plan.input.tourType, plan.input.startDate, signal);
  if (JSON.stringify(plan.input) !== JSON.stringify(canonical) || plan.headliner.id !== canonical.headlinerId || plan.anchors.map((anchor) => anchor.id).join(",") !== canonical.anchorIds.join(",")) throw rejected;
  const run = runSchema.parse({ id: randomUUID(), revision: plan.revision, status: "complete", updatedAt: new Date().toISOString(), plan, trace: plan.trace, error: null, previousRunId: null });
  const entry = sampleSchema.parse({ provenance: "operator-warmed-canonical-preset", mode: plan.input.tourType, savedAt: new Date().toISOString(), run });
  await redis(["SET", `tourpulse:v10:sample:${entry.mode}`, JSON.stringify(entry), "EX", 604800], signal);
  return run;
}
export async function readSample(mode: TourType, signal?: AbortSignal): Promise<RunSnapshot | null> {
  const parsed = sampleSchema.safeParse(await readCache(`tourpulse:v10:sample:${mode}`, signal));
  if (!parsed.success) return null;
  const { run } = parsed.data;
  // Shared samples carry exactly the producer default: no saved purpose, target or constraint.
  const preferences = run.plan?.input.proposalPreferences, expected = defaultProposalPreferences();
  if (parsed.data.mode !== mode || Date.now() - Date.parse(parsed.data.savedAt) < 0 || Date.now() - Date.parse(parsed.data.savedAt) > 604800000 || run.status !== "complete" || !run.plan || run.plan.input.tourType !== mode || preferences?.proposalType !== expected.proposalType || preferences.focusCityId !== expected.focusCityId || preferences.constraints.length !== expected.constraints.length || run.previousRunId || run.plan.revision !== 1 || sampleCarriesUserMaterial(run.plan)) return null;
  return run;
}

export async function warmCanonicalSample(mode: TourType, startDate: string, emit: (event: PlanEvent) => void, signal?: AbortSignal): Promise<RunSnapshot> {
  const input = await canonicalSampleInput(mode, startDate, signal);
  const plan = await createTour(input, emit, signal);
  for (const stop of plan.stops) {
    stop.selectedVenueId = stop.venues[0]?.id ?? null;
    stop.selectedSupportIds = stop.supportGroups.flatMap((group) => group.candidates[0] ? [group.candidates[0].entity.id] : []);
  }
  plan.selectedSponsorId = plan.sponsors[0]?.entity.id ?? null;
  plan.schedule = scheduleTour(plan.stops, plan.input, plan.sponsors, plan.selectedSponsorId);
  plan.warnings.push("Sample choices use the first returned candidates for illustration; review and replace them before outreach.");
  return saveSample(plan, signal);
}
