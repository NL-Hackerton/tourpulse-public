import { z } from "zod";

const entityIdSchema = z.uuid().toLowerCase();
export const agentMessageLimit = 4000;
export const agentMessageSchema = z.string().trim().min(1).max(agentMessageLimit);
const countrySourceSchema = z.enum(["qloo", "fixed_catalog"]).nullable().optional();

export const entityTypes = ["artist", "movie", "tv_show", "brand", "podcast", "book", "person", "place", "destination"] as const;
export const tourTypes = ["music", "standup", "podcast"] as const;
export const tourTypeSchema = z.enum(tourTypes);
export type TourType = z.infer<typeof tourTypeSchema>;
// Canonical preset audiences: the server resolves these names through Qloo; the
// landing page shows the headliner of each.
export const presetSeeds = {
  music: { headliner: ["Japanese Breakfast", "artist"], anchors: [["Past Lives", "movie"], ["A24", "brand"]] },
  standup: { headliner: ["Nate Bargatze", "person"], anchors: [["Ted Lasso", "tv_show"]] },
  podcast: { headliner: ["SmartLess", "podcast"], anchors: [["Only Murders in the Building", "tv_show"]] },
} as const;
export const entitySchema = z.object({
  id: z.string(), name: z.string(), type: z.string(),
  popularity: z.number().finite().nullable(),
  description: z.string().default(""),
  // A missing death record is unknown life status, not proof of availability.
  deathDate: z.string().min(1).max(64).nullable().optional(),
  wikidataId: z.string().regex(/^Q[1-9]\d{0,14}$/).nullable().optional(),
  tags: z.array(z.string()),
  location: z.object({ lat: z.number().finite(), lon: z.number().finite() }).nullable(),
  country: z.string().min(1).max(200).nullable().optional(),
  countrySource: countrySourceSchema,
});
export type Entity = z.infer<typeof entitySchema>;

export const candidateCities = [
  { name: "Philadelphia", lat: 39.9526, lon: -75.1652 },
  { name: "Boston", lat: 42.3601, lon: -71.0589 },
  { name: "Washington", lat: 38.9072, lon: -77.0369 },
  { name: "New York City", lat: 40.7128, lon: -74.0060 },
  { name: "Baltimore", lat: 39.2904, lon: -76.6122 },
  { name: "Pittsburgh", lat: 40.4406, lon: -79.9959 },
  { name: "Providence", lat: 41.8240, lon: -71.4128 },
  { name: "Richmond", lat: 37.5407, lon: -77.4360 },
] as const;

// The proposal purpose is a user planning hypothesis, never evidence of a brand
// service. On-site work targets one current market; other purposes are tour-wide.
export const proposalTypes = ["on_site_activation", "in_kind_support", "tour_grant"] as const;
export const proposalTypeSchema = z.enum(proposalTypes);
export type ProposalType = z.infer<typeof proposalTypeSchema>;
export const proposalConstraints = ["no_onsite_activation", "no_attendee_signups", "no_merch_sales", "no_extra_days"] as const;
export const proposalConstraintSchema = z.enum(proposalConstraints);
export type ProposalConstraint = z.infer<typeof proposalConstraintSchema>;
export const proposalPreferencesSchema = z.object({
  proposalType: proposalTypeSchema,
  focusCityId: entityIdSchema.nullable(),
  constraints: z.array(proposalConstraintSchema).max(proposalConstraints.length),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.constraints).size !== v.constraints.length) ctx.addIssue({ code: "custom", message: "Each proposal constraint can be chosen only once.", path: ["constraints"] });
  if (v.proposalType === "on_site_activation" && v.constraints.includes("no_onsite_activation")) ctx.addIssue({ code: "custom", message: "An on-site activation conflicts with the \"No on-site activation\" constraint. Choose in-kind touring support or a tour-support discussion, or remove that constraint.", path: ["constraints"] });
  if (v.proposalType !== "on_site_activation" && v.focusCityId !== null) ctx.addIssue({ code: "custom", message: "In-kind and tour-support proposals are tour-wide. Clear the target market.", path: ["focusCityId"] });
}).transform((v) => ({ ...v, constraints: proposalConstraints.filter((constraint) => v.constraints.includes(constraint)) }));
export type ProposalPreferences = z.infer<typeof proposalPreferencesSchema>;
/** Explicit producer default for new plans and canonical presets; not a fallback for stored plans. */
export function defaultProposalPreferences(): ProposalPreferences {
  return { proposalType: "on_site_activation", focusCityId: null, constraints: [] };
}

