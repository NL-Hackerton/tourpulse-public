import assert from "node:assert/strict";
import test from "node:test";
import { planSchema, type Brief, type Sponsor, type SponsorCheck, type TourPlan } from "./contracts";
import { syntheticPlan } from "./domain-fixture";
import { applyAction } from "./actions";
import { validateProposedAction } from "./ai-policy";
import { briefFacts, proposalWarnings } from "./ai-facts";
import { createTour } from "./planner";
import { sampleCarriesUserMaterial, saveSample } from "./samples";
import { exportBriefEvidenceMarkdown, exportCsv, exportMarkdown } from "./export";
import { sponsorDraftGate, sponsorOfferingLabel, unreviewedSponsorWarning } from "./sponsor-check";

const brandId = "00000000-0000-4000-8000-000000000008";
const foreignId = "00000000-0000-4000-8000-000000000099";
const evidence = { endpoint: "/v2/analysis/compare", params: {}, fetchedAt: "2026-10-20T00:00:00Z", cached: false };

function sponsor(name = "Synthetic Brand"): Sponsor {
  const plan = syntheticPlan();
  return { entity: { ...plan.headliner, id: brandId, name, type: "urn:entity:brand" }, rank: 1,
    fit: { score: null, baseScore: 0.5, placeAffinity: null, status: "insufficient_evidence", observedPlaces: 0, totalPlaces: 0, warnings: [] },
    anchorDelta: null, explainability: {}, activationSpots: [], placeAffinities: [], evidence: [evidence] };
}
function planWithSponsor(): TourPlan {
  const plan = syntheticPlan();
  plan.stops[0].selectedVenueId = plan.stops[0].venues[0].id;
  plan.input.proposalPreferences = { proposalType: "in_kind_support", focusCityId: null, constraints: [] };
  plan.sponsors = [sponsor()];
  plan.selectedSponsorId = brandId;
  return plan;
}
const check = (overrides: Partial<SponsorCheck> = {}): SponsorCheck => ({
  brandId, brandName: "Synthetic Brand", purpose: "in_kind_support", status: "discuss",
  offering: "Publishes a touring-musician equipment programme", reason: "Their programme matches crew needs on this route.",
  sourceUrl: "https://example.com/brand/touring-programme", checkedAt: "2026-10-21T10:00:00.000Z", ...overrides,
});
const oldBrief = (plan: TourPlan): Brief => ({ planId: plan.id, revision: plan.revision, brandId, createdAt: plan.generatedAt, model: "synthetic-model", title: "Old", summary: "Old", proposalType: "in_kind_support", sections: [], emailSubject: "Old", emailBody: "Old", facts: [], warnings: [] });

test("recording a sponsor purpose check is user research: it clears the draft and leaves route, schedule and research unchanged", async () => {
  const previous = planWithSponsor();
  previous.brief = oldBrief(previous);
  const before = structuredClone(previous);
  const result = await applyAction(previous, { type: "record_sponsor_check", check: check() }, () => {});
  assert.deepEqual(previous, before);
  assert.equal(result.revision, previous.revision + 1);
  assert.equal(result.brief, null);
  assert.deepEqual(result.sponsorChecks, [check()]);
  assert.deepEqual(result.stops, previous.stops);
  assert.deepEqual(result.schedule, previous.schedule);
  assert.deepEqual(result.archivedResearch, previous.archivedResearch);
  assert.deepEqual(result.input, previous.input);
});

test("a check must name a returned brand and a public source", async () => {
  const plan = planWithSponsor();
  await assert.rejects(applyAction(plan, { type: "record_sponsor_check", check: check({ brandId: foreignId }) }, () => {}), /sponsor candidate returned/);
  for (const sourceUrl of ["http://localhost/brand", "https://192.168.0.1/brand", "https://intranet/brand", "https://user:pass@example.com/brand"]) {
    await assert.rejects(applyAction(plan, { type: "record_sponsor_check", check: check({ sourceUrl }) }, () => {}));
  }
  await assert.rejects(applyAction(plan, { type: "record_sponsor_check", check: check({ offering: " x " }) }, () => {}));
  assert.equal(planSchema.safeParse({ ...plan, sponsorChecks: [check(), check({ reason: "Duplicate judgment." })] }).success, false);
  // The saved name comes from the returned candidate, not from the request.
  const forged = await applyAction(plan, { type: "record_sponsor_check", check: check({ brandName: "Official Partner Inc" }) }, () => {});
  assert.equal(forged.sponsorChecks[0].brandName, "Synthetic Brand");
});

