import assert from "node:assert/strict";
import test from "node:test";
import { briefSources, emailParts, evidenceText, exportBriefEvidenceMarkdown, exportBriefMarkdown, exportCsv, exportMarkdown, factGroups, venueResearch } from "./export";
import { briefFacts, recipientCopyIssues } from "./ai-facts";
import type { Brief, Confirmation, Fact, Place, TourPlan } from "./contracts";
import { checkNames, venueReview } from "./venue-review";

function plan(): TourPlan {
  const evidence = { endpoint: "/v2/insights", params: { "filter.type": "urn:entity:destination" }, fetchedAt: "2026-10-20T00:00:00Z", cached: true };
  return {
    id: "synthetic", generatedAt: "2026-10-20T00:00:00Z", revision: 1, candidateCities: [], sponsors: [], selectedSponsorId: null, sponsorChecks: [], brief: null,
    input: { tourType: "music", candidateCityIds: [], neighborhoods: [], sponsorIncludeTags: [], sponsorExcludeTags: [], nicheWeight: 0.3, headlinerId: "00000000-0000-4000-8000-000000000001", anchorIds: [], stopCount: 2,
      startDate: "2026-10-22", endDate: "2026-10-23", startCity: "Philadelphia", maxDriveHours: 5, showDayPreference: "compact", capacity: 300, alreadyPlayed: [],
      proposalPreferences: { proposalType: "on_site_activation", focusCityId: null, constraints: [] } },
    headliner: { id: "synthetic-artist", name: "Synthetic Artist", type: "artist", popularity: null, description: "", tags: [], location: null, countrySource: "qloo" }, anchors: [],
    seedEvidence: [{ ...evidence, endpoint: "/entities", params: { entity_ids: "synthetic-artist" } }],
    stops: [{ id: "synthetic-city", name: "Synthetic | City\n<script>", lat: 39.9526, lon: -75.1652, destinationRank: 1,
      destinationScore: 1, affinity: null, sceneFit: null, cityFit: 1, anchorDelta: null,
      explainability: {}, cells: [], venues: [], partners: [], evidence: [evidence], warnings: ["Unconfirmed venue"],
      selectedNeighborhood: null, selectedVenueId: null, selectedPartnerIds: [], supportGroups: [], selectedSupportIds: [], retainedPlaceIds: [], confirmations: [],
      venueDecisions: [{ entityId: "00000000-0000-4000-8000-0000000000aa", venueName: "Synthetic archived venue", status: "hold", reason: "Awaiting a capacity check =SUM(A1)", decidedAt: "2026-10-20T00:00:00Z", needsReview: true }] }],
    archivedResearch: [{ id: "synthetic-archived-city", name: "Archived | City\n<script>", places: [{ id: "00000000-0000-4000-8000-0000000000bb", name: "Archived Room =SUM(A1)" }],
      venueDecisions: [{ entityId: "00000000-0000-4000-8000-0000000000bb", venueName: "Archived Room =SUM(A1)", status: "exclude", reason: "Capacity too small for this tour @SUM(A1)", decidedAt: "2026-10-19T00:00:00Z", needsReview: true }],
      confirmations: [{ entityId: "00000000-0000-4000-8000-0000000000bb", field: "capacity", value: "120 seated =1+1", sourceUrl: "https://example.invalid/archived-room", checkedAt: "2026-10-19T00:00:00Z", forDate: null, needsReconfirmation: true }] }],
    schedule: { feasible: true, rows: [{ date: "2026-10-22", kind: "show", cityId: "synthetic-city", city: "Synthetic | City\n<script>",
      neighborhood: "", venue: "=HYPERLINK(\"https://example.invalid\")", driveKm: 12, driveHours: 12 / 90,
      reason: "Synthetic, quoted \"reason\"", warnings: ["Review contract"], support: [], sponsors: [] }], orderedStopIds: ["synthetic-city"],
      totalKm: 12, originalKm: 12, travelDays: 0, extraDays: 0, suggestions: [], warnings: ["Estimated routing"] },
    trace: [{ step: "cities", message: "Synthetic evidence", status: "ok", count: 1, ms: 0, evidence }], warnings: ["Global warning"],
  };
}