const dateSchema = z.iso.date();
export const planInputSchema = z.object({
  tourType: tourTypeSchema,
  headlinerId: entityIdSchema,
  anchorIds: z.array(entityIdSchema).max(4),
  stopCount: z.number().int().min(2).max(6),
  startDate: dateSchema,
  endDate: dateSchema,
  startCity: z.string().refine((v) => candidateCities.some((c) => c.name === v), "Choose a supported departure city"),
  maxDriveHours: z.number().min(1).max(10),
  showDayPreference: z.enum(["compact", "thu_sat"]),
  capacity: z.number().int().min(50).max(10000),
  alreadyPlayed: z.array(z.string()).max(8).default([]),
  candidateCityIds: z.array(entityIdSchema).max(12),
  neighborhoods: z.array(z.object({ cityId: entityIdSchema, geohash: z.string().regex(/^[0123456789bcdefghjkmnpqrstuvwxyz]{1,12}$/) })).max(6),
  sponsorIncludeTags: z.array(z.string().startsWith("urn:tag:")).max(8),
  sponsorExcludeTags: z.array(z.string().startsWith("urn:tag:")).max(8),
  nicheWeight: z.number().min(0).max(0.6),
  proposalPreferences: proposalPreferencesSchema,
}).superRefine((v, ctx) => {
  const days = (Date.parse(v.endDate) - Date.parse(v.startDate)) / 86400000;
  if (days < 0 || days > 60) ctx.addIssue({ code: "custom", message: "Tour window must be between 1 and 61 days", path: ["endDate"] });
  if (new Set(v.anchorIds).size !== v.anchorIds.length || v.anchorIds.includes(v.headlinerId)) {
    ctx.addIssue({ code: "custom", message: "Choose distinct anchors and headliner", path: ["anchorIds"] });
  }
  if (new Set(v.candidateCityIds).size !== v.candidateCityIds.length) ctx.addIssue({ code: "custom", message: "Choose distinct candidate cities", path: ["candidateCityIds"] });
  if (v.candidateCityIds.length && v.candidateCityIds.length < v.stopCount) ctx.addIssue({ code: "custom", message: "Not enough candidate cities for the selected stops", path: ["candidateCityIds"] });
  if (new Set(v.neighborhoods.map((n) => n.cityId)).size !== v.neighborhoods.length) ctx.addIssue({ code: "custom", message: "Choose one neighborhood per city", path: ["neighborhoods"] });
});
export type PlanInput = z.infer<typeof planInputSchema>;

export const evidenceSchema = z.object({
  provider: z.enum(["qloo", "wikidata"]).optional(),
  endpoint: z.string(), params: z.record(z.string(), z.string()),
  fetchedAt: z.string(), cached: z.boolean(),
});
export type Evidence = z.infer<typeof evidenceSchema>;
export const traceSchema = z.object({
  step: z.string(), message: z.string(), status: z.enum(["ok", "empty", "degraded", "error"]),
  count: z.number(), ms: z.number(), evidence: evidenceSchema.nullable(),
});
export type Trace = z.infer<typeof traceSchema>;
export const placeSchema = z.object({
  id: z.string(), name: z.string(), lat: z.number().nullable(), lon: z.number().nullable(),
  affinity: z.number().nullable(), address: z.string(), neighborhood: z.string(), website: z.string(),
  tags: z.array(z.string()), explainability: z.record(z.string(), z.number()), evidence: evidenceSchema,
});
export type Place = z.infer<typeof placeSchema>;
export const cellSchema = z.object({
  geohash: z.string(), affinityRank: z.number(), popularity: z.number(),
  score: z.number(), lat: z.number(), lon: z.number(),
  contributions: z.record(z.string(), z.number()),
});
export type Cell = z.infer<typeof cellSchema>;

export const fitSchema = z.object({
  score: z.number().finite().nullable(),
  baseScore: z.number().finite(),
  placeAffinity: z.number().finite().nullable(),
  status: z.enum(["comparable", "insufficient_evidence", "sensitive"]),
  observedPlaces: z.number().int().nonnegative(),
  totalPlaces: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});
