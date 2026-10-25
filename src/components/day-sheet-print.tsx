"use client";

import type { TourPlan, TourType } from "@/lib/contracts";
import { formatTimestamp, SPONSOR_CHECK_SCOPE, sponsorCheckRecords, venueResearch, type UserCheckStatus } from "@/lib/export";
import { orphanSponsorCheckNote } from "@/lib/sponsor-check";
import { checkNames, decisionLabels } from "@/lib/venue-review";
import { DailyDriveChart, MarketCards, PrintMasthead, RouteMetrics, RouteOrderChart } from "./tour-visuals";
import "./day-sheet-print.css";

const modeLabels: Record<TourType, string> = { music: "Music", standup: "Stand-up", podcast: "Live podcast" };
const statusLabels: Record<UserCheckStatus, string> = { current: "current", reconfirm: "reconfirmation required", not_current: "not current" };
const checkCount = Object.keys(checkNames).length;

// The printed Day Sheet: itinerary, the user's venue judgments with their
// check references and effective check state, historical research, and a
// register of the public pages behind each user-sourced check. Missing checks
// are named; nothing is shown as verified that the user did not record.
export default function DaySheetPrint({ plan }: { plan: TourPlan }) {
  const warnings = [...new Set([...plan.warnings, ...plan.schedule.warnings, ...plan.schedule.rows.flatMap((row) => row.warnings)])];
  const { markets, checks } = venueResearch(plan);
  const current = markets.filter((market) => !market.historical);
  const historical = markets.filter((market) => market.historical);
  return <>
    <PrintMasthead kind="Tour Day Sheet" title={plan.headliner.name}
      meta={[modeLabels[plan.input.tourType], `${plan.input.startDate} — ${plan.input.endDate}`, `from ${plan.input.startCity}`, `anchors: ${plan.anchors.map((anchor) => anchor.name).join(", ") || "headliner only"}`, `revision ${plan.revision}`, `generated ${formatTimestamp(plan.generatedAt)}`]}
      status="Estimate · not a booking" />
    <RouteMetrics plan={plan} />
    <div className="chart-grid"><RouteOrderChart plan={plan} /><DailyDriveChart plan={plan} /></div>
    <MarketCards plan={plan} markets={current} />

    <h2>Itinerary</h2>
    <table><thead><tr><th>Date</th><th>Market / day</th><th>Venue candidate</th><th>Support</th><th>Sponsor</th><th>Drive estimate</th><th>Notes</th></tr></thead>
      <tbody>{plan.schedule.rows.map((row, index) => {
        const venue = row.kind === "show" ? current.find((market) => market.id === row.cityId)?.venues.find((item) => item.selected) : undefined;
        return <tr key={index}>
          <td>{row.date}<br />{new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(`${row.date}T00:00:00Z`))}</td>
          <td>{row.kind === "show" ? row.city : `${row.kind} day`}</td>
          <td>{row.venue || "—"}{row.neighborhood && <small><br />{row.neighborhood}</small>}</td>
          <td>{row.support.join("; ") || "—"}</td><td>{row.sponsors.join("; ") || "—"}</td>
          <td>{Math.round(row.driveKm)} km<br />{row.driveHours.toFixed(1)} h</td>
          <td>{row.kind !== "show" ? row.reason : "Tentative selection."}{venue && ` Venue checks: ${checkCount - venue.missing.length} of ${checkCount} current.`}{row.warnings.length > 0 && ` See notes ${row.warnings.map((warning) => warnings.indexOf(warning) + 1).join(", ")}.`}</td>
        </tr>;
      })}</tbody></table>

    <h2>Venue research — user judgments and checks, not bookings</h2>
    <p className="print-historical-note">Written by the planner&apos;s user. Shortlist, hold and exclude are research decisions, not selections of record. Checks are user-sourced from public pages and not independently verified. A check is current only when it is not marked for reconfirmation and applies to this route&apos;s show date; U numbers refer to the check register below.</p>
    {current.map((market) => <section key={market.id} className="day-research-market">
      <h3>{market.name} · show {market.showDate ?? "not scheduled in this route"}</h3>
      {market.venues.length ? market.venues.map((venue) => <p key={venue.entityId}>
        <strong>{venue.name}{venue.selected && " (working venue candidate)"}:</strong>{" "}
        {venue.decision ? <>{decisionLabels[venue.decision.status]}, decided {formatTimestamp(venue.decision.decidedAt)}. {venue.decision.reason}{venue.decision.needsReview && " Context changed: review required."}</> : "No judgment recorded."}
        {venue.archived && " Archived: not a current returned candidate."}
        <br /><span className="day-research-checks">Checks: {venue.checks.length ? venue.checks.map((check) => `${check.id} ${checkNames[check.note.field]}, ${statusLabels[check.status]}`).join("; ") : "none recorded"}. Missing current checks: {venue.missing.map((field) => checkNames[field]).join(", ") || "none"}.</span>
      </p>) : <p>No venue selected, and no judgments or checks recorded.</p>}
    </section>)}

    {historical.length > 0 && <>
      <h2>Historical research — user notes outside current research, not a route</h2>
      <p className="print-historical-note">Kept from earlier revisions. A market that is not in this route is labeled as such; earlier candidates of a market that is still a stop are listed separately from that market&apos;s live research above. These are the user&apos;s own records, not stops, schedule rows, provider evidence or bookings, and old venue selections are not restored.</p>
      {historical.map((market) => <section key={market.id} className="print-historical-record">
        <h3>{market.name} · {market.live ? "earlier candidates of a current market, not in its current candidate set" : "market not in this route"}</h3>
        {market.venues.map((venue) => <p key={venue.entityId}>
          <strong>{venue.name}:</strong>{" "}
          {venue.decision ? <>{decisionLabels[venue.decision.status]}, decided {formatTimestamp(venue.decision.decidedAt)}. {venue.decision.reason}{venue.decision.needsReview && " Context changed: review required."} Historical user judgment, not a booking.</> : "No judgment recorded."}
          {venue.checks.length > 0 && <><br /><span className="day-research-checks">Checks: {venue.checks.map((check) => `${check.id} ${checkNames[check.note.field]}, ${statusLabels[check.status]}`).join("; ")}.</span></>}
        </p>)}
      </section>)}
    </>}

    {checks.length > 0 && <>
      <h2>User-sourced check register</h2>
      <p className="print-historical-note">Values the user recorded from these public pages. They are not Qloo data and are not independently verified.</p>
      <div className="day-check-register">{checks.map((check) => <p key={check.id}>
        <strong>{check.id}</strong> {check.marketName}{check.historical && " (historical)"} · {check.placeName} · {checkNames[check.note.field]}: {check.note.value} · <a href={check.note.sourceUrl}>{check.note.sourceUrl}</a> · checked {formatTimestamp(check.note.checkedAt)} · applies {check.note.forDate ?? "to no specific date"} · {statusLabels[check.status]}: {check.reason}.
      </p>)}</div>
    </>}
    {plan.sponsorChecks.length > 0 && <>
      <h2>Sponsor purpose checks — user research</h2>
      <p className="print-historical-note">{SPONSOR_CHECK_SCOPE}</p>
      <div className="day-check-register">{sponsorCheckRecords(plan).map(({ check, brandName, current, savedPurpose, status, purpose }) => <p key={`${check.brandId}|${check.purpose}`}>
        <strong>{brandName}</strong>{current ? "" : ` (${orphanSponsorCheckNote})`} · {purpose}{savedPurpose ? " (saved purpose)" : ""} · {status} · offering: {check.offering} · {check.reason} · <a href={check.sourceUrl}>{check.sourceUrl}</a> · checked {formatTimestamp(check.checkedAt)}.
      </p>)}</div>
    </>}

    <h2>Operating notes and limits</h2>
    <ol className="print-notes">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ol>
    <h2>Source record</h2>
    <div className="print-sources">
      {plan.stops.map((stop) => <p key={stop.id}><strong>{stop.name}:</strong> {[...new Set(stop.evidence.map((source) => source.endpoint))].join(", ")}. Last source fetch: {stop.evidence.map((source) => source.fetchedAt).sort().at(-1) ?? "unavailable"}.</p>)}
      {plan.seedEvidence.map((evidence, index) => <p key={index}><strong>Audience identity / eligibility ({evidence.provider === "wikidata" ? "Wikidata" : "Qloo"}):</strong> {evidence.endpoint} · {JSON.stringify(evidence.params)} · fetched {evidence.fetchedAt}.</p>)}
      {[...new Map(plan.stops.flatMap((stop) => stop.supportGroups.flatMap((group) => group.candidates.flatMap((candidate) => candidate.evidence))).filter((entry) => entry.provider === "wikidata").map((entry) => [JSON.stringify([entry.params, entry.fetchedAt]), entry])).values()].map((entry, index) => <p key={`eligibility-${index}`}><strong>Support biographical check (Wikidata P570):</strong> {entry.params.ids} · fetched {entry.fetchedAt}. No recorded death is not proof of current activity or availability.</p>)}
      <p>Per-request provenance is retained in the Markdown / CSV export. These are unconfirmed research choices, not bookings or partnerships.</p>
    </div>
  </>;
}