// RFC 4180 record parser for assertions: every exported cell is quoted, so a
// regex over quote runs would confuse adjacent empty cells with one long cell.
function csvRecords(text: string): string[][] {
  const records: string[][] = []; let record: string[] = []; let cell = ""; let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character !== '"') cell += character;
      else if (text[index + 1] === '"') { cell += '"'; index++; }
      else quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === ",") { record.push(cell); cell = ""; }
    else if (character === "\n") { record.push(cell.replace(/\r$/, "")); records.push(record); record = []; cell = ""; }
    else cell += character;
  }
  if (cell || record.length) records.push([...record, cell]);
  return records;
}

function brief(): Brief {
  return { planId: "synthetic", revision: 7, brandId: "synthetic-brand", createdAt: "2026-10-20T00:00:00Z", model: "synthetic-test-model",
    title: "<script>Injected</script>", summary: "A synthetic draft", proposalType: "in_kind_support",
    sections: [{ heading: "Proposed activation", text: "User selection, not a booking", factIds: ["F1"] }, { heading: "Next step", text: "Confirm interest", factIds: [] }],
    emailSubject: "Synthetic subject", emailBody: "Draft contact text",
    facts: [{ id: "F1", label: "Input capacity", value: "300", kind: "user", evidence: [{ endpoint: "/v2/insights", params: { entity_ids: "synthetic" }, fetchedAt: "2026-10-20T00:00:00Z", cached: true }] }],
    warnings: ["Verify availability"] };
}

test("CSV escapes formula prefixes and preserves RFC4180 quotes, provenance and warnings", () => {
  for (const malicious of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1", "  =1", "\u0000=1"]) {
    const fixture = plan();
    fixture.schedule.rows[0].venue = malicious;
    const csv = exportCsv(fixture);
    assert.ok(csv.includes(`"'${malicious.replace(/"/g, '""')}"`));
    assert.ok(csv.endsWith("\r\n"));
    assert.ok(csv.includes('"Synthetic, quoted ""reason"""'));
    assert.ok(csv.includes("/v2/insights"));
    assert.ok(csv.includes("2026-10-20T00:00:00Z"));
    assert.ok(csv.includes("Global warning") && csv.includes("Review contract") && csv.includes("Unconfirmed venue"));
  }
});

test("venue decisions appear as local audit data in Markdown and CSV without claiming provider facts", () => {
  const fixture = plan();
  const markdown = exportMarkdown(fixture), csv = exportCsv(fixture);
  for (const output of [markdown, csv]) {
    assert.ok(output.includes("00000000-0000-4000-8000-0000000000aa"));
    assert.ok(output.includes("hold"));
    assert.ok(output.includes("NEEDS REVIEW") || output.includes("needsReview"));
  }
  // The decision reason keeps its literal "=" but cannot break out of a cell.
  assert.ok(!markdown.includes("\n=SUM"));
  assert.ok(csv.split("\r\n")[0].includes("local_venue_decisions"));
});