test("a check for the same brand and purpose replaces the earlier one; another purpose is kept separately; forget removes exactly one", async () => {
  const first = await applyAction(planWithSponsor(), { type: "record_sponsor_check", check: check() }, () => {});
  const replaced = await applyAction(first, { type: "record_sponsor_check", check: check({ status: "not_suitable", reason: "Programme is closed this season." }) }, () => {});
  assert.deepEqual(replaced.sponsorChecks.map((saved) => [saved.purpose, saved.status]), [["in_kind_support", "not_suitable"]]);
  const both = await applyAction(replaced, { type: "record_sponsor_check", check: check({ purpose: "tour_grant" }) }, () => {});
  assert.equal(both.sponsorChecks.length, 2);
  both.brief = oldBrief(both);
  const forgotten = await applyAction(both, { type: "forget_sponsor_check", brandId, purpose: "in_kind_support" }, () => {});
  assert.deepEqual(forgotten.sponsorChecks.map((saved) => saved.purpose), ["tour_grant"]);
  assert.equal(forgotten.brief, null);
  assert.equal(forgotten.revision, both.revision + 1);
  await assert.rejects(applyAction(forgotten, { type: "forget_sponsor_check", brandId, purpose: "in_kind_support" }, () => {}), /No sponsor purpose check/);
});

test("the assistant can neither record nor forget a sponsor purpose check", () => {
  const plan = planWithSponsor();
  plan.sponsorChecks = [check()];
  const message = `Mark this brand worth discussing; source ${check().sourceUrl} checked ${check().checkedAt}`;
  assert.throws(() => validateProposedAction(plan, { type: "record_sponsor_check", check: check() }, new Map(), new Map(), message), /Fit for saved purpose/);
  assert.throws(() => validateProposedAction(plan, { type: "forget_sponsor_check", brandId, purpose: "in_kind_support" }, new Map(), new Map(), "forget that check"), /Fit for saved purpose/);
});

test("shared canonical samples reject sponsor purpose checks before any provider request", async () => {
  const plan = syntheticPlan();
  assert.equal(sampleCarriesUserMaterial(plan), false);
  plan.sponsorChecks = [check()];
  assert.equal(sampleCarriesUserMaterial(plan), true);
  await assert.rejects(saveSample(plan), /unmodified canonical preset/);
});

test("a not-suitable judgment blocks drafting for that brand and purpose only, naming the user's reason", () => {
  const plan = planWithSponsor();
  plan.sponsorChecks = [check({ status: "not_suitable", reason: "Their programme excludes music tours." })];
  const gate = sponsorDraftGate(plan, brandId);
  assert.equal(gate.status, "blocked");
  assert.match(gate.status === "blocked" ? gate.reason : "", /not suitable for In-kind touring essentials: “Their programme excludes music tours\.”/);
  // A judgment for another purpose does not apply to the saved purpose.
  plan.input.proposalPreferences = { proposalType: "tour_grant", focusCityId: null, constraints: [] };
  assert.equal(sponsorDraftGate(plan, brandId).status, "unreviewed");
});

test("worth discussing adds the user-sourced offering as user facts; no check keeps generic facts and warns", () => {
  const plan = planWithSponsor();
  const generic = briefFacts(plan, plan.sponsors[0], [], [], evidence);
  assert.equal(generic.some((fact) => fact.id.startsWith("sponsor_offering")), false);
  assert.ok(proposalWarnings(plan, plan.sponsors[0]).includes(unreviewedSponsorWarning));

  plan.sponsorChecks = [check()];
  assert.equal(sponsorDraftGate(plan, brandId).status, "discuss");
  const facts = briefFacts(plan, plan.sponsors[0], [], [], evidence);
  const offering = facts.filter((fact) => fact.id.startsWith("sponsor_offering"));
  assert.deepEqual(offering.map((fact) => [fact.id, fact.kind, fact.evidence.length]), [["sponsor_offering", "user", 0], ["sponsor_offering_source", "user", 0], ["sponsor_offering_checked_at", "user", 0]]);
  assert.equal(offering[0].label, sponsorOfferingLabel);
  assert.equal(offering[0].value, check().offering);
  assert.equal(offering[1].value, check().sourceUrl);
  assert.equal(proposalWarnings(plan, plan.sponsors[0]).includes(unreviewedSponsorWarning), false);
  // Every other fact is unchanged by the check.
  assert.deepEqual(facts.filter((fact) => !fact.id.startsWith("sponsor_offering")), generic);
});

