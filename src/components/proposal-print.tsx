"use client";

import type { Brief, TourPlan } from "@/lib/contracts";
import { briefSources, briefSponsorCheck, briefUserSources, emailParts, evidenceText, factGroups, formatTimestamp, RECIPIENT_BOUNDARY, SPONSOR_CHECK_SCOPE } from "@/lib/export";
import { orphanSponsorCheckNote, unreviewedSponsorWarning } from "@/lib/sponsor-check";
import { proposalTypeCopy } from "@/lib/proposal-preferences";
import { scheduledShowDate } from "@/lib/venue-review";
import { PrintMasthead, routeStops } from "./tour-visuals";
import "./proposal-print.css";

interface Props { brief: Brief; evidenceOnly: boolean; plan?: TourPlan | null }

// Plan values the recipient already reads in the copy, set out as a glance row.
// Only shown when the plan is the revision the proposal was written from.
function ProposalGlance({ brief, plan }: { brief: Brief; plan: TourPlan }) {
  const focus = brief.proposalType === "on_site_activation" ? plan.stops.find((stop) => stop.id === plan.input.proposalPreferences.focusCityId) : undefined;
  const showDate = focus ? scheduledShowDate(plan, focus.id) : null;
  const stops = routeStops(plan);
  const items = [
    { label: plan.input.tourType === "music" ? "Artist" : plan.input.tourType === "standup" ? "Comedian" : "Podcast", value: plan.headliner.name },
    focus ? { label: "Market", value: showDate ? `${focus.name} · ${showDate}` : focus.name } : { label: "Route", value: `${stops.length} markets · ${stops.map((stop) => stop.name).join(" → ")}` },
    { label: "Proposal", value: proposalTypeCopy[brief.proposalType].label },
  ];
  return <dl className="proposal-glance">{items.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>;
}

// Recipient print carries the proposal, while email has its own tab and copy
// action. The evidence appendix is lossless: an email paragraph that exactly
// equals printed recipient copy is referenced instead of repeated, facts with
// the same label share one entry, and every source keeps all its parameters.
export default function ProposalPrint({ brief, evidenceOnly, plan }: Props) {
  if (!evidenceOnly) return <>
    <PrintMasthead kind="Sponsor proposal" title={brief.title} meta={[`revision ${brief.revision}`, `prepared ${formatTimestamp(brief.createdAt)}`]} status="Draft · not sent" />
    {plan && plan.revision === brief.revision && <ProposalGlance brief={brief} plan={plan} />}
    <p className="proposal-lead">{brief.summary}</p>
    <div className="proposal-sections">{brief.sections.map((section, index) => <section key={index} className={index === brief.sections.length - 1 ? "proposal-next" : undefined}>
      <h2><span>{index + 1}</span>{section.heading}</h2><p>{section.text}</p>
    </section>)}</div>
    <p className="print-boundary">{RECIPIENT_BOUNDARY}</p>
  </>;

  const sources = briefSources(brief, plan);
  const groups = factGroups(brief.facts, new Map(sources.map((source) => [evidenceText(source.evidence), source.label])));
  const parts = emailParts(brief);
  const sponsorCheck = plan ? briefSponsorCheck(brief, plan) : null;
  const userSources = briefUserSources(brief);
  return <>
    <PrintMasthead kind="Evidence appendix" title={brief.title} meta={[`revision ${brief.revision}`, `created ${formatTimestamp(brief.createdAt)}`]} status="Audit record · not sent" />
    <p className="evidence-meta">Full audit view of the saved proposal draft · revision {brief.revision} · plan {brief.planId} · brand {brief.brandId} · created {formatTimestamp(brief.createdAt)} · model {brief.model} · proposal type {brief.proposalType}.</p>
    {plan && <p className="evidence-meta">Headliner {plan.headliner.name} ({plan.headliner.id}) · anchors {plan.anchors.map((anchor) => `${anchor.name} (${anchor.id})`).join(", ") || "none"} · {plan.input.tourType} tour {plan.input.startDate} – {plan.input.endDate} (UTC) from {plan.input.startCity} · requested capacity {plan.input.capacity} (planning target) · schedule feasible: {String(plan.schedule.feasible)}.</p>}
    <h2>Recipient copy</h2>
    <p className="evidence-copy">{brief.summary}</p>
    {brief.sections.map((section, index) => <section key={index}><h3>Section {index + 1}: {section.heading}</h3><p className="evidence-copy">{section.text}</p><p className="print-cited">Cited facts: {section.factIds.join(", ") || "none — conditional proposal wording"}</p></section>)}
    <h3>Draft email</h3>
    <p><strong>Subject:</strong> {brief.emailSubject}</p>
    {parts.some((part) => part.sameAs !== null) && <p className="print-cited">A bracketed line stands for a paragraph that is character-for-character identical to the recipient copy it names. To rebuild the email exactly, replace each bracketed line with that text; paragraph order and spacing are as printed.</p>}
    <p className="email-text evidence-email">{parts.map((part, index) => <span key={index}>{part.sameAs === null ? part.text
      : <span className="evidence-email-ref">[Identical to {part.sameAs === "summary" ? "the summary paragraph" : `section ${part.sameAs + 1}, “${brief.sections[part.sameAs].heading}”`}]</span>}{part.separator}</span>)}</p>
    <h2>Fact ledger</h2>
    <p className="print-cited">Facts with the same label are listed once under it. Each value names every fact ID that carries it; kind and sources are given once when they are the same for every fact under the label. “No external source” means user input or a computed value.</p>
    <div className="evidence-facts">{groups.map(({ label, rows }) => {
      const metas = rows.map((row) => `${row.kind}; ${row.sources.join(", ") || "no external source"}`);
      const shared = rows.length > 1 && metas.every((meta) => meta === metas[0]);
      return <p key={label}><strong>{label}:</strong> {rows.map((row, index) => `${row.value} (${row.ids.join(", ")}${shared ? "" : `; ${metas[index]}`})`).join("; ")}{shared && <span className="evidence-fact-meta"> · {metas[0]}</span>}</p>;
    })}</div>
    <h2>Warnings and limits</h2>
    <ol className="print-notes">{brief.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ol>
    {plan && <>
      <h2>Sponsor purpose check</h2>
      <p className="print-cited">{SPONSOR_CHECK_SCOPE}</p>
      {sponsorCheck ? <dl className="evidence-sponsor-check">
        <div><dt>Brand</dt><dd>{sponsorCheck.brandName} ({sponsorCheck.check.brandId}){sponsorCheck.current ? "" : ` · ${orphanSponsorCheckNote}`}</dd></div>
        <div><dt>Purpose</dt><dd>{sponsorCheck.purpose}</dd></div>
        <div><dt>Fit for this purpose</dt><dd>{sponsorCheck.status}</dd></div>
        <div><dt>Brand offering (user-sourced)</dt><dd>{sponsorCheck.check.offering}</dd></div>
        <div><dt>User&apos;s reason</dt><dd>{sponsorCheck.check.reason}</dd></div>
        <div><dt>Public source</dt><dd>{sponsorCheck.check.sourceUrl}</dd></div>
        <div><dt>Checked</dt><dd>{formatTimestamp(sponsorCheck.check.checkedAt)}</dd></div>
      </dl> : <p>{unreviewedSponsorWarning}</p>}
    </>}
    <h2>Source register</h2>
    {sources.length ? <>
      <table className="evidence-source-summary"><thead><tr><th>Source</th><th>Endpoint</th><th>filter.type</th><th>filter.location</th><th>Fetched</th><th>Cache</th><th>Used by</th></tr></thead>
        <tbody>{sources.map(({ label, evidence, factIds, audienceIdentity, performanceCheck }) => <tr key={label}><td>{label}<br />{evidence.provider === "wikidata" ? "Wikidata" : "Qloo"}</td><td>{evidence.endpoint}</td><td>{evidence.params["filter.type"] ?? "—"}</td><td>{evidence.params["filter.location"] ?? "—"}</td><td>{formatTimestamp(evidence.fetchedAt)}</td><td>{evidence.cached ? "cache" : "live"}</td>
          <td>{[factIds.length ? `${factIds.length} ${factIds.length === 1 ? "fact" : "facts"}` : "", audienceIdentity ? "plan audience identity" : "", performanceCheck ? "biographical eligibility only" : ""].filter(Boolean).join("; ")}</td></tr>)}</tbody></table>
      <h3>Request parameters</h3>
      <p className="print-cited">Every parameter of each request exactly as sent, with its original fetch timestamp and cache state.</p>
      <div className="evidence-source-detail">{sources.map(({ label, evidence }) => <section key={label}>
        <h4>{label} · {evidence.provider === "wikidata" ? "Wikidata" : "Qloo"} · {evidence.endpoint}</h4>
        <p>fetched {evidence.fetchedAt} · {evidence.cached ? "cache" : "live"}</p>
        <dl>{Object.entries(evidence.params).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
      </section>)}</div>
    </> : <p>No external sources: this brief used user input and computed values only.</p>}
    {userSources.map((fact) => <p key={fact.id}>User-cited public source for {fact.id.replace(/_source$/, "")} (recorded by the user; not fetched or verified by TourPulse): {fact.value}</p>)}
  </>;
}