test("historical research exports as user notes, never as route, itinerary or booking rows", () => {
  const fixture = plan();
  const markdown = exportMarkdown(fixture), csv = exportCsv(fixture);
  // Markdown keeps historical research in its own section with its own boundary.
  assert.ok(markdown.includes("## Historical research — user notes outside current research"));
  assert.ok(markdown.includes("Archived \\| City<br>&lt;script&gt;"));
  assert.ok(markdown.includes("not provider evidence, not a booking"));
  assert.ok(markdown.includes("MARKET NOT IN THIS ROUTE"));
  assert.ok(markdown.includes("example.invalid/archived-room"));
  assert.ok(markdown.includes("120 seated =1+1"));
  assert.ok(markdown.includes("RECONFIRMATION REQUIRED"));
  assert.ok(markdown.includes("NEEDS REVIEW"));
  // The record never becomes a schedule table row.
  assert.ok(!markdown.includes("| 2026-10-19 |"));
  const [header, ...rows] = csvRecords(csv);
  const archived = rows.find((row) => row[0].startsWith("historical research"));
  assert.ok(archived);
  // Every exported record carries the same number of columns as the header.
  assert.equal(archived.length, header.length);
  // No date, no day type, no drive estimate: historical research cannot read as a booked day.
  assert.equal(archived[1], "");
  assert.equal(archived[2], "");
  assert.equal(archived[6], "");
  assert.equal(archived[7], "");
  assert.ok(archived[0].includes("market outside this route"));
  assert.ok(archived[0].includes("not a route row"));
  assert.ok(archived[3].includes("Archived | City"));
  assert.ok(archived[9].includes("Capacity too small for this tour @SUM(A1)"));
  assert.ok(archived[10].includes("not a booking"));
  assert.ok(archived[18].includes("120 seated =1+1"));
  assert.ok(archived[26].includes("00000000-0000-4000-8000-0000000000bb"));
  // Live schedule rows keep their shape and never absorb historical content.
  const live = rows.find((row) => row[0] === "feasible estimate");
  assert.ok(live);
  assert.equal(live.length, header.length);
  assert.ok(!live.some((cell) => cell.includes("Capacity too small for this tour")));
  // Formula-prefixed user text inside historical research is neutralized like every other cell.
  fixture.archivedResearch[0].name = "=cmd|' /C calc'!A0";
  assert.ok(exportCsv(fixture).includes(`"'=cmd|' /C calc'!A0"`));
});

test("orphan notes for earlier candidates of a live market stay exported and are distinguished from live research", () => {
  const fixture = plan();
  // Same market id as the live stop: an earlier candidate whose review was lost
  // when the market returned with a different candidate set.
  const orphan = fixture.archivedResearch[0];
  orphan.id = "synthetic-city";
  orphan.name = "Synthetic | City";
  orphan.venueDecisions = [];
  const markdown = exportMarkdown(fixture), csv = exportCsv(fixture);
  // The record is not hidden merely because its market is live.
  assert.ok(markdown.includes("## Historical research — user notes outside current research"));
  assert.ok(markdown.includes("EARLIER CANDIDATES OF A CURRENT MARKET"));
  assert.ok(markdown.includes("The market itself is a current stop"));
  assert.ok(markdown.includes("example.invalid/archived-room"));
  assert.ok(markdown.includes("120 seated =1+1"));
  // Parentheses are Markdown-escaped like every other exported string.
  assert.ok(markdown.includes("Archived Room =SUM\\(A1\\)"));
  // It is still clearly outside the live candidate research and the itinerary.
  assert.ok(markdown.indexOf("## Historical research") > markdown.indexOf("### Synthetic \\| City<br>&lt;script&gt;"));
  assert.ok(!markdown.includes("| 2026-10-19 |"));
  const [header, ...rows] = csvRecords(csv);
  const archived = rows.find((row) => row[0].startsWith("historical research"));
  assert.ok(archived);
  assert.equal(archived.length, header.length);
  assert.ok(archived[0].includes("earlier candidates of a current market"));
  assert.ok(archived[10].includes("The market is a current stop"));
  assert.equal(archived[1], "");
  assert.equal(archived[6], "");
  assert.ok(archived[18].includes("120 seated =1+1"));
  assert.equal(archived[26], "[]");
  // The live stop row is unchanged and carries none of the orphan note text.
  const live = rows.find((row) => row[0] === "feasible estimate");
  assert.ok(live);
  assert.ok(!live.some((cell) => cell.includes("120 seated")));
});