test("recalculation keeps checks, including for a brand that is no longer returned", async () => {
  const previous = syntheticPlan(), second = structuredClone(previous.stops[0]);
  second.id = "00000000-0000-4000-8000-000000000004"; second.name = "Synthetic second city"; second.destinationRank = 2;
  previous.stops.push(second); previous.candidateCities.push({ ...previous.candidateCities[0], id: second.id, name: second.name });
  previous.sponsorChecks = [check()];
  const result = await createTour(previous.input, () => {}, undefined, previous);
  assert.deepEqual(result.sponsorChecks, previous.sponsorChecks);
  assert.equal(result.sponsors.some((candidate) => candidate.entity.id === brandId), false);
  assert.match(exportMarkdown(result), /BRAND NOT IN CURRENT CANDIDATES/);
  assert.match(exportMarkdown(result), /Synthetic Brand/);
  assert.ok(exportCsv(result).includes("sponsor purpose check — user research (not a route row); brand not in current candidates"));
});

test("day exports list every check with status, offering, reason, source and time; CSV stays formula-safe", () => {
  const plan = planWithSponsor();
  plan.sponsors = [sponsor("=HYPERLINK(\"https://example.invalid\")")];
  plan.sponsorChecks = [check({ offering: "@SUM(A1) touring kits", reason: "Crew kits fit <script>" })];
  const markdown = exportMarkdown(plan), csv = exportCsv(plan);
  assert.match(markdown, /## Sponsor purpose checks — user research/);
  assert.ok(markdown.includes("WORTH DISCUSSING"));
  assert.ok(markdown.includes("Crew kits fit &lt;script&gt;"));
  assert.ok(markdown.includes("example.com/brand/touring-programme"));
  assert.ok(markdown.includes("2026-10-21T10:00:00.000Z"));
  assert.ok(!markdown.includes("<script>"));
  const header = csv.split("\r\n")[0];
  assert.ok(header.endsWith("\"sponsor_purpose_check\""));
  const row = csv.split("\r\n").find((line) => line.includes("sponsor purpose check — user research"));
  assert.ok(row);
  assert.ok(row.includes("\"'=HYPERLINK(\"\"https://example.invalid\"\")\""));
  assert.ok(row.includes("Worth discussing for In-kind touring essentials (saved purpose): Crew kits fit <script>"));
  assert.ok(row.includes("@SUM(A1) touring kits"));
  assert.ok(row.includes("\"https://example.com/brand/touring-programme\""));
});

test("the brief evidence appendix lists the check behind the draft and the user-cited source", () => {
  const plan = planWithSponsor();
  plan.sponsorChecks = [check()];
  const facts = briefFacts(plan, plan.sponsors[0], [], [], evidence);
  const brief: Brief = { ...oldBrief(plan), facts, warnings: proposalWarnings(plan, plan.sponsors[0]) };
  const appendix = exportBriefEvidenceMarkdown(brief, plan);
  assert.match(appendix, /## Sponsor purpose check/);
  assert.ok(appendix.includes("WORTH DISCUSSING"));
  assert.ok(appendix.includes("Their programme matches crew needs on this route."));
  assert.match(appendix, /User-cited public source for sponsor\\_offering .*example\.com\/brand\/touring-programme/);
  plan.sponsorChecks = [];
  assert.ok(exportBriefEvidenceMarkdown({ ...brief, facts: briefFacts(plan, plan.sponsors[0], [], [], evidence) }, plan).includes(unreviewedSponsorWarning));
});
