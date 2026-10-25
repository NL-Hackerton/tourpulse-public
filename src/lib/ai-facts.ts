import { z } from "zod";
import type { Evidence, Fact, Sponsor, TourPlan } from "./contracts";
import { AgentError } from "./ai-policy";
import { proposalConstraintLabels, proposalTypeCopy } from "./proposal-preferences";
import { sponsorDraftGate, sponsorOfferingCheckedLabel, sponsorOfferingLabel, sponsorOfferingSourceLabel, unreviewedSponsorWarning } from "./sponsor-check";

export const proposalFragmentFields = ["title", "summary", "activationIdea", "supportRequested", "prospectiveValue", "nextStep", "emailSubject", "emailBody"] as const;
export type ProposalFragmentField = (typeof proposalFragmentFields)[number];

// Approval cannot carry unresolved issues; revision must identify an actual problem.
export const proposalReviewSchema = z.object({
  result: z.discriminatedUnion("decision", [
    z.object({ decision: z.literal("approve") }).strict(),
    z.object({
      decision: z.literal("revise"),
      issues: z.array(z.object({
        field: z.enum(proposalFragmentFields),
        kind: z.enum(["factuality", "recipient", "constraint"]),
        message: z.string().trim().min(1).max(300),
      }).strict()).min(1).max(8),
    }).strict(),
  ]),
}).strict();
export type ProposalReview = z.infer<typeof proposalReviewSchema>["result"];

export function parseProposalReview(calls: readonly { toolName: string; input?: unknown }[]): ProposalReview {
  const parsed = calls.length === 1 && calls[0].toolName === "reviewEvidence"
    ? proposalReviewSchema.safeParse(calls[0].input) : null;
  if (!parsed?.success) throw new AgentError("Evidence verification did not return exactly one valid verdict. No draft was approved.", 503);
  return parsed.data.result;
}

const compareTagSchema = z.union([
  z.object({ id: z.string().startsWith("urn:tag:"), name: z.string().min(1).max(200) }),
  z.object({ tag_id: z.string().startsWith("urn:tag:"), name: z.string().min(1).max(200) }).transform((t) => ({ id: t.tag_id, name: t.name })),
]);
export function compareTags(raw: unknown): { id: string; name: string }[] {
  if (!Array.isArray(raw)) throw new AgentError("Qloo audience comparison did not return a tag list.");
  const tags = new Map<string, { id: string; name: string }>();
  for (const item of raw.slice(0, 100)) {
    const parsed = compareTagSchema.safeParse(item);
    if (parsed.success) tags.set(parsed.data.id, parsed.data);
  }
  if (raw.length && !tags.size) throw new AgentError("Qloo audience comparison tags could not be validated.");
  return [...tags.values()].slice(0, 12);
}