export type Fit = z.infer<typeof fitSchema>;
export const placeAffinitySchema = z.object({ placeId: z.string(), value: z.number().finite().nullable() });
export const supportCandidateSchema = z.object({
  entity: entitySchema, rank: z.number().int().positive(), fit: fitSchema,
  placeAffinities: z.array(placeAffinitySchema), evidence: z.array(evidenceSchema),
});
export type SupportCandidate = z.infer<typeof supportCandidateSchema>;
export const supportGroupSchema = z.object({
  kind: z.enum(["artist", "comedian", "podcast"]), candidates: z.array(supportCandidateSchema),
  warnings: z.array(z.string()),
});
export type SupportGroup = z.infer<typeof supportGroupSchema>;
export const sponsorSchema = z.object({
  entity: entitySchema, rank: z.number().int().positive(), fit: fitSchema,
  anchorDelta: z.number().int().nullable(), explainability: z.record(z.string(), z.number()),
  activationSpots: z.array(z.object({ stopId: z.string(), placeId: z.string().nullable(), affinity: z.number().finite().nullable() })),
  placeAffinities: z.array(placeAffinitySchema), evidence: z.array(evidenceSchema),
});
export type Sponsor = z.infer<typeof sponsorSchema>;
// A user check must cite a page anyone can open. Loopback, private-network,
// single-label and IP-literal hosts are rejected; the app never fetches the URL.
const localHostSuffix = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa)$/;
export function isPublicSourceUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^[\d.]+$/.test(host) || !host.includes(".")) return false;
  return !localHostSuffix.test(host);
}
export const publicSourceUrlMessage = "Use a public http(s) web address, without credentials, local-network hosts or IP addresses.";
export const confirmationSchema = z.object({
  entityId: z.string(), field: z.enum(["capacity", "operating", "availability", "fee"]),
  value: z.string().min(1).max(400),
  sourceUrl: z.url().refine(isPublicSourceUrl, publicSourceUrlMessage),
  checkedAt: z.iso.datetime(),
  forDate: z.iso.date().nullable(), needsReconfirmation: z.boolean(),
});
export type Confirmation = z.infer<typeof confirmationSchema>;
export const venueDecisionSchema = z.object({
  entityId: entityIdSchema,
  venueName: z.string().min(1).max(500),
  status: z.enum(["shortlist", "hold", "exclude"]),
  reason: z.string().trim().min(3).max(600),
  decidedAt: z.iso.datetime(),
  needsReview: z.boolean(),
});
export type VenueDecision = z.infer<typeof venueDecisionSchema>;
// A user's own judgment of whether a taste-discovered brand is a practical
// counterpart for one saved proposal purpose, backed by a public source the
// user opened. It is user research, never a brand statement or commitment.
export const sponsorCheckStatuses = ["discuss", "not_suitable"] as const;
export const sponsorCheckLimit = 24;
export const sponsorCheckSchema = z.object({
  brandId: entityIdSchema,
  brandName: z.string().trim().min(1).max(200),
  purpose: proposalTypeSchema,
  status: z.enum(sponsorCheckStatuses),
  // A short noun phrase that reads naturally inside a sentence, e.g. "casual shorts and swimwear".
  // The source wording and judgment belong in `reason`.
  offering: z.string().trim().min(3).max(120),
  reason: z.string().trim().min(3).max(400),
  sourceUrl: z.url().refine(isPublicSourceUrl, publicSourceUrlMessage),
  checkedAt: z.iso.datetime(),
}).strict();
export type SponsorCheck = z.infer<typeof sponsorCheckSchema>;
export const sponsorChecksSchema = z.array(sponsorCheckSchema).max(sponsorCheckLimit).superRefine((checks, ctx) => {
  const keys = checks.map((check) => `${check.brandId}|${check.purpose}`);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Keep at most one sponsor purpose check per brand and purpose." });
});
export const stopSchema = z.object({
  id: z.string(), name: z.string(), lat: z.number(), lon: z.number(),
  destinationRank: z.number(), destinationScore: z.number(), affinity: z.number().nullable(),
  sceneFit: z.number().nullable(), cityFit: z.number().nullable(), anchorDelta: z.number().nullable(),
  explainability: z.record(z.string(), z.number()),
  cells: z.array(cellSchema), venues: z.array(placeSchema), partners: z.array(placeSchema),
  evidence: z.array(evidenceSchema), warnings: z.array(z.string()),
  selectedNeighborhood: z.string().nullable(),
  selectedVenueId: z.string().nullable(),
  selectedPartnerIds: z.array(z.string()),
  supportGroups: z.array(supportGroupSchema),
  selectedSupportIds: z.array(z.string()),
  retainedPlaceIds: z.array(z.string()),
  confirmations: z.array(confirmationSchema),
  venueDecisions: z.array(venueDecisionSchema).max(12),
});
export type Stop = z.infer<typeof stopSchema>;
export const archivedMarketResearchSchema = stopSchema.pick({
  id: true, name: true, confirmations: true, venueDecisions: true,
}).extend({ places: z.array(placeSchema.pick({ id: true, name: true })) });
export type ArchivedMarketResearch = z.infer<typeof archivedMarketResearchSchema>;
export const dayRowSchema = z.object({
  kind: z.enum(["show", "travel", "rest"]), date: z.string(), cityId: z.string().nullable(),
  city: z.string(), neighborhood: z.string(), venue: z.string(),
  driveKm: z.number(), driveHours: z.number(), reason: z.string(), warnings: z.array(z.string()),
  support: z.array(z.string()), sponsors: z.array(z.string()),
});
export type DayRow = z.infer<typeof dayRowSchema>;
export const scheduleSchema = z.object({
  feasible: z.boolean(), rows: z.array(dayRowSchema), orderedStopIds: z.array(z.string()),
  totalKm: z.number(), originalKm: z.number(), travelDays: z.number(),
  extraDays: z.number(), suggestions: z.array(z.string()), warnings: z.array(z.string()),
});
export type Schedule = z.infer<typeof scheduleSchema>;