test("forgetting historical research leaves no trace of its notes while keeping live decisions", () => {
  const fixture = plan();
  fixture.archivedResearch = [];
  const markdown = exportMarkdown(fixture), csv = exportCsv(fixture);
  assert.ok(!markdown.includes("Historical research"));
  assert.ok(!csv.includes("historical research"));
  assert.ok(!markdown.includes("example.invalid/archived-room") && !csv.includes("example.invalid/archived-room"));
  // Current-stop judgments are untouched.
  assert.ok(markdown.includes("00000000-0000-4000-8000-0000000000aa"));
  assert.ok(csv.includes("00000000-0000-4000-8000-0000000000aa"));
});

test("forgetting orphan notes of a live market removes only the historical record", () => {
  const fixture = plan();
  fixture.archivedResearch[0].id = "synthetic-city";
  fixture.archivedResearch[0].venueDecisions = [];
  const before = exportCsv(fixture);
  assert.ok(before.includes("120 seated =1+1"));
  fixture.archivedResearch = [];
  const markdown = exportMarkdown(fixture), csv = exportCsv(fixture);
  assert.ok(!markdown.includes("Historical research"));
  assert.ok(!csv.includes("120 seated =1+1"));
  // The live stop, its route row and its own judgments are unchanged.
  assert.ok(csv.includes("feasible estimate"));
  assert.ok(csv.includes("00000000-0000-4000-8000-0000000000aa"));
  assert.ok(markdown.includes("00000000-0000-4000-8000-0000000000aa"));
});

test("historical research survives an infeasible revision and keeps its own boundary", () => {
  const fixture = plan();
  fixture.schedule.feasible = false;
  const markdown = exportMarkdown(fixture), csv = exportCsv(fixture);
  assert.ok(markdown.includes("Historical research"));
  assert.ok(markdown.includes("Capacity too small for this tour"));
  assert.ok(csv.includes("Capacity too small for this tour"));
  assert.ok(csv.includes("historical research"));
  assert.ok(csv.includes('"infeasible"'));
});

test("notes-only historical research exports its sourced checks without inventing judgments or rows", () => {
  const fixture = plan();
  fixture.archivedResearch[0].venueDecisions = [];
  const markdown = exportMarkdown(fixture), csv = exportCsv(fixture);
  // Notes-only records still surface: a check with no judgment is real user research.
  assert.ok(markdown.includes("## Historical research — user notes outside current research"));
  assert.ok(markdown.includes("Archived \\| City<br>&lt;script&gt;"));
  assert.ok(markdown.includes("USER-SOURCED CHECKS"));
  assert.ok(markdown.includes("120 seated =1+1"));
  assert.ok(!markdown.includes("USER VENUE JUDGMENTS (from an earlier revision"));
  const records = csvRecords(csv);
  const archived = records.find((row) => row[0].startsWith("historical research"));
  assert.ok(archived);
  assert.equal(archived.length, records[0].length);
  assert.ok(archived[18].includes("120 seated =1+1"));
  assert.equal(archived[26], "[]");
});

test("recipient copy guard rejects audit dumps, prices and tag dumps but accepts a sponsor-facing paragraph", () => {
  const facts: Fact[] = [
    { id: "f1", label: "Headliner", value: "Synthetic Artist", kind: "qloo", evidence: [] },
    { id: "f2", label: "Qloo describes the seed audience with this tag (not demonstrated shared taste)", value: "Indie Rock", kind: "qloo", evidence: [] },
    { id: "f3", label: "Qloo describes the seed audience with this tag (not demonstrated shared taste)", value: "Vinyl", kind: "qloo", evidence: [] },
    { id: "f4", label: "Qloo describes the seed audience with this tag (not demonstrated shared taste)", value: "Documentary", kind: "qloo", evidence: [] },
    { id: "f5", label: "Qloo describes the seed audience with this tag (not demonstrated shared taste)", value: "Film Festival", kind: "qloo", evidence: [] },
    { id: "f6", label: "Qloo describes the seed audience with this tag (not demonstrated shared taste)", value: "Public Radio", kind: "qloo", evidence: [] },
  ];
  const good = [{ text: "We propose a small listening station for {{f1}} fans in Philadelphia, subject to venue permission.", factIds: ["f1"], where: "activationIdea" }];
  assert.deepEqual(recipientCopyIssues(good, facts), []);
  const bad = [
    { text: "E3 shows affinity 0.812 per the ledger.", factIds: ["f1"], where: "supportRequested" },
    { text: "A cash support of $2,500 would help.", factIds: ["f1"], where: "nextStep" },
    { text: "Tags: {{f2}}, {{f3}}, {{f4}}, {{f5}}, {{f6}}.", factIds: ["f2", "f3", "f4", "f5", "f6"], where: "prospectiveValue" },
  ];
  const issues = recipientCopyIssues(bad, facts);
  assert.equal(issues.length, 3);
});