export function briefFacts(plan: TourPlan, sponsor: Sponsor, audienceTags: { id: string; name: string }[], brandTags: { id: string; name: string }[], compareEvidence: Evidence): Fact[] {
  const facts: Fact[] = [];
  const add = (id: string, label: string, value: string, kind: Fact["kind"], evidence: Evidence[] = []) => {
    // Biographical checks constrain eligibility; they do not establish the
    // Qloo names, taste signals or operating facts rendered into prose.
    facts.push({ id, label, value, kind, evidence: kind === "qloo" ? evidence.filter((source) => source.provider !== "wikidata") : evidence });
  };
  const seedEvidence = plan.seedEvidence;
  add("headliner_name", "Headliner", plan.headliner.name, "qloo", seedEvidence);
  add("tour_format", "Tour format", plan.input.tourType, "user");
  add("sponsor_name", "Candidate sponsor, not confirmed", sponsor.entity.name, "qloo", sponsor.evidence);
  add("window_start", "Requested start date", plan.input.startDate, "user");
  add("window_end", "Requested end date", plan.input.endDate, "user");
  // The proposal purpose and constraints are the user's planning choices, kept
  // separate from source-backed facts; they never establish a brand service.
  const preferences = plan.input.proposalPreferences;
  add("proposal_goal", "User-selected proposal purpose; a planning hypothesis, not a confirmed brand service", proposalTypeCopy[preferences.proposalType].label, "user");
  const focusStop = plan.stops.find((stop) => stop.id === preferences.focusCityId);
  add("proposal_scope", "User-selected proposal scope", preferences.proposalType === "on_site_activation" ? focusStop ? `Target market: ${focusStop.name}` : "Target market not set" : "Tour-wide", "user");
  preferences.constraints.forEach((constraint, index) => add(`proposal_constraint_${index + 1}`, "User-set proposal constraint", proposalConstraintLabels[constraint], "user"));
  // The user's sourced judgment that this brand is worth discussing for the
  // saved purpose: what the public source shows it offers, never a commitment.
  const gate = sponsorDraftGate(plan, sponsor.entity.id);
  if (gate.status === "discuss") {
    add("sponsor_offering", sponsorOfferingLabel, gate.check.offering, "user");
    add("sponsor_offering_source", sponsorOfferingSourceLabel, gate.check.sourceUrl, "user");
    add("sponsor_offering_checked_at", sponsorOfferingCheckedLabel, gate.check.checkedAt, "user");
  }
  const showDates = plan.schedule.rows.filter((row) => row.kind === "show").map((row) => row.date).sort();
  if (showDates.length) {
    add("first_show_date", "First tentative show date", showDates[0], "computed");
    add("last_show_date", "Last tentative show date", showDates.at(-1)!, "computed");
  }
  add("target_seats", "Target capacity, not verified venue capacity", String(plan.input.capacity), "user");
  add("stop_count", "Planned stops", String(plan.stops.length), "computed");
  add("route_km", "Estimated routing distance; adjusted haversine, not measured roads", `${Math.round(plan.schedule.totalKm)} km`, "computed");
  add("schedule_feasible", "Schedule feasible under planning assumptions", String(plan.schedule.feasible), "computed");
  plan.anchors.forEach((anchor, index) => add(`anchor_${index + 1}`, "Taste anchor", anchor.name, "qloo", seedEvidence));
  plan.stops.forEach((stop, index) => {
    const prefix = `stop_${index + 1}`;
    add(`${prefix}_city`, "Planned stop", stop.name, "qloo", stop.evidence);
    const date = plan.schedule.rows.find((row) => row.kind === "show" && row.cityId === stop.id)?.date;
    if (date) add(`${prefix}_date`, `Tentative show date: ${stop.name}`, date, "computed");
    const venue = stop.venues.find((candidate) => candidate.id === stop.selectedVenueId);
    if (venue) add(`${prefix}_venue`, `Selected venue candidate, not booked: ${stop.name}`, venue.name, "qloo", [venue.evidence]);
    stop.partners.filter((partner) => stop.selectedPartnerIds.includes(partner.id)).forEach((partner, i) => add(`${prefix}_partner_${i + 1}`, `Selected partner candidate, not contracted: ${stop.name}`, partner.name, "qloo", [partner.evidence]));
    stop.supportGroups.flatMap((group) => group.candidates).filter((candidate) => stop.selectedSupportIds.includes(candidate.entity.id)).forEach((candidate, i) => add(`${prefix}_support_${i + 1}`, `Selected support candidate, not booked: ${stop.name}`, candidate.entity.name, "qloo", candidate.evidence));
    const activation = sponsor.activationSpots.find((spot) => spot.stopId === stop.id);
    const place = [...stop.venues, ...stop.partners].find((candidate) => candidate.id === activation?.placeId);
    if (place && !stop.venueDecisions.some((decision) => decision.entityId === place.id && decision.status === "exclude")) add(`${prefix}_activation`, `Potential activation location, requires permission: ${stop.name}`, place.name, "qloo", sponsor.evidence);
  });
  add("sponsor_evidence_status", "Sponsor route-fit evidence status, not calibrated", sponsor.fit.status, "computed", sponsor.evidence);
  if (sponsor.fit.score !== null && sponsor.fit.status === "comparable") add("sponsor_heuristic", "Exploratory route-fit heuristic, not a compatibility percentage", sponsor.fit.score.toFixed(3), "computed", sponsor.evidence);
  if (sponsor.anchorDelta !== null) add("sponsor_anchor_rank_change", "Rank change with all anchors, not individual attribution", String(sponsor.anchorDelta), "computed", sponsor.evidence);
  audienceTags.forEach((tag, index) => add(`audience_tag_${index + 1}`, "Qloo describes the seed audience with this tag (not demonstrated shared taste)", tag.name, "qloo", [compareEvidence]));
  brandTags.forEach((tag, index) => add(`brand_tag_${index + 1}`, "Qloo describes the brand with this tag (not demonstrated shared taste)", tag.name, "qloo", [compareEvidence]));
  return facts;
}