export const citySchema = z.object({ id: z.string(), name: z.string(), lat: z.number().finite(), lon: z.number().finite(), evidence: evidenceSchema, country: z.string().min(1).max(200).nullable().optional(), countrySource: countrySourceSchema });
export type City = z.infer<typeof citySchema>;
export const factSchema = z.object({
  id: z.string(), label: z.string(), value: z.string(),
  kind: z.enum(["qloo", "computed", "user"]), evidence: z.array(evidenceSchema),
});
export type Fact = z.infer<typeof factSchema>;
export const briefSchema = z.object({
  planId: z.string(), revision: z.number().int().positive(), brandId: z.string(),
  createdAt: z.iso.datetime(), model: z.string(),
  title: z.string(), summary: z.string(),
  proposalType: proposalTypeSchema,
  sections: z.array(z.object({ heading: z.string(), text: z.string(), factIds: z.array(z.string()) })),
  emailSubject: z.string(), emailBody: z.string(),
  facts: z.array(factSchema), warnings: z.array(z.string()),
});
export type Brief = z.infer<typeof briefSchema>;
export const planSchema = z.object({
  id: z.string(), generatedAt: z.string(), input: planInputSchema,
  headliner: entitySchema, anchors: z.array(entitySchema),
  seedEvidence: z.array(evidenceSchema).min(1),
  stops: z.array(stopSchema), schedule: scheduleSchema, trace: z.array(traceSchema),
  archivedResearch: z.array(archivedMarketResearchSchema),
  warnings: z.array(z.string()),
  revision: z.number().int().positive(),
  candidateCities: z.array(citySchema),
  sponsors: z.array(sponsorSchema),
  selectedSponsorId: z.string().nullable(),
  // User sponsor purpose checks survive recalculation, including for a brand
  // that is no longer among the current candidates.
  sponsorChecks: sponsorChecksSchema,
  brief: briefSchema.nullable(),
});
export type TourPlan = z.infer<typeof planSchema>;
export const planEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("accepted"), runId: z.string(), revision: z.number().int().positive() }),
  z.object({ type: z.literal("trace"), trace: traceSchema }),
  z.object({ type: z.literal("result"), plan: planSchema }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type PlanEvent = z.infer<typeof planEventSchema>;
export const searchResponseSchema = z.object({ entities: z.array(entitySchema) });

export const presetResponseSchema = z.object({ tourType: tourTypeSchema, headliner: entitySchema, anchors: z.array(entitySchema) });
export const tagSchema = z.object({ id: z.string().startsWith("urn:tag:"), name: z.string(), type: z.string() });
export type Tag = z.infer<typeof tagSchema>;
export const tagResponseSchema = z.object({ tags: z.array(tagSchema) });

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_mode"), tourType: tourTypeSchema, headlinerId: entityIdSchema }),
  z.object({ type: z.literal("set_headliner"), headlinerId: entityIdSchema }),
  z.object({ type: z.literal("set_dates"), startDate: z.iso.date(), endDate: z.iso.date() }),
  z.object({ type: z.literal("set_drive"), maxDriveHours: z.number().min(1).max(10) }),
  z.object({ type: z.literal("set_show_days"), preference: z.enum(["compact", "thu_sat"]) }),
  z.object({ type: z.literal("set_capacity"), capacity: z.number().int().min(50).max(10000) }),
  z.object({ type: z.literal("set_anchors"), ids: z.array(entityIdSchema).max(4) }),
  z.object({ type: z.literal("replace_city"), cityId: entityIdSchema, replacementId: entityIdSchema }),
  z.object({ type: z.literal("select_neighborhood"), cityId: entityIdSchema, geohash: z.string().regex(/^[0123456789bcdefghjkmnpqrstuvwxyz]{1,12}$/) }),
  z.object({ type: z.literal("select_venue"), cityId: entityIdSchema, venueId: entityIdSchema }),
  z.object({ type: z.literal("select_support"), cityId: entityIdSchema, candidateId: entityIdSchema }),
  z.object({ type: z.literal("select_partner"), cityId: entityIdSchema, placeId: entityIdSchema, selected: z.boolean() }),
  z.object({ type: z.literal("select_sponsor"), brandId: entityIdSchema }),
  z.object({ type: z.literal("set_sponsor_tags"), include: z.array(z.string().startsWith("urn:tag:")).max(8), exclude: z.array(z.string().startsWith("urn:tag:")).max(8) }),
  z.object({ type: z.literal("confirm_place"), cityId: entityIdSchema, confirmation: confirmationSchema }),
  z.object({ type: z.literal("review_venue"), cityId: entityIdSchema, decision: venueDecisionSchema }),
  z.object({ type: z.literal("forget_venue_decision"), cityId: entityIdSchema, entityId: entityIdSchema }),
  z.object({ type: z.literal("forget_market_research"), cityId: entityIdSchema }),
  z.object({ type: z.literal("set_proposal_preferences"), preferences: proposalPreferencesSchema }),
  z.object({ type: z.literal("record_sponsor_check"), check: sponsorCheckSchema }),
  z.object({ type: z.literal("forget_sponsor_check"), brandId: entityIdSchema, purpose: proposalTypeSchema }),
]);
export type PlanAction = z.infer<typeof actionSchema>;
const scheduleSummarySchema = z.object({
  feasible: z.boolean(), totalDays: z.number().int().nonnegative(), showDays: z.number().int().nonnegative(),
  travelDays: z.number().int().nonnegative(), nonShowDays: z.number().int().nonnegative(),
  endDate: z.string().nullable(), extraDays: z.number().int().nonnegative(),
});
export const schedulePreviewSchema = z.object({
  before: scheduleSummarySchema, after: scheduleSummarySchema,
  showDates: z.array(z.object({ city: z.string(), before: z.string().nullable(), after: z.string().nullable() })),
  warnings: z.array(z.string()),
});
export type SchedulePreview = z.infer<typeof schedulePreviewSchema>;
export const previewSchema = z.object({
  action: actionSchema.nullable(), summary: z.string(), changedFields: z.array(z.string()),
  invalidates: z.array(z.string()), clarification: z.string().nullable(), expectedRevision: z.number().int().positive(),
  model: z.string(),
  schedulePreview: schedulePreviewSchema.nullable(),
});
export type ActionPreview = z.infer<typeof previewSchema>;
export const runSchema = z.object({
  id: z.string(), revision: z.number().int().positive(),
  status: z.enum(["queued", "running", "complete", "failed", "cancelled", "interrupted"]),
  updatedAt: z.iso.datetime(), plan: planSchema.nullable(), trace: z.array(traceSchema),
  error: z.string().nullable(), previousRunId: z.string().nullable(),
});
export type RunSnapshot = z.infer<typeof runSchema>;
export const runResponseSchema = z.object({ run: runSchema });