test("Markdown safely escapes table cells and preserves real evidence", () => {
  const markdown = exportMarkdown(plan());
  assert.ok(markdown.includes("Synthetic \\| City<br>&lt;script&gt;"));
  assert.ok(!markdown.includes("<script>"));
  assert.ok(markdown.includes("/v2/insights"));
  assert.ok(markdown.includes("2026-10-20T00:00:00Z"));
  assert.ok(markdown.includes("insufficient evidence"));
  assert.ok(markdown.includes("Review contract") && markdown.includes("Global warning"));
});

test("infeasible exports refuse even stale schedule rows", () => {
  const fixture = plan();
  fixture.schedule.feasible = false;
  fixture.schedule.extraDays = 3;
  fixture.schedule.suggestions = ["Needs 3 more days."];
  const markdown = exportMarkdown(fixture), csv = exportCsv(fixture);
  assert.ok(markdown.includes("INFEASIBLE"));
  assert.ok(markdown.includes("Needs 3 more days"));
  assert.ok(!markdown.includes("| Date (UTC) |"));
  assert.ok(!markdown.includes(fixture.schedule.rows[0].venue));
  assert.ok(!csv.includes(fixture.schedule.rows[0].venue));
  assert.ok(csv.includes('"infeasible"'));
  assert.ok(csv.includes("Needs 3 more days"));
  assert.ok(csv.includes("/entities"));
  assert.ok(csv.includes("synthetic-artist"));
  // A stale plan cannot silently drop audit judgments from the export either.
  assert.ok(markdown.includes("00000000-0000-4000-8000-0000000000aa"));
  assert.ok(csv.includes("00000000-0000-4000-8000-0000000000aa"));
});

test("recipient proposal export separates sponsor copy from the audit ledger", () => {
  const fixture = brief();
  const recipient = exportBriefMarkdown(fixture);
  assert.ok(!recipient.includes("<script>"));
  assert.ok(recipient.includes("&lt;script&gt;"));
  assert.ok(recipient.includes("Synthetic subject") && recipient.includes("Draft contact text"));
  // Proposal copy must not carry the ledger, source labels or warning list.
  assert.ok(!recipient.includes("Verify availability"));
  assert.ok(!recipient.includes("/v2/insights"));
});

test("evidence appendix keeps every fact, citation, warning and timestamp", () => {
  const fixture = brief();
  const appendix = exportBriefEvidenceMarkdown(fixture, plan());
  for (const fact of fixture.facts) {
    for (const value of [fact.id, fact.label, fact.value]) assert.ok(appendix.includes(value));
    for (const source of fact.evidence) {
      assert.ok(appendix.includes(source.endpoint));
      assert.ok(appendix.includes(source.fetchedAt));
    }
  }
  for (const warning of fixture.warnings) assert.ok(appendix.includes(warning));
  assert.ok(appendix.includes(fixture.emailSubject) && appendix.includes(fixture.emailBody));
  assert.ok(!appendix.includes("<script>"));
});