/** Limits saved with every approved draft for this plan and sponsor. */
export function proposalWarnings(plan: TourPlan, sponsor: Sponsor): string[] {
  const gate = sponsorDraftGate(plan, sponsor.entity.id);
  return ["AI-generated proposal draft; not a sponsorship commitment or booking.",
    "Proposal purpose, scope and constraints are the user's planning choices, not confirmed brand services or interest.",
    ...(gate.status === "discuss" ? ["The brand offering is the user's reading of a public source, not a statement, availability or commitment by the brand."] : [unreviewedSponsorWarning]),
    "Audience descriptions are separate and do not establish shared tastes or compatibility.",
    "Route-fit figures are exploratory heuristics, not attendance predictions.",
    "Capacity is a planning target, not verified venue capacity or expected attendance.",
    "Distances are adjusted haversine estimates, not measured road distances.",
    "Dates, venues, support acts, partners and activation locations are tentative.",
    "Operating status, capacity, availability, fees and permissions require sourced confirmation.",
    ...(sponsor.fit.status !== "comparable" ? ["Sponsor comparison is incomplete or sensitive; no superiority is established."] : [])];
}

// Recipient copy is the sponsor-facing proposal, not an audit view. Internal
// provenance vocabulary, source labels, scoring jargon and price statements
// belong in the evidence appendix, so they are rejected here deterministically
// before the independent verifier sees the draft.
const INTERNAL_COPY = /\b(?:E\d+|f\d+)\b|\{\{|\}\}|\b(?:ledger|endpoint|payload|source register|revision|heuristic|haversine|cached?|cache hit|calibrated|calibration|affinity|fit score|route-fit|compatibility percentage|disclaimer|Qloo)\b/i;
const PRICE_COPY = /[$€£¥]|\b(?:USD|EUR|GBP|dollars?|euros?|budget|pricing|price|prices|fee|fees|payment|payments|cost|costs|monetary|compensation|honorarium)\b/i;

export interface RecipientFragment { text: string; factIds: string[]; where: string }

export function recipientCopyIssues(fragments: RecipientFragment[], facts: Fact[]): string[] {
  const tagFacts = new Set(facts.filter((fact) => fact.label.startsWith("Qloo describes the")).map((fact) => fact.id));
  const issues: string[] = [];
  for (const fragment of fragments) {
    // Placeholder tokens are the citation mechanism, not recipient copy; test
    // only the wording the sponsor will actually read. Rendered source values
    // stay trusted and may contain ordinary punctuation or currency-like names.
    const wording = fragment.text.replace(/\{\{[a-z][a-z0-9_]{0,63}\}\}/g, " ");
    const internal = wording.match(INTERNAL_COPY)?.[0];
    if (internal) issues.push(`${fragment.where}: remove internal audit wording "${internal}". Source labels, scores, ledgers and providers belong only in the evidence appendix.`);
    const price = wording.match(PRICE_COPY)?.[0];
    if (price) issues.push(`${fragment.where}: remove the price reference "${price}". The recipient copy must request a scope of support, never a fee, budget or amount.`);
    const citedTags = fragment.factIds.filter((id) => tagFacts.has(id)).length;
    if (citedTags > 4) issues.push(`${fragment.where}: cites ${citedTags} audience descriptions. Name only the few most relevant audience interests instead of listing the tag set.`);
  }
  return issues;
}

export interface GroundedFragment { text: string; factIds: string[] }

// Derive citations from the exact placeholders instead of asking a model to
// repeat the same references in a second, potentially inconsistent field.
export function groundedFragment(text: string, facts: Fact[]): GroundedFragment {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const references = new Set<string>();
  const withoutTokens = text.replace(/\{\{([a-z][a-z0-9_]{0,63})\}\}/g, (_, id: string) => {
    if (!byId.has(id)) throw new AgentError("Generated text cited an unknown fact.", 422);
    references.add(id);
    return "";
  });
  if (references.size > 30) throw new AgentError("A proposal fragment referenced too many facts.", 422);
  if (/\p{N}|[%％]|\{\{|\}\}/u.test(withoutTokens)) throw new AgentError("Generated text contains a number outside a cited fact placeholder.", 422);
  const numericalWord = withoutTokens.match(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion|percent|percentage)\b/i)?.[0];
  if (numericalWord) throw new AgentError(`Generated text contains the unsupported numerical word "${numericalWord}". Remove it or use a cited fact placeholder, including in disclaimers.`, 422);
  return { text: text.replace(/\{\{([a-z][a-z0-9_]{0,63})\}\}/g, (_, id: string) => byId.get(id)!.value), factIds: [...references] };
}
