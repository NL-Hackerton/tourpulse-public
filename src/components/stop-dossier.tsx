"use client";

import { useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { ArrowUpRight, Check, LoaderCircle, MapPin, Plus, Sparkles } from "lucide-react";
import type { Fit, PlanAction, Place, ProposalPreferences, SponsorCheck, Stop, Tag, TourPlan } from "@/lib/contracts";
import { ScoreMeter } from "./tour-visuals";
import EvidenceDialog from "./evidence-dialog";
import ConfirmPlaceDialog from "./confirm-place-dialog";
import SponsorTagSearch from "./sponsor-tag-search";
import BriefDialog from "./brief-dialog";
import VenueDecisionDialog from "./venue-decision-dialog";
import { decisionLabels, venueReview } from "@/lib/venue-review";
import ArchivedVenueDecisions from "./archived-venue-decisions";
import ProposalPreferencesPanel from "./proposal-preferences-panel";
import { proposalPreferencesIssue, proposalTarget, proposalTypeCopy } from "@/lib/proposal-preferences";
import SponsorCheckDialog from "./sponsor-check-dialog";
import { orphanSponsorCheckNote, sponsorCheckBrandName, sponsorCheckFor, sponsorCheckLabels, sponsorDraftGate, sponsorFitUnreviewed, sponsorIsCurrent } from "@/lib/sponsor-check";
import { supportCheckText } from "@/lib/export";

// Reuses the venue decision badge colours: worth discussing reads like a shortlist, not suitable like an exclusion.
const sponsorCheckBadge: Record<SponsorCheck["status"], string> = { discuss: "shortlist", not_suitable: "exclude" };

function SponsorCheckSummary({ check }: { check: SponsorCheck }) {
  return <div className="decision-reason"><p><strong>Your reason:</strong> {check.reason}</p><p>Brand offering from the source: {check.offering}</p>
    <small>User-sourced · checked {new Date(check.checkedAt).toLocaleDateString()} · not a brand commitment</small>
    <a href={check.sourceUrl} target="_blank" rel="noopener noreferrer">Inspect public source<ArrowUpRight size={12} /></a></div>;
}

function SponsorFit({ plan, brandId, brandName, disabled, onApply }: { plan: TourPlan; brandId: string; brandName: string; disabled: boolean; onApply: Props["onApply"] }) {
  const purpose = plan.input.proposalPreferences.proposalType, purposeLabel = proposalTypeCopy[purpose].label;
  const check = sponsorCheckFor(plan, brandId);
  const [error, setError] = useState("");
  return <div className="sponsor-fit">
    <p className="anchor-comparison"><strong>Fit for saved purpose ({purposeLabel}): <span className={`decision-badge ${check ? sponsorCheckBadge[check.status] : "unreviewed"}`}>{check ? sponsorCheckLabels[check.status] : sponsorFitUnreviewed}</span></strong></p>
    {check && <SponsorCheckSummary check={check} />}
    <div className="decision-actions">
      <SponsorCheckDialog key={`${brandId}|${purpose}`} brandId={brandId} brandName={brandName} purpose={purpose} current={check} disabled={disabled} onApply={onApply} />
      {check && <button className="text-button" disabled={disabled} aria-label={`Forget fit check: ${brandName}, ${purposeLabel}`} onClick={async () => { setError(""); if (!await onApply({ type: "forget_sponsor_check", brandId, purpose })) setError("The purpose check was not removed. Review the workspace error and retry."); }}>Forget fit check</button>}
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}

function OrphanSponsorChecks({ plan, disabled, onApply }: { plan: TourPlan; disabled: boolean; onApply: Props["onApply"] }) {
  const orphans = plan.sponsorChecks.filter((check) => !sponsorIsCurrent(plan, check.brandId));
  const [error, setError] = useState("");
  if (!orphans.length) return null;
  return <section className="partner-section" aria-label="Sponsor purpose checks for brands not in current candidates">
    <h3>Purpose checks outside the current candidates</h3>
    <p className="field-hint">These brands were not returned in this revision. Your checks are kept as your research and never used for drafting until the brand returns.</p>
    {orphans.map((check) => {
      const name = sponsorCheckBrandName(plan, check.brandId), purposeLabel = proposalTypeCopy[check.purpose].label;
      return <article className="place-card" key={`${check.brandId}|${check.purpose}`} aria-label={`Sponsor purpose check for ${name}, ${purposeLabel}`}>
        <div className="place-topline"><span className="chosen-label">{orphanSponsorCheckNote}</span><span className={`decision-badge ${sponsorCheckBadge[check.status]}`}>{sponsorCheckLabels[check.status]}</span></div>
        <h3>{name}</h3><p className="place-location">{purposeLabel}</p>
        <SponsorCheckSummary check={check} />
        <div className="decision-actions"><button className="text-button" disabled={disabled} aria-label={`Forget fit check: ${name}, ${purposeLabel}`} onClick={async () => { setError(""); if (!await onApply({ type: "forget_sponsor_check", brandId: check.brandId, purpose: check.purpose })) setError("The purpose check was not removed. Review the workspace error and retry."); }}>Forget fit check</button></div>
      </article>;
    })}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}

interface Props {
  plan: TourPlan | null; stop: Stop | undefined; canMutate: boolean; busy: string | null; reviewRequest: number;
  activeAnchor: string | null; onApply: (action: PlanAction) => Promise<boolean>;
  onDraft: () => Promise<void>; onPrintBrief: () => void; onPrintBriefEvidence: () => void;
}

function AnchorComparison({ rank, delta, hasAnchors }: { rank: number; delta: number | null; hasAnchors: boolean }) {
  if (!hasAnchors) return <p className="anchor-comparison">Headliner-only audience. No anchor comparison.</p>;
  if (delta === null || rank + delta < 1) return <p className="anchor-comparison">No comparable headliner-only rank returned.</p>;
  return <div className="anchor-comparison"><p><strong>Headliner only #{rank + delta} → with anchors #{rank}</strong><span className={`rank-shift ${delta > 0 ? "up" : delta < 0 ? "down" : "same"}`}>{delta > 0 ? `▲ ${delta}` : delta < 0 ? `▼ ${-delta}` : "no change"}</span></p><small>Whole-bundle discovery order, not predicted outcomes or an individual anchor’s effect.</small></div>;
}

function FitDetails({ fit }: { fit: Fit }) {
  return <div className={`fit-details ${fit.status}`}>
    {fit.score !== null && <ScoreMeter label="Fit" value={fit.score} muted={fit.status !== "comparable"} />}
    {fit.status !== "comparable" && <p className="fit-status">{fit.status === "sensitive" ? "Order sensitive to weighting" : "Incomplete place evidence"}</p>}
    <details><summary>Inspect taste signals</summary><dl>
      <div><dt>Exploratory heuristic (0–1)</dt><dd>{fit.score?.toFixed(3) ?? "Not available"}</dd></div>
      <div><dt>Audience rank signal (0–1)</dt><dd>{fit.baseScore.toFixed(3)}</dd></div>
      <div><dt>Mean place affinity (0–1)</dt><dd>{fit.placeAffinity?.toFixed(3) ?? "Not available"}</dd></div>
      <div><dt>Matched places</dt><dd>{fit.observedPlaces} / {fit.totalPlaces}</dd></div>
    </dl>{fit.warnings.map((warning) => <p key={warning}>{warning}</p>)}</details>
  </div>;
}

function VenueCard({ place, stop, plan, selected, disabled, activeAnchor, onApply }: { place: Place; stop: Stop; plan: TourPlan; selected: boolean; disabled: boolean; activeAnchor: string | null; onApply: Props["onApply"] }) {
  const review = venueReview(plan, stop, place);
  const excluded = review.decision?.status === "exclude";
  const date = review.showDate ?? plan.input.startDate;
  return <article className={`place-card ${selected ? "chosen" : ""} ${excluded ? "excluded" : ""}`} aria-label={`Venue candidate ${place.name} in ${stop.name}`}>
    <div className="place-topline"><span className="chosen-label">{selected ? <><Check size={12} />In working route</> : "Qloo discovery lead"}</span>{review.notes.length > 0 && <span className="decision-badge checks">{review.notes.length} sourced {review.notes.length === 1 ? "check" : "checks"}</span>}<span className={`decision-badge ${review.decision?.status ?? "unreviewed"}`}>{review.decision ? decisionLabels[review.decision.status] : "Not assessed"}</span></div>
    <h3>{place.name}</h3><p className="place-location">{place.neighborhood || place.address || "Location detail unavailable"}</p>
    {place.affinity !== null && <ScoreMeter label="Affinity" value={place.affinity} muted={excluded} />}
    {review.decision && <div className="decision-reason"><p><strong>Your decision:</strong> {review.decision.reason}</p><small>{review.decision.needsReview ? "Context changed — review this decision" : `Recorded ${new Date(review.decision.decidedAt).toLocaleDateString()}`}</small></div>}
    <details className="venue-evidence-details"><summary>Evidence and checks</summary>
      <p className="taste-reason">{review.tasteReason}</p>
      <p className="next-check"><strong>Next step</strong>{review.nextStep}</p>
      <div className="place-tags">{place.tags.slice(0, 3).map((tag) => <span key={tag}>{tag.split(":").at(-1)?.replaceAll("_", " ")}</span>)}</div>
      {activeAnchor && <p className="anchor-evidence">Selected anchor contribution: {place.explainability[activeAnchor]?.toFixed(3) ?? "Not provided"}</p>}
      {!review.notes.length && <p className="field-hint">No checks recorded.</p>}
      {review.notes.map((note, index) => <div className={`confirmed-note ${!review.currentNotes.includes(note) ? "needs-check" : ""}`} key={index}><strong>{note.field}: {note.value}</strong><small>User-sourced · checked {new Date(note.checkedAt).toLocaleDateString()}{note.forDate ? ` · applies ${note.forDate}` : ""}</small><a href={note.sourceUrl} target="_blank" rel="noopener noreferrer">Inspect public source<ArrowUpRight size={12} /></a>{!review.currentNotes.includes(note) && <small>Not current for this show date — reconfirm before using.</small>}</div>)}
    </details>
    <div className="decision-actions"><VenueDecisionDialog stop={stop} place={place} disabled={disabled} onApply={onApply} />{!selected && <button className="text-button" disabled={disabled || excluded} aria-label={`Use in working route: ${place.name} in ${stop.name}`} onClick={() => void onApply({ type: "select_venue", cityId: stop.id, venueId: place.id })}><Plus size={13} />Use in working route</button>}</div>
    <div className="place-actions">{/^https?:\/\//i.test(place.website) && <a href={place.website} target="_blank" rel="noopener noreferrer" aria-label={`Venue website for ${place.name}`} >Venue website<ArrowUpRight size={13} /></a>}</div>
    <div className="card-source-actions"><EvidenceDialog title={place.name} evidence={[place.evidence]} /><ConfirmPlaceDialog stop={stop} place={place} date={date} disabled={disabled} onApply={onApply} /></div>
  </article>;
}

export default function StopDossier({ plan, stop, canMutate, busy, reviewRequest, activeAnchor, onApply, onDraft, onPrintBrief, onPrintBriefEvidence }: Props) {
  // "Review <market>" from the route opens the venue research tab; ordinary
  // market switches keep the tab the user was working in.
  const [tab, setTab] = useState("venues");
  const [handledReview, setHandledReview] = useState(reviewRequest);
  if (handledReview !== reviewRequest) { setHandledReview(reviewRequest); setTab("venues"); }
  const [tagNames, setTagNames] = useState<Map<string, Tag>>(new Map());
  const tagList = (ids: string[]) => ids.map((id) => tagNames.get(id) ?? { id, name: id, type: "Qloo tag" });
  const currentDecisions = stop ? stop.venueDecisions.filter((decision) => stop.venues.some((venue) => venue.id === decision.entityId)) : [];
  // Preference edits stay local until saved. They survive unrelated revisions and
  // tab changes, but reset for a new plan or when the saved preferences change.
  const [preferenceEdit, setPreferenceEdit] = useState<{ planId: string; basis: string; value: ProposalPreferences } | null>(null);
  const preferenceBasis = plan ? JSON.stringify(plan.input.proposalPreferences) : "";
  const editedPreferences = plan && preferenceEdit && preferenceEdit.planId === plan.id && preferenceEdit.basis === preferenceBasis ? preferenceEdit.value : null;
  const preferencesUnsaved = editedPreferences !== null && JSON.stringify(editedPreferences) !== preferenceBasis;
  const preferenceIssue = plan && editedPreferences && preferencesUnsaved ? proposalPreferencesIssue(plan, editedPreferences) : null;
  // Drafting always uses the saved preferences of this revision, as the server does.
  const target = plan ? proposalTarget(plan) : null;
  const selectedCheck = plan?.selectedSponsorId ? sponsorCheckFor(plan, plan.selectedSponsorId) : null;
  const sponsorGate = plan?.selectedSponsorId ? sponsorDraftGate(plan, plan.selectedSponsorId) : null;
  const draftBlockedReason = !plan ? "Create a research plan first." : busy === "brief" ? "Drafting the proposal. It is saved only after the independent check passes." : !canMutate ? "Drafting is paused while inputs are changed or another change is running. Restore inputs, plan again, or wait for the current change." : !plan.schedule.feasible ? "Resolve the itinerary before drafting." : !plan.selectedSponsorId ? "Select a sponsor candidate first." : preferencesUnsaved ? "Save or discard your proposal preference edits before drafting." : target?.status === "blocked" ? target.reason : sponsorGate?.status === "blocked" ? sponsorGate.reason : null;
  async function setTag(kind: "include" | "exclude", tag: Tag | string, remove = false) {
    if (!plan || !canMutate) return;
    const id = typeof tag === "string" ? tag : tag.id;
    if (typeof tag !== "string") setTagNames((old) => new Map(old).set(id, tag));
    const include = new Set(plan.input.sponsorIncludeTags), exclude = new Set(plan.input.sponsorExcludeTags);
    const target = kind === "include" ? include : exclude;
    if (remove) target.delete(id); else { target.add(id); (kind === "include" ? exclude : include).delete(id); }
    await onApply({ type: "set_sponsor_tags", include: [...include], exclude: [...exclude] });
  }
  return <aside className="dossier-panel">
    <div className="panel-heading"><span><MapPin size={16} />Stop dossier</span></div>
    {!plan || !stop ? <div className="dossier-empty"><div className="room-illustration" aria-hidden="true"><div className="stage" /><div className="seats">{Array.from({ length: 12 }, (_, i) => <i key={i} />)}</div></div><h2>Find the right room.</h2></div> : <>
      <div className="stop-heading"><h2>{stop.name}</h2>
        <div className="decision-counts"><span><b>{currentDecisions.filter((decision) => decision.status === "shortlist").length}</b> shortlisted</span><span><b>{currentDecisions.filter((decision) => decision.status === "hold").length}</b> on hold</span><span><b>{currentDecisions.filter((decision) => decision.status === "exclude").length}</b> excluded</span></div>
        <AnchorComparison rank={stop.destinationRank} delta={stop.anchorDelta} hasAnchors={plan.anchors.length > 0} />
        <details className="market-signal-details"><summary>Inspect market evidence</summary><dl><div><dt>Qloo market rank</dt><dd>{stop.destinationRank} of {plan.candidateCities.length} queried markets</dd></div><div><dt>City Fit heuristic (0–1)</dt><dd>{stop.cityFit?.toFixed(3) ?? "Unavailable"}</dd></div><div><dt>Scene Fit heuristic (0–1)</dt><dd>{stop.sceneFit?.toFixed(3) ?? "Unavailable"}</dd></div></dl></details>
        {activeAnchor && <p className="anchor-evidence">Selected anchor contribution: {stop.explainability[activeAnchor]?.toFixed(3) ?? "Not provided"}</p>}
        <EvidenceDialog title={`${stop.name} market evidence`} evidence={stop.evidence} note="City Fit is a TourPulse heuristic. Cross-query affinity comparability has limited validation." />
      </div>
      <Tabs.Root value={tab} onValueChange={setTab}><Tabs.List className="dossier-tabs" aria-label="Candidate categories"><Tabs.Trigger value="venues">Venues</Tabs.Trigger><Tabs.Trigger value="support">Support</Tabs.Trigger><Tabs.Trigger value="sponsors">Sponsors</Tabs.Trigger></Tabs.List>
        <Tabs.Content value="venues"><div className="place-list">{stop.venues.map((place) => <VenueCard key={place.id} place={place} stop={stop} plan={plan} selected={stop.selectedVenueId === place.id} disabled={!canMutate} activeAnchor={activeAnchor} onApply={onApply} />)}{!stop.venues.length && <div className="empty-places"><h3>No matching venues</h3><p>No in-market venue was returned after widening the search. Adjust audience anchors or venue type; no substitute location was invented.</p></div>}</div>
          <ArchivedVenueDecisions key={stop.id} stop={stop} disabled={!canMutate} onApply={onApply} />
          <section className="partner-section"><h3>Around the venue</h3>{stop.partners.map((place) => <article className="partner-row" key={place.id}><label><input type="checkbox" checked={stop.selectedPartnerIds.includes(place.id)} disabled={!canMutate} onChange={(e) => void onApply({ type: "select_partner", cityId: stop.id, placeId: place.id, selected: e.target.checked })} /><span><strong>{place.name}</strong><small>{place.neighborhood || place.address}</small></span></label><EvidenceDialog title={place.name} evidence={[place.evidence]} /></article>)}{!stop.partners.length && <p className="field-hint">No nearby partner evidence is available.</p>}</section>
        </Tabs.Content>
        <Tabs.Content value="support"><div className="place-list">{stop.supportGroups.map((group) => <section className="support-group" key={group.kind}><h3>{group.kind === "artist" ? "Support act candidates" : group.kind === "comedian" ? plan.input.tourType === "podcast" ? "Guest comics" : "Opening comic candidates" : "Podcast crossovers"}</h3>{group.candidates.map((candidate) => <article className={`place-card ${stop.selectedSupportIds.includes(candidate.entity.id) ? "chosen" : ""}`} key={candidate.entity.id} aria-label={`Support candidate ${candidate.entity.name} in ${stop.name}`}><h3>{candidate.entity.name}</h3><p className="candidate-description">{candidate.entity.description}</p><p className="field-hint">{supportCheckText(candidate)}</p><FitDetails fit={candidate.fit} /><div className="place-actions"><button className="text-button" disabled={!canMutate || stop.selectedSupportIds.includes(candidate.entity.id)} aria-label={`${stop.selectedSupportIds.includes(candidate.entity.id) ? "Selected" : "Select candidate"}: ${candidate.entity.name}`} onClick={() => void onApply({ type: "select_support", cityId: stop.id, candidateId: candidate.entity.id })}>{stop.selectedSupportIds.includes(candidate.entity.id) ? <><Check size={13} />Selected</> : <><Plus size={13} />Select candidate</>}</button><EvidenceDialog title={`${candidate.entity.name} support evidence`} evidence={candidate.evidence} /></div></article>)}{!group.candidates.length && <p className="field-hint">No eligible candidates returned for this group.</p>}{group.warnings.map((warning) => <p className="dossier-warning" key={warning}>{warning}</p>)}</section>)}</div></Tabs.Content>
        <Tabs.Content value="sponsors"><details className="sponsor-filters"><summary>Brand category filters</summary><SponsorTagSearch label="Include brand category" selected={tagList(plan.input.sponsorIncludeTags)} disabled={!canMutate} onAdd={(tag) => void setTag("include", tag)} onRemove={(id) => void setTag("include", id, true)} /><SponsorTagSearch label="Exclude brand category" selected={tagList(plan.input.sponsorExcludeTags)} disabled={!canMutate} onAdd={(tag) => void setTag("exclude", tag)} onRemove={(id) => void setTag("exclude", id, true)} /></details>
          <div className="place-list">{plan.sponsors.map((sponsor) => {
            const activation = sponsor.activationSpots.find((item) => item.stopId === stop.id);
            const place = [...stop.venues, ...stop.partners].find((item) => item.id === activation?.placeId);
            return <article className={`place-card ${plan.selectedSponsorId === sponsor.entity.id ? "chosen" : ""}`} key={sponsor.entity.id} aria-label={`Sponsor candidate ${sponsor.entity.name}`}><h3>{sponsor.entity.name}</h3><AnchorComparison rank={sponsor.rank} delta={sponsor.anchorDelta} hasAnchors={plan.anchors.length > 0} /><FitDetails fit={sponsor.fit} /><p className="activation"><strong>Place to investigate in {stop.name}</strong>{place?.name ?? "No comparable place evidence"}</p>{activeAnchor && <p className="anchor-evidence">Selected anchor: {sponsor.explainability[activeAnchor]?.toFixed(3) ?? "Not provided"}</p>}<SponsorFit plan={plan} brandId={sponsor.entity.id} brandName={sponsor.entity.name} disabled={!canMutate} onApply={onApply} /><div className="place-actions"><button className="text-button" disabled={!canMutate || plan.selectedSponsorId === sponsor.entity.id} aria-label={`${plan.selectedSponsorId === sponsor.entity.id ? "Selected brand" : "Select brand"}: ${sponsor.entity.name}`} onClick={() => void onApply({ type: "select_sponsor", brandId: sponsor.entity.id })}>{plan.selectedSponsorId === sponsor.entity.id ? <><Check size={13} />Selected brand</> : <><Plus size={13} />Select brand</>}</button><EvidenceDialog title={`${sponsor.entity.name} sponsor evidence`} evidence={sponsor.evidence} /></div></article>;
          })}{!plan.sponsors.length && <div className="empty-places"><h3>No brands match</h3><p>Change the verified tag conditions or audience anchors. No fallback brand was invented.</p></div>}</div>
          <OrphanSponsorChecks plan={plan} disabled={!canMutate} onApply={onApply} />
          <ProposalPreferencesPanel plan={plan} stop={stop} value={editedPreferences ?? plan.input.proposalPreferences} unsaved={preferencesUnsaved} issue={preferenceIssue} disabled={!canMutate}
            onChange={(next) => setPreferenceEdit({ planId: plan.id, basis: preferenceBasis, value: next })} onDiscard={() => setPreferenceEdit(null)}
            onSave={() => onApply({ type: "set_proposal_preferences", preferences: editedPreferences ?? plan.input.proposalPreferences })} />
          <div className="brief-action">
            <dl className="brief-target" aria-label="Saved proposal target">
              <dt>Saved purpose</dt><dd>{proposalTypeCopy[plan.input.proposalPreferences.proposalType].label}</dd>
              {target?.status === "ready" && target.scope === "tour" && <><dt>Scope</dt><dd>Tour-wide</dd></>}
              {target?.status === "ready" && target.scope === "market" && <><dt>Target market</dt><dd>{target.stop.name}</dd><dt>Selected venue</dt><dd>{target.venue.name}</dd></>}
              {target?.status === "blocked" && <><dt>Target market</dt><dd>{target.stop?.name ?? (plan.input.proposalPreferences.focusCityId ? "No longer in the route" : "Not set")}</dd><dt>Selected venue</dt><dd>Not ready</dd></>}
              {plan.selectedSponsorId && <><dt>Brand fit for this purpose</dt><dd>{selectedCheck ? `${sponsorCheckLabels[selectedCheck.status]} — ${selectedCheck.reason}` : `${sponsorFitUnreviewed}. The support request will be generic.`}</dd></>}
            </dl>
            <button className="button-primary" disabled={!canMutate || draftBlockedReason !== null} onClick={() => void onDraft()}>{busy === "brief" ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}Draft sponsor proposal</button>
            {draftBlockedReason && <p className="field-hint">{draftBlockedReason}</p>}
            {plan.brief && plan.brief.revision === plan.revision && <>{preferencesUnsaved && <p className="field-hint">Unsaved preference edits are not reflected in this draft.</p>}<BriefDialog brief={plan.brief} plan={plan} onPrint={onPrintBrief} onPrintEvidence={onPrintBriefEvidence} /></>}
          </div>
        </Tabs.Content>
      </Tabs.Root>
      {stop.warnings.map((warning) => <p className="dossier-warning" key={warning}>{warning}</p>)}
    </>}
  </aside>;
}