test("brief exports treat injected HTML as data in every section and the email", () => {
  const fixture = brief();
  fixture.emailBody = "<img src=x onerror=alert(1)>";
  fixture.emailSubject = "</script><script>alert(1)</script>";
  fixture.sections[1].text = "<iframe src=\"https://example.invalid\">";
  fixture.facts[0].value = "<svg onload=alert(1)>";
  for (const output of [exportBriefMarkdown(fixture), exportBriefEvidenceMarkdown(fixture, plan())]) {
    assert.ok(!/<(?:script|img|iframe|svg)/i.test(output));
    assert.ok(output.includes("&lt;"));
  }
  // Evidence content is preserved, just escaped.
  const appendixValue = exportBriefEvidenceMarkdown(fixture);
  assert.ok(appendixValue.includes("&lt;svg") && appendixValue.includes("onload"));
});

function checkedVenue(fixture: TourPlan): Place {
  const venue: Place = { id: "00000000-0000-4000-8000-0000000000cc", name: "Checked Hall <b>", lat: null, lon: null, affinity: null, address: "", neighborhood: "", website: "",
    tags: [], explainability: {}, evidence: fixture.stops[0].evidence[0] };
  const stop = fixture.stops[0];
  stop.venues = [venue];
  stop.selectedVenueId = venue.id;
  const note = (field: Confirmation["field"], forDate: string | null, needsReconfirmation: boolean, value: string): Confirmation =>
    ({ entityId: venue.id, field, value, sourceUrl: `https://example.invalid/${field}-${value.length}`, checkedAt: "2026-10-20T00:00:00Z", forDate, needsReconfirmation });
  stop.confirmations = [
    note("capacity", null, false, "450 seated"),
    note("availability", "2026-10-22", false, "Open on the show date"),
    note("availability", null, false, "Generally open <img src=x>"),
    note("fee", "2026-10-23", false, "Flat fee quoted for another date"),
    note("operating", null, true, "Open, before the route changed"),
  ];
  return venue;
}

