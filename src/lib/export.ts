import type { Brief, Confirmation, Evidence, Fact, SponsorCheck, SupportCandidate, TourPlan, VenueDecision } from "./contracts";
import { checkIsCurrent, missingCheckFields, scheduledShowDate } from "./venue-review";
import { proposalTypeCopy } from "./proposal-preferences";
import { orphanSponsorCheckNote, sponsorCheckBrandName, sponsorCheckLabels, sponsorIsCurrent, unreviewedSponsorWarning } from "./sponsor-check";

const SCOPE = "Exploratory music, stand-up, and live-podcast discovery and estimated routing. Selections and proposals are not bookings; operating status, capacity, availability, fees and permissions require sourced confirmation.";

// One short boundary line for recipient-facing copy. Full limits live in the
// evidence appendix, not in the middle of a sponsor email.
export const RECIPIENT_BOUNDARY = "Draft proposal for discussion only. Dates, venues and activations are tentative, and any support is subject to a separate agreement and confirmation.";

function markdown(value: unknown): string {
  return String(value ?? "—").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\").replace(/([`*_{}\[\]()#!|])/g, "\\$1").replace(/[\r\n]+/g, "<br>");
}

function number(value: number | null): string {
  return value !== null && Number.isFinite(value) ? String(value) : "insufficient evidence";
}