test("printed and exported check states agree with venue review, including date and reconfirmation staleness", () => {
  const fixture = plan();
  const venue = checkedVenue(fixture);
  const { markets, checks } = venueResearch(fixture);
  const review = venueReview(fixture, fixture.stops[0], venue);
  const printed = markets.find((market) => market.id === fixture.stops[0].id)!.venues.find((item) => item.entityId === venue.id)!;
  assert.ok(printed.selected);
  // The same notes count as current in the dossier and in the Day Sheet.
  assert.deepEqual(printed.checks.filter((check) => check.status === "current").map((check) => check.note), review.currentNotes);
  assert.deepEqual(printed.missing.map((field) => checkNames[field]), review.missingChecks);
  // An undated availability note, a note for another date and a flagged note are never current.
  const byValue = new Map(checks.map((check) => [check.note.value, check]));
  assert.equal(byValue.get("450 seated")!.status, "current");
  assert.equal(byValue.get("Open on the show date")!.status, "current");
  assert.equal(byValue.get("Generally open <img src=x>")!.status, "not_current");
  assert.equal(byValue.get("Flat fee quoted for another date")!.status, "not_current");
  assert.equal(byValue.get("Open, before the route changed")!.status, "reconfirm");
  // Markdown carries the same register ID, source URL and stale state for each check, escaped.
  const markdown = exportMarkdown(fixture);
  for (const check of checks) {
    const line = markdown.split("\n").find((item) => item.includes(`${check.id};`) && item.includes(check.note.sourceUrl.replace(/([_()#!|])/g, "\\$1")));
    assert.ok(line, check.id);
    if (check.status !== "current") assert.ok(/NOT CURRENT|RECONFIRMATION REQUIRED/.test(line));
  }
  assert.ok(!markdown.includes("<img") && markdown.includes("&lt;img"));
});

test("check register lists every live and historical note once and keeps missing checks explicit", () => {
  const fixture = plan();
  checkedVenue(fixture);
  // A selected venue with no notes must still report all four checks missing.
  const bare: Place = { ...fixture.stops[0].venues[0], id: "00000000-0000-4000-8000-0000000000dd", name: "Unchecked Room" };
  fixture.stops[0].venues.push(bare);
  let { markets, checks } = venueResearch(fixture);
  const all = [...fixture.stops.flatMap((stop) => stop.confirmations), ...fixture.archivedResearch.flatMap((market) => market.confirmations)];
  assert.equal(checks.length, all.length);
  assert.deepEqual(new Set(checks.map((check) => check.note)), new Set(all));
  assert.equal(new Set(checks.map((check) => check.id)).size, checks.length);
  // Historical notes are marked historical and keep their reconfirmation flag.
  const archived = checks.filter((check) => check.historical);
  assert.deepEqual(archived.map((check) => check.note), fixture.archivedResearch[0].confirmations);
  assert.ok(archived.every((check) => check.status === "reconfirm"));
  // A dated note for a market outside the route has no show date to apply to.
  Object.assign(fixture.archivedResearch[0].confirmations[0], { needsReconfirmation: false, forDate: "2026-10-22" });
  assert.equal(venueResearch(fixture).checks.find((check) => check.historical)!.status, "not_current");
  // An undated check cannot be current for a market outside this route either.
  Object.assign(fixture.archivedResearch[0].confirmations[0], { field: "capacity", forDate: null });
  assert.equal(venueResearch(fixture).checks.find((check) => check.historical)!.status, "not_current");
  // The archived live-stop judgment without a returned candidate is kept and flagged.
  const live = markets.find((market) => !market.historical)!;
  assert.ok(live.venues.find((venue) => venue.entityId === "00000000-0000-4000-8000-0000000000aa")!.archived);
  fixture.stops[0].selectedVenueId = bare.id;
  ({ markets, checks } = venueResearch(fixture));
  const unchecked = markets.find((market) => !market.historical)!.venues.find((venue) => venue.entityId === bare.id)!;
  assert.ok(unchecked.selected);
  assert.deepEqual(unchecked.checks, []);
  assert.equal(unchecked.missing.length, Object.keys(checkNames).length);
});

test("evidence appendix email references are exact-match only and rebuild the email losslessly", () => {
  const fixture = brief();
  fixture.emailBody = "Hello team,\n\nA synthetic draft\n\nUser selection, not a booking\n\n\nUser selection, not a booking.\r\n\r\nConfirm interest\n \nThanks.";
  const parts = emailParts(fixture);
  assert.equal(parts.map((part) => part.text + part.separator).join(""), fixture.emailBody);
  assert.deepEqual(parts.map((part) => part.sameAs), [null, "summary", 0, null, 1, null]);
  // Replacing each reference with the copy it names reproduces the email byte for byte.
  const rebuilt = parts.map((part) => (part.sameAs === null ? part.text : part.sameAs === "summary" ? fixture.summary : fixture.sections[part.sameAs].text) + part.separator).join("");
  assert.equal(rebuilt, fixture.emailBody);
  // A near match (trailing period) stays verbatim.
  assert.equal(parts[3].text, "User selection, not a booking.");
});

test("fact grouping and the source register keep every fact ID, kind, source and request parameter", () => {
  const fixture = brief();
  const tagSource = { endpoint: "/v2/tags", params: { "filter.tag.types": "urn:tag:keyword", "signal.interests.entities": "a,b,c" }, fetchedAt: "2026-10-20T01:02:03.456Z", cached: false };
  const label = "Qloo describes the seed audience with this tag (not demonstrated shared taste)";
  fixture.facts.push(
    { id: "tag_1", label, value: "Introspective", kind: "qloo", evidence: [tagSource] },
    { id: "tag_2", label, value: "Intimate", kind: "qloo", evidence: [tagSource] },
    { id: "tag_3", label, value: "Introspective", kind: "qloo", evidence: [tagSource] },
    { id: "tag_4", label, value: "Introspective", kind: "user", evidence: [] },
  );
  const fixturePlan = plan();
  const sources = briefSources(fixture, fixturePlan);
  const labels = new Map(sources.map((source) => [evidenceText(source.evidence), source.label]));
  const groups = factGroups(fixture.facts, labels);
  const rows = groups.flatMap((group) => group.rows.map((row) => ({ ...row, label: group.label })));
  // Every fact appears exactly once, with its own label, value, kind and source labels.
  assert.deepEqual(rows.flatMap((row) => row.ids).sort(), fixture.facts.map((fact) => fact.id).sort());
  for (const fact of fixture.facts) {
    const row = rows.find((item) => item.ids.includes(fact.id))!;
    assert.deepEqual([row.label, row.value, row.kind, row.sources], [fact.label, fact.value, fact.kind, fact.evidence.map((evidence) => labels.get(evidenceText(evidence)))]);
  }
  // Only identical value, kind and sources share a row.
  assert.deepEqual(rows.find((row) => row.ids.includes("tag_1"))!.ids, ["tag_1", "tag_3"]);
  assert.deepEqual(rows.find((row) => row.ids.includes("tag_4"))!.ids, ["tag_4"]);
  // Each register entry is the original request object, linked to the facts that cite it.
  const register = new Map(sources.map((source) => [evidenceText(source.evidence), source]));
  assert.deepEqual(register.get(evidenceText(tagSource))!.evidence, tagSource);
  assert.deepEqual(register.get(evidenceText(tagSource))!.factIds, ["tag_1", "tag_2", "tag_3"]);
  for (const seed of fixturePlan.seedEvidence) assert.ok(register.get(evidenceText(seed))!.audienceIdentity);
  assert.equal(sources.length, new Set([...fixture.facts.flatMap((fact) => fact.evidence), ...fixturePlan.seedEvidence].map(evidenceText)).size);
});

test("every Markdown table keeps one separator cell per header cell so GFM renders it as a table", () => {
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).length;
  const lines = exportMarkdown(plan()).split("\n");
  let tables = 0;
  lines.forEach((line, index) => {
    if (!/^\|( --- \|)+$/.test(line.trim())) return;
    tables++;
    assert.equal(cells(line), cells(lines[index - 1]), `separator under "${lines[index - 1]}"`);
    for (let row = index + 1; row < lines.length && lines[row].startsWith("|"); row++) assert.equal(cells(lines[row]), cells(line));
  });
  assert.ok(tables > 0);
});

test("biographical checks remain audit context without falsely sourcing headliner or anchor facts", () => {
  const fixturePlan = plan(), fixture = brief();
  const identity = fixturePlan.seedEvidence[0];
  const check = { provider: "wikidata" as const, endpoint: "https://www.wikidata.org/w/api.php", params: { ids: "Q1" }, fetchedAt: "2026-10-23T00:00:00Z", cached: false };
  fixturePlan.seedEvidence.push(check);
  fixturePlan.anchors = [{ ...fixturePlan.headliner, id: "synthetic-anchor", name: "Synthetic Anchor" }];
  const sponsor = { entity: { ...fixturePlan.headliner, id: "synthetic-brand", type: "urn:entity:brand" }, rank: 1,
    fit: { score: null, baseScore: 0.5, placeAffinity: null, status: "insufficient_evidence" as const, observedPlaces: 0, totalPlaces: 0, warnings: [] },
    anchorDelta: null, explainability: {}, activationSpots: [], placeAffinities: [], evidence: [identity] };
  fixture.facts = briefFacts(fixturePlan, sponsor, [], [], identity);
  assert.deepEqual(fixture.facts.find((fact) => fact.id === "headliner_name")!.evidence, [identity]);
  assert.deepEqual(fixture.facts.find((fact) => fact.id === "anchor_1")!.evidence, [identity]);
  const sources = briefSources(fixture, fixturePlan);
  const biography = sources.find((entry) => entry.evidence.provider === "wikidata")!;
  assert.deepEqual(biography.factIds, []);
  assert.equal(biography.audienceIdentity, false);
  assert.equal(biography.performanceCheck, true);
});