// Escaped like every other exported string, but keeps paragraph breaks so a
// downloaded draft reads as the email or multi-paragraph text it is.
export function multilineMarkdown(value: string): string {
  return String(value ?? "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").split("\n")
    .map((line) => line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\\/g, "\\\\").replace(/([`*_{}\[\]()#!|])/g, "\\$1"))
    .join("  \n");
}

// Deterministic timestamps keep printed and downloaded documents identical
// between server render and browser, unlike locale-dependent formatting.
export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function evidenceProvider(evidence: Evidence): string {
  return evidence.provider === "wikidata" ? "Wikidata" : "Qloo";
}

export function evidenceText(evidence: Evidence): string {
  return `${evidenceProvider(evidence)} | ${evidence.endpoint} | ${JSON.stringify(evidence.params)} | fetched ${evidence.fetchedAt} | ${evidence.cached ? "cached" : "live"}`;
}

export function supportCheckText(candidate: SupportCandidate): string {
  return candidate.entity.wikidataId && candidate.evidence.some((entry) => entry.provider === "wikidata")
    ? `Wikidata ${candidate.entity.wikidataId}: no death record found at the source check. Current activity and availability are unverified.`
    : "Life status unverified: no Qloo-linked Wikidata check. Confirm current activity and availability before outreach.";
}

// Stable E1..En labels shared by the Markdown appendix and the printed evidence
// pages, so a citation label means the same request in both outputs.
export function evidenceRegister(entries: Evidence[]): { label: string; evidence: Evidence }[] {
  const register = new Map<string, { label: string; evidence: Evidence }>();
  for (const evidence of entries) {
    const key = evidenceText(evidence);
    if (!register.has(key)) register.set(key, { label: `E${register.size + 1}`, evidence });
  }
  return [...register.values()];
}

// Effective state of one user-sourced check against the route's show date. The
// current/not-current verdict is venue-review's, so the dossier and every
// export agree; the reason only explains which rule applied.
export type UserCheckStatus = "current" | "reconfirm" | "not_current";
export function userCheckState(note: Confirmation, showDate: string | null): { status: UserCheckStatus; reason: string } {
  if (checkIsCurrent(note, showDate)) return { status: "current", reason: note.forDate ? `applies to the ${note.forDate} show` : "no date restriction" };
  if (note.needsReconfirmation) return { status: "reconfirm", reason: "marked for reconfirmation after the plan or the check changed" };
  if (note.forDate && note.forDate !== showDate) return { status: "not_current", reason: `applies ${note.forDate}; ${showDate ? `the show is ${showDate}` : "this route has no show date for this market"}` };
  return { status: "not_current", reason: "an availability check must name the show date it applies to" };
}

export interface UserCheck { id: string; marketId: string; marketName: string; historical: boolean; placeName: string; note: Confirmation; showDate: string | null; status: UserCheckStatus; reason: string }
export interface VenueResearch { entityId: string; name: string; decision: VenueDecision | null; selected: boolean; archived: boolean; checks: UserCheck[]; missing: Confirmation["field"][] }
export interface MarketResearch { id: string; name: string; historical: boolean; live: boolean; showDate: string | null; venues: VenueResearch[] }

// Every user judgment and user-sourced check, grouped by market and venue, with
// stable U1..Un IDs in that printed order: current stops first, then historical
// records. A current stop's selected venue is listed even without any record so
// its missing checks stay explicit. Each confirmation appears exactly once.
export function venueResearch(plan: TourPlan): { markets: MarketResearch[]; checks: UserCheck[] } {
  const liveIds = new Set(plan.stops.map((stop) => stop.id));
  const records: { id: string; name: string; historical: boolean; confirmations: Confirmation[]; venueDecisions: VenueDecision[]; places: { id: string; name: string }[]; selectedVenueId: string | null }[] = [
    ...plan.stops.map((stop) => ({ id: stop.id, name: stop.name, historical: false, confirmations: stop.confirmations, venueDecisions: stop.venueDecisions,
      places: [...stop.venues, ...stop.partners], selectedVenueId: stop.venues.some((venue) => venue.id === stop.selectedVenueId) ? stop.selectedVenueId : null })),
    ...plan.archivedResearch.map((market) => ({ id: market.id, name: market.name, historical: true, confirmations: market.confirmations, venueDecisions: market.venueDecisions,
      places: market.places, selectedVenueId: null })),
  ];
  const checks: UserCheck[] = [];
  const markets = records.map((record): MarketResearch => {
    const live = liveIds.has(record.id);
    const showDate = live ? scheduledShowDate(plan, record.id) : null;
    const entityIds = [...new Set([...(record.selectedVenueId ? [record.selectedVenueId] : []), ...record.venueDecisions.map((decision) => decision.entityId), ...record.confirmations.map((note) => note.entityId)])];
    const venues = entityIds.map((entityId): VenueResearch => {
      const decision = record.venueDecisions.find((item) => item.entityId === entityId) ?? null;
      const place = record.places.find((item) => item.id === entityId);
      const name = place?.name ?? decision?.venueName ?? entityId;
      const venueChecks = record.confirmations.filter((note) => note.entityId === entityId).map((note): UserCheck => {
        const state = !live && !note.needsReconfirmation
          ? { status: "not_current" as const, reason: "this market is not in the current route" }
          : userCheckState(note, showDate);
        const check = { id: `U${checks.length + 1}`, marketId: record.id, marketName: record.name, historical: record.historical, placeName: name, note, showDate, ...state };
        checks.push(check);
        return check;
      });
      return { entityId, name, decision, selected: entityId === record.selectedVenueId, archived: !record.historical && !place, checks: venueChecks,
        missing: missingCheckFields(venueChecks.filter((check) => check.status === "current").map((check) => check.note)) };
    });
    return { id: record.id, name: record.name, historical: record.historical, live, showDate, venues };
  });
  return { markets, checks };
}

// Every user sponsor purpose check with display names. A brand that is no
// longer returned keeps its record and is marked outside the current candidates.
export const SPONSOR_CHECK_SCOPE = "Each check is the user's own judgment of whether a brand is worth discussing for a proposal purpose, with the public source the user cited. It is not a brand statement, availability, willingness or commitment, and TourPulse never fetched or verified the source.";
export interface SponsorCheckRecord { check: SponsorCheck; brandName: string; current: boolean; savedPurpose: boolean; status: string; purpose: string }
export function sponsorCheckRecords(plan: TourPlan, checks: readonly SponsorCheck[] = plan.sponsorChecks): SponsorCheckRecord[] {
  return checks.map((check) => ({ check, brandName: sponsorCheckBrandName(plan, check.brandId), current: sponsorIsCurrent(plan, check.brandId),
    savedPurpose: check.purpose === plan.input.proposalPreferences.proposalType, status: sponsorCheckLabels[check.status], purpose: proposalTypeCopy[check.purpose].label }));
}
function sponsorCheckMarkdown({ check, brandName, current, savedPurpose, status, purpose }: SponsorCheckRecord): string {
  return `${markdown(brandName)} (${markdown(check.brandId)}) · ${markdown(purpose)}${savedPurpose ? " (saved purpose)" : ""}: **${markdown(status.toUpperCase())}**${current ? "" : ` — ${markdown(orphanSponsorCheckNote.toUpperCase())}`}; offering: ${markdown(check.offering)}; reason: ${markdown(check.reason)}; source ${markdown(check.sourceUrl)}; checked ${markdown(check.checkedAt)}; user-sourced, not independently verified.`;
}
/** The user's check behind a draft: the brief's own brand and saved purpose. */
export function briefSponsorCheck(brief: Brief, plan: TourPlan): SponsorCheckRecord | null {
  const check = plan.sponsorChecks.find((item) => item.brandId === brief.brandId && item.purpose === brief.proposalType);
  return check ? sponsorCheckRecords(plan, [check])[0] : null;
}
/** Public pages the user cited for drafted facts; listed with, not as, fetched requests. */
export function briefUserSources(brief: Brief): Fact[] {
  return brief.facts.filter((fact) => fact.kind === "user" && fact.id.endsWith("_source"));
}

// Email paragraphs split on blank lines with each separator kept verbatim, so
// concatenating text + separator rebuilds the body exactly. A paragraph whose
// text is exactly equal to the summary or a section is marked so the printed
// appendix can reference that copy instead of repeating it.
export interface EmailPart { text: string; separator: string; sameAs: "summary" | number | null }
export function emailParts(brief: Brief): EmailPart[] {
  const pieces = brief.emailBody.split(/(\r?\n(?:[ \t]*\r?\n)+)/);
  const parts: EmailPart[] = [];
  for (let index = 0; index < pieces.length; index += 2) {
    const text = pieces[index];
    const section = text ? brief.sections.findIndex((item) => item.text === text) : -1;
    parts.push({ text, separator: pieces[index + 1] ?? "", sameAs: text && text === brief.summary ? "summary" : section >= 0 ? section : null });
  }
  return parts;
}

// Facts grouped by identical label, in first-appearance order. Facts that also
// share value, kind and sources collapse into one row that keeps every ID.
export interface FactRow { ids: string[]; value: string; kind: Fact["kind"]; sources: string[] }
export function factGroups(facts: Fact[], sourceLabels: ReadonlyMap<string, string>): { label: string; rows: FactRow[] }[] {
  const groups = new Map<string, Map<string, FactRow>>();
  for (const fact of facts) {
    const sources = fact.evidence.map((evidence) => sourceLabels.get(evidenceText(evidence)) ?? "unregistered");
    const rows = groups.get(fact.label) ?? new Map<string, FactRow>();
    groups.set(fact.label, rows);
    const key = JSON.stringify([fact.value, fact.kind, sources]);
    const row = rows.get(key);
    if (row) row.ids.push(fact.id);
    else rows.set(key, { ids: [fact.id], value: fact.value, kind: fact.kind, sources });
  }
  return [...groups].map(([label, rows]) => ({ label, rows: [...rows.values()] }));
}

// The proposal's source register (same E labels as the Markdown appendix) with
// the facts that cite each request and whether it identifies the plan audience.
export interface BriefSource { label: string; evidence: Evidence; factIds: string[]; audienceIdentity: boolean; performanceCheck: boolean }
export function briefSources(brief: Brief, plan?: TourPlan | null): BriefSource[] {
  const seed = new Set((plan?.seedEvidence ?? []).map(evidenceText));
  const checks = plan?.stops.flatMap((stop) => stop.supportGroups.flatMap((group) => group.candidates.flatMap((candidate) => candidate.evidence.filter((entry) => entry.provider === "wikidata")))) ?? [];
  return evidenceRegister([...brief.facts.flatMap((fact) => fact.evidence), ...(plan?.seedEvidence ?? []), ...checks]).map(({ label, evidence }) => {
    const key = evidenceText(evidence);
    return { label, evidence, factIds: brief.facts.filter((fact) => fact.evidence.some((item) => evidenceText(item) === key)).map((fact) => fact.id), audienceIdentity: seed.has(key) && evidence.provider !== "wikidata", performanceCheck: evidence.provider === "wikidata" };
  });
}

const CHECK_STATUS: Record<UserCheckStatus, string> = { current: "CURRENT FOR THIS ROUTE", reconfirm: "RECONFIRMATION REQUIRED", not_current: "NOT CURRENT FOR THIS ROUTE" };

function allWarnings(plan: TourPlan): string[] {
  return [...new Set([...plan.warnings, ...plan.schedule.warnings,
    ...plan.stops.flatMap((stop) => stop.warnings), ...plan.schedule.rows.flatMap((row) => row.warnings)])];
}

export function exportMarkdown(plan: TourPlan): string {
  const lines = ["# TourPulse Day Sheet", "", `Headliner: ${markdown(plan.headliner.name)} (${markdown(plan.headliner.id)})`,
    `Anchors: ${plan.anchors.length ? plan.anchors.map((anchor) => `${markdown(anchor.name)} (${markdown(anchor.id)})`).join(", ") : "None"}`,
    `Plan: ${markdown(plan.id)} · Revision: ${plan.revision} · Mode: ${markdown(plan.input.tourType)} · Generated: ${markdown(plan.generatedAt)}`,
    `Window: ${markdown(plan.input.startDate)} – ${markdown(plan.input.endDate)} (UTC) · Departure: ${markdown(plan.input.startCity)}`,
    `Daily driving cap: ${plan.input.maxDriveHours} h · Venue category target: ${plan.input.capacity} (not verified capacity)`, "",
    SCOPE, "", `Status: **${plan.schedule.feasible ? "FEASIBLE ESTIMATE — not a confirmed booking" : "INFEASIBLE — no valid itinerary"}**`,
    `Estimated route: ${number(plan.schedule.totalKm)} km · Input-order route: ${number(plan.schedule.originalKm)} km · Travel days: ${plan.schedule.travelDays}`, ""];
  // U IDs and effective check states match the printed Day Sheet register.
  const checks = new Map(venueResearch(plan).checks.map((check) => [check.note, check]));
  const checkText = (note: Confirmation) => {
    const check = checks.get(note)!;
    return `${check.id}; source ${markdown(note.sourceUrl)}; checked ${markdown(note.checkedAt)}; date ${markdown(note.forDate)}; ${CHECK_STATUS[check.status]} (${markdown(check.reason)}); user-sourced, not independently verified`;
  };
  if (plan.schedule.feasible) {
    lines.push("## Schedule", "", "| Date (UTC) | Kind | City | Neighborhood | Selected venue | Support | Sponsor | Drive km | Drive h | Reason / warnings |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const row of plan.schedule.rows) lines.push(`| ${[row.date, row.kind, row.city, row.neighborhood, row.venue, row.support.join("; "), row.sponsors.join("; "),
      number(row.driveKm), number(row.driveHours), [row.reason, ...row.warnings].join("; ")].map(markdown).join(" | ")} |`);
  } else {
    lines.push(`Additional days required: ${plan.schedule.extraDays}`, "", ...plan.schedule.suggestions.map((suggestion) => `- ${markdown(suggestion)}`));
  }
  lines.push("", "## Warnings", "", ...(allWarnings(plan).length ? allWarnings(plan).map((warning) => `- ${markdown(warning)}`) : ["None reported."]),
    "", "## Discovery evidence", "", "Scores are exploratory, not audience forecasts or compatibility percentages. Missing values mean insufficient evidence.");
  const sources = new Map<string, { label: string; evidence: Evidence }>();
  for (const evidence of plan.seedEvidence) sources.set(evidenceText(evidence), { label: `E${sources.size + 1}`, evidence });
  lines.push(`Audience identity and eligibility sources: ${[...sources.values()].map((source) => source.label).join(", ")}.`);
  for (const stop of plan.stops) {
    lines.push("", `### ${markdown(stop.name)}`,
      `Destination rank: ${number(stop.destinationRank)} · Scene Fit: ${number(stop.sceneFit)} · City Fit: ${number(stop.cityFit)} · Anchor rank delta: ${number(stop.anchorDelta)}`);
    for (const [label, places] of [["Venue candidates", stop.venues], ["Nearby partners", stop.partners.slice(0, 6)]] as const) {
      lines.push(`- ${label}: ${places.length ? places.map((place) => markdown(place.name)).join("; ") : "insufficient evidence"}.`);
    }
    lines.push(`- Selected neighborhood: ${markdown(stop.selectedNeighborhood)}; selected venue: ${markdown(stop.selectedVenueId)}; selected partners: ${stop.selectedPartnerIds.map(markdown).join(", ") || "None"}.`,
      `- Retained comparison place IDs: ${stop.retainedPlaceIds.map(markdown).join(", ") || "None"}.`);
    for (const place of [...stop.venues, ...stop.partners]) lines.push(`- Place ${markdown(place.name)} (${markdown(place.id)}): ${markdown(place.address)}; ${markdown(place.website)}; affinity ${number(place.affinity)}; Why ${markdown(JSON.stringify(place.explainability))}.`);
    for (const group of stop.supportGroups) {
      lines.push(`- ${markdown(group.kind)} candidates: ${group.warnings.map(markdown).join("; ")}`);
      for (const candidate of group.candidates) lines.push(`  - ${stop.selectedSupportIds.includes(candidate.entity.id) ? "SELECTED " : ""}${markdown(candidate.entity.name)} (${markdown(candidate.entity.id)}): audience rank ${candidate.rank}; audience base ${number(candidate.fit.baseScore)}; fit ${number(candidate.fit.score)} (${candidate.fit.status}); places ${candidate.fit.observedPlaces}/${candidate.fit.totalPlaces}; ${candidate.fit.warnings.map(markdown).join("; ")}; observations ${markdown(JSON.stringify(candidate.placeAffinities))}.`,
        `    Biographical status: ${markdown(supportCheckText(candidate))}`);
    }
    for (const confirmation of stop.confirmations) lines.push(`- USER CONFIRMATION ${markdown(confirmation.entityId)} / ${confirmation.field}: ${markdown(confirmation.value)}; ${checkText(confirmation)}.`);
    if (stop.venueDecisions.length) {
      lines.push("- USER VENUE JUDGMENTS (written by the planner's user; shortlist/hold/exclude are research decisions, not provider facts, not selections of record and not bookings):");
      for (const decision of stop.venueDecisions) {
        const present = stop.venues.some((venue) => venue.id === decision.entityId);
        lines.push(`  - ${markdown(decision.venueName)} (${markdown(decision.entityId)}): ${decision.status}${present ? "" : "; ARCHIVED — not in the current returned candidates"}; ${markdown(decision.reason)}; decided ${markdown(decision.decidedAt)}${decision.needsReview ? "; NEEDS REVIEW after plan changes" : ""}. This judgment does not confirm a booking.`);
      }
    }
    const references = new Set<string>();
    for (const evidence of [...stop.evidence, ...stop.venues.map((place) => place.evidence), ...stop.partners.map((place) => place.evidence), ...stop.supportGroups.flatMap((g) => g.candidates.flatMap((c) => c.evidence))]) {
      const identity = evidenceText(evidence);
      if (!sources.has(identity)) sources.set(identity, { label: `E${sources.size + 1}`, evidence });
      references.add(sources.get(identity)!.label);
    }
    lines.push(`- Sources: ${[...references].join(", ")}.`);
  }
  // Historical research covers two cases: a market that left the route, and
  // saved notes for places of a live market that no longer returns candidates.
  // Both keep the user's own records; neither is a route row or provider evidence.
  if (plan.archivedResearch.length) {
    lines.push("", "## Historical research — user notes outside current research", "",
      "These records are historical. They contribute no schedule rows, selected venues or provider evidence, and old selections are not restored. A market that is not in this revision is listed as such; a current market's earlier candidates are listed separately from that market's live research above. An exclusion saved for a market outside this route still blocks that venue if the market returns, until the user explicitly reviews it.");
    for (const market of plan.archivedResearch) {
      const live = plan.stops.some((stop) => stop.id === market.id);
      const stale = market.venueDecisions.some((decision) => decision.needsReview) || market.confirmations.some((note) => note.needsReconfirmation);
      lines.push("", `### ${markdown(market.name)} — ${live ? "EARLIER CANDIDATES OF A CURRENT MARKET, NOT IN ITS CURRENT CANDIDATE SET" : "MARKET NOT IN THIS ROUTE"}${stale ? " (context changed; review required)" : ""}`,
        `- State: historical user research only; not a stop, not provider evidence, not a booking.${live ? " The market itself is a current stop; the records below are kept outside its live research." : ""}`,
        `- Saved place names: ${market.places.length ? market.places.map((place) => `${markdown(place.name)} (${markdown(place.id)})`).join("; ") : "None"}.`);
      if (market.venueDecisions.length) {
        lines.push("- USER VENUE JUDGMENTS (from an earlier revision of this plan; status is not current suitability):");
        for (const decision of market.venueDecisions) lines.push(`  - ${markdown(decision.venueName)} (${markdown(decision.entityId)}): ${decision.status}; ${markdown(decision.reason)}; decided ${markdown(decision.decidedAt)}${decision.needsReview ? "; NEEDS REVIEW after earlier plan changes" : ""}. This judgment does not confirm a booking.`);
      }
      if (market.confirmations.length) {
        lines.push("- USER-SOURCED CHECKS (recorded by the user; not independently verified):");
        for (const note of market.confirmations) {
          const place = market.places.find((candidate) => candidate.id === note.entityId);
          lines.push(`  - ${markdown(place?.name ?? note.entityId)} (${markdown(note.entityId)}) / ${note.field}: ${markdown(note.value)}; ${checkText(note)}.`);
        }
      }
    }
  }
  lines.push("", "## Sponsor purpose checks — user research", "", SPONSOR_CHECK_SCOPE, "",
    ...(plan.sponsorChecks.length ? sponsorCheckRecords(plan).map((record) => `- ${sponsorCheckMarkdown(record)}`) : ["No sponsor purpose checks recorded. Brand fit for each purpose is not reviewed."]));
  lines.push("", "## Sponsor candidates");
  for (const sponsor of plan.sponsors) {
    lines.push(`- ${sponsor.entity.id === plan.selectedSponsorId ? "SELECTED " : ""}${markdown(sponsor.entity.name)} (${markdown(sponsor.entity.id)}): audience rank ${sponsor.rank}; base ${number(sponsor.fit.baseScore)}; fit ${number(sponsor.fit.score)} (${sponsor.fit.status}); anchor rank delta ${number(sponsor.anchorDelta)}; ${sponsor.fit.warnings.map(markdown).join("; ")}.`,
      `  - Why: ${markdown(JSON.stringify(sponsor.explainability))}; observations: ${markdown(JSON.stringify(sponsor.placeAffinities))}.`);
    for (const spot of sponsor.activationSpots) lines.push(`  - Activation candidate ${markdown(spot.stopId)}: ${markdown(spot.placeId)}; affinity ${number(spot.affinity)}; permission and availability unconfirmed.`);
    for (const evidence of sponsor.evidence) {
      const identity = evidenceText(evidence);
      if (!sources.has(identity)) sources.set(identity, { label: `E${sources.size + 1}`, evidence });
    }
  }
  lines.push("", "## Source register", "", "Each request is listed once. Full call details remain available in the application trace.");
  for (const { label, evidence } of sources.values()) lines.push(`- ${label}: ${markdown(evidenceText(evidence))}`);
  return `${lines.join("\n")}\n`;
}

// Quote every cell per RFC 4180. Prefix string formulas (including leading
// whitespace/control obfuscation); numeric negative observations stay numeric.
function csvCell(value: string | number | boolean | null | undefined): string {
  let text = value == null ? "" : String(value);
  if (typeof value === "string" && (/^[\s\u0000-\u001f\u007f]*[=+\-@]/.test(text) || /^[\u0000-\u001f\u007f]/.test(text))) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function exportCsv(plan: TourPlan): string {
  const headers = ["status", "date", "day_type", "city", "neighborhood", "venue_candidate", "drive_km_estimate", "drive_hours_estimate", "city_fit", "reason", "warnings", "sources", "generated_at", "revision", "mode", "support", "sponsor", "selected_partners", "confirmations", "retained_place_ids", "support_comparisons", "sponsor_comparisons", "activation_candidates", "place_candidates", "city_explainability", "target_capacity_user_input", "local_venue_decisions", "sponsor_purpose_check"] as const;
  type Column = (typeof headers)[number];
  const records: Partial<Record<Column, string | number | null>>[] = [];
  // Historical research is exported as its own non-schedule records: no date,
  // day type, drive estimate or venue of record, so it can never read as a
  // booked or routed row. Notes and judgments stay lossless. The status names
  // whether the market left the route or is current with earlier candidates.
  for (const market of plan.archivedResearch) {
    const live = plan.stops.some((stop) => stop.id === market.id);
    records.push({
      status: live ? "historical research — earlier candidates of a current market (not a route row)" : "historical research — market outside this route (not a route row)", city: market.name,
      reason: market.venueDecisions.map((decision) => `${decision.venueName} [${decision.status}${decision.needsReview ? ", needs review" : ""}]: ${decision.reason}`).join(" | "),
      warnings: `Historical user research: not provider evidence, and not a booking. ${live ? "The market is a current stop; these records are outside its live research." : "The market is not in this revision's route."} ${market.confirmations.length} user-sourced checks. Saved place names: ${market.places.map((place) => place.name).join("; ") || "none"}.`,
      generated_at: plan.generatedAt, revision: plan.revision, mode: plan.input.tourType,
      confirmations: JSON.stringify(market.confirmations),
      target_capacity_user_input: plan.input.capacity,
      local_venue_decisions: JSON.stringify(market.venueDecisions.map((decision) => ({ cityId: market.id, ...decision }))),
    });
  }
  // Sponsor purpose checks are user research too: one non-schedule record each.
  for (const { check, brandName, current, savedPurpose, status, purpose } of sponsorCheckRecords(plan)) {
    records.push({
      status: `sponsor purpose check — user research (not a route row)${current ? "" : `; ${orphanSponsorCheckNote}`}`, sponsor: brandName,
      reason: `${status} for ${purpose}${savedPurpose ? " (saved purpose)" : ""}: ${check.reason}`,
      warnings: SPONSOR_CHECK_SCOPE, sources: check.sourceUrl,
      generated_at: plan.generatedAt, revision: plan.revision, mode: plan.input.tourType,
      target_capacity_user_input: plan.input.capacity,
      sponsor_purpose_check: JSON.stringify({ ...check, brandName, currentCandidate: current }),
    });
  }
  if (!plan.schedule.feasible) {
    records.push({
      status: "infeasible", reason: plan.schedule.suggestions.join("; "),
      warnings: [...allWarnings(plan), SCOPE].join("; "), sources: plan.seedEvidence.map(evidenceText).join("\n"),
      generated_at: plan.generatedAt, revision: plan.revision, mode: plan.input.tourType,
      sponsor_comparisons: JSON.stringify(plan.sponsors), target_capacity_user_input: plan.input.capacity,
      local_venue_decisions: JSON.stringify(plan.stops.flatMap((stop) => stop.venueDecisions.map((decision) => ({ cityId: stop.id, ...decision })))),
    });
  } else {
    const stops = new Map(plan.stops.map((stop) => [stop.id, stop]));
    for (const row of plan.schedule.rows) {
      const stop = row.cityId ? stops.get(row.cityId) : undefined;
      const sources = new Set([...plan.seedEvidence, ...(stop?.evidence ?? []), ...(stop?.supportGroups.flatMap((g) => g.candidates.flatMap((c) => c.evidence)) ?? []), ...plan.sponsors.flatMap((s) => s.evidence)].map(evidenceText));
      const warnings = new Set([...plan.warnings, ...plan.schedule.warnings, ...(stop?.warnings ?? []), ...row.warnings]);
      records.push({
        status: "feasible estimate", date: row.date, day_type: row.kind, city: row.city, neighborhood: row.neighborhood, venue_candidate: row.venue,
        drive_km_estimate: Math.round(row.driveKm * 10) / 10, drive_hours_estimate: Math.round(row.driveHours * 100) / 100,
        city_fit: stop?.cityFit == null ? "insufficient evidence" : Math.round(stop.cityFit * 100),
        reason: row.reason, warnings: [...warnings].join("; "), sources: [...sources].join("\n"),
        generated_at: plan.generatedAt, revision: plan.revision, mode: plan.input.tourType,
        support: row.support.join("; "), sponsor: row.sponsors.join("; "),
        selected_partners: (stop?.selectedPartnerIds ?? []).join("; "), confirmations: JSON.stringify(stop?.confirmations ?? []),
        retained_place_ids: (stop?.retainedPlaceIds ?? []).join("; "), support_comparisons: JSON.stringify(stop?.supportGroups ?? []),
        sponsor_comparisons: JSON.stringify(plan.sponsors.map(({ entity, rank, fit, anchorDelta, explainability, placeAffinities }) => ({ entity, rank, fit, anchorDelta, explainability, placeAffinities }))),
        activation_candidates: JSON.stringify(plan.sponsors.map((sponsor) => ({ brandId: sponsor.entity.id, spots: sponsor.activationSpots.filter((spot) => spot.stopId === stop?.id) }))),
        place_candidates: JSON.stringify([...(stop?.venues ?? []), ...(stop?.partners ?? [])]), city_explainability: JSON.stringify(stop?.explainability ?? {}),
        target_capacity_user_input: plan.input.capacity,
        local_venue_decisions: JSON.stringify((stop?.venueDecisions ?? []).map((decision) => ({ cityId: stop?.id ?? row.cityId, ...decision }))),
      });
    }
  }
  // Header order is the single source of truth, so a record can never drift a
  // column; an unset column exports as an empty cell.
  const rows: (string | number | null | undefined)[][] = [[...headers], ...records.map((record) => headers.map((header) => record[header]))];
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function exportBriefMarkdown(brief: Brief): string {
  const lines = [`# ${markdown(brief.title)}`, "", "**DRAFT — not a sponsor commitment or booking, and not sent.**",
    `Revision ${brief.revision} · prepared ${markdown(brief.createdAt)}`, "", multilineMarkdown(brief.summary)];
  for (const section of brief.sections) lines.push("", `## ${markdown(section.heading)}`, "", multilineMarkdown(section.text));
  lines.push("", "## Draft email", "", `Subject: ${markdown(brief.emailSubject)}`, "", multilineMarkdown(brief.emailBody), "", "---", "", markdown(RECIPIENT_BOUNDARY));
  return `${lines.join("\n")}\n`;
}

// The evidence appendix is the audit view: every fact, citation, warning and the
// complete source register, with nothing removed from the recipient copy.
export function exportBriefEvidenceMarkdown(brief: Brief, plan?: TourPlan): string {
  const sources = briefSources(brief, plan);
  const labelBySource = new Map(sources.map((source) => [evidenceText(source.evidence), source.label]));
  const lines = [`# Evidence appendix — ${markdown(brief.title)}`, "", `Proposal draft in full context. Plan ${markdown(brief.planId)} · revision ${brief.revision} · brand ${markdown(brief.brandId)} · created ${markdown(brief.createdAt)} · model ${markdown(brief.model)}`, "",
    "## Recipient copy as drafted", "", multilineMarkdown(brief.summary)];
  for (const section of brief.sections) lines.push("", `### ${markdown(section.heading)}`, "", multilineMarkdown(section.text), "", `Cited facts: ${section.factIds.map(markdown).join(", ") || "None — conditional proposal wording only"}`);
  lines.push("", "### Draft email", "", `Subject: ${markdown(brief.emailSubject)}`, "", multilineMarkdown(brief.emailBody), "",
    "### Recipient boundary", "", markdown(RECIPIENT_BOUNDARY), "", "## Fact ledger", "",
    "Each value below is the exact text rendered into the recipient copy. Placeholders are resolved from this ledger only.");
  for (const fact of brief.facts) {
    lines.push(`- ${markdown(fact.id)} [${fact.kind}] ${markdown(fact.label)}: ${markdown(fact.value)}`);
    for (const source of fact.evidence) lines.push(`  - ${labelBySource.get(evidenceText(source)) ?? "unregistered"}: ${markdown(evidenceText(source))}`);
  }
  lines.push("", "## Warnings and limits", ...brief.warnings.map((warning) => `- ${markdown(warning)}`));
  if (plan) {
    const record = briefSponsorCheck(brief, plan);
    lines.push("", "## Sponsor purpose check", "", SPONSOR_CHECK_SCOPE, "", `- ${record ? sponsorCheckMarkdown(record) : markdown(unreviewedSponsorWarning)}`);
    lines.push("", "## Audience comparison source detail", "",
      `Headliner: ${markdown(plan.headliner.name)} (${markdown(plan.headliner.id)}) · anchors: ${plan.anchors.map((anchor) => markdown(anchor.name)).join(", ") || "none"} · mode: ${markdown(plan.input.tourType)}`,
      `Window: ${markdown(plan.input.startDate)} – ${markdown(plan.input.endDate)} (UTC) from ${markdown(plan.input.startCity)} · requested capacity: ${plan.input.capacity} (planning target, not verified capacity) · schedule feasible: ${plan.schedule.feasible}`);
    lines.push("", plan.brief && plan.brief.revision === brief.revision
      ? `This appendix describes the brief saved on plan revision ${plan.revision}.`
      : `Plan revision ${plan.revision} does not currently hold this brief (revision ${brief.revision}); the plan context above may have changed since it was drafted.`);
  }
  lines.push("", "## Source register", "", "Every cited request appears once with its original fetch time and cache status.",
    ...(sources.length ? sources.map(({ label: id, evidence }) => `- ${id}: ${markdown(evidenceText(evidence))}`) : ["No external sources: this brief used user input and computed values only."]),
    ...briefUserSources(brief).map((fact) => `- User-cited public source for ${markdown(fact.id.replace(/_source$/, ""))} (recorded by the user; not fetched or verified by TourPulse): ${markdown(fact.value)}`));
  return `${lines.join("\n")}\n`;
}
