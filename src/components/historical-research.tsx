"use client";

import { useEffect, useRef, useState } from "react";
import { Archive, ArrowUpRight, Trash2 } from "lucide-react";
import type { ArchivedMarketResearch, PlanAction } from "@/lib/contracts";
import { decisionLabels } from "@/lib/venue-review";
import { formatTimestamp } from "@/lib/export";

interface Props {
  markets: ArchivedMarketResearch[];
  liveStopIds: string[];
  // Identifies the saved run on screen. Feedback belongs to one saved state.
  planKey: string;
  disabled: boolean;
  blockedReason?: string | null;
  onApply: (action: PlanAction) => Promise<boolean>;
}

// A forget result belongs to the saved state it describes: an error to the
// revision the user acted on, a success to the revision the forget produced.
// `to` binds on the first render after success that shows a different run, so
// Undo (back to `from`) or any later change hides the message.
type Feedback = { kind: "notice" | "error"; text: string; from: string; to: string | null };

// Historical user research kept outside the current-stop dossier: markets that
// left the route, and earlier candidates of a market that is still a stop but
// no longer returns them. Both stay inspectable without being mistaken for a
// live stop, a current candidate or a selection.
export default function HistoricalResearchPanel({ markets, liveStopIds, planKey, disabled, blockedReason, onApply }: Props) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  if (feedback?.kind === "notice" && feedback.to === null && planKey !== feedback.from) setFeedback({ ...feedback, to: planKey });
  const shown = feedback && (feedback.kind === "error" ? feedback.from === planKey : feedback.to === planKey) ? feedback : null;
  const shownNotice = shown?.kind === "notice" ? shown.to : null;
  // The forget control disappears with its record, so focus would fall to the
  // page. Move it to the confirmation only if nothing else holds focus.
  useEffect(() => {
    if (!shownNotice) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected && !(active instanceof HTMLButtonElement && active.disabled)) return;
    noticeRef.current?.focus({ preventScroll: true });
    noticeRef.current?.scrollIntoView({ block: "nearest" });
  }, [shownNotice]);
  // Stay mounted after the last record is forgotten so its success message
  // still appears for the revision that removed it.
  if (!markets.length && !shown) return null;

  async function forget(market: ArchivedMarketResearch) {
    const from = planKey;
    setFeedback(null); setPending(market.id);
    try {
      if (await onApply({ type: "forget_market_research", cityId: market.id })) {
        setConfirming(null);
        setFeedback({ kind: "notice", text: `Historical research for ${market.name} was forgotten. The current route and current research were not changed. Undo restores the previous saved revision.`, from, to: null });
      } else setFeedback({ kind: "error", text: `Historical research for ${market.name} was not removed. Review the workspace error and retry.`, from, to: from });
    } finally { setPending(null); }
  }

  return <section className="historical-research" aria-labelledby="historical-research-heading">
    <header><h2 id="historical-research-heading"><Archive size={15} />Historical research</h2><span>{markets.length ? `${markets.length} ${markets.length === 1 ? "record" : "records"} outside current research` : "None left in this revision"}</span></header>
    {markets.length > 0 && <p className="historical-note">User notes kept from earlier revisions. A market that is not in this route is labeled as such; earlier candidates of a market that is still a stop are shown separately from that stop's live research. None of these records is a stop, schedule row, provider evidence or booking, and old venue selections are not restored. A saved exclusion for a market outside this route still blocks that venue if the market returns, until you review it there.</p>}
    {markets.map((market) => {
      const notes = market.confirmations, decisions = market.venueDecisions;
      const busy = pending === market.id;
      const live = liveStopIds.includes(market.id);
      // A record can carry only sourced checks, only judgments, or both.
      const judgments = decisions.length ? `${decisions.length} venue ${decisions.length === 1 ? "judgment" : "judgments"}` : "";
      const checks = notes.length ? `${notes.length} sourced ${notes.length === 1 ? "check" : "checks"}` : "";
      const contents = [judgments, checks].filter(Boolean).join(" · ") || "saved research";
      return <article className="historical-record" key={market.id}>
        <div className="historical-record-heading"><h3>{market.name}</h3><span className={`historical-chip ${live ? "current" : ""}`}>{live ? "Earlier candidates · outside current research" : "Market not in this route"}</span></div>
        <p className="historical-meta">{contents}{market.places.length > 0 && ` · ${market.places.length} saved place ${market.places.length === 1 ? "name" : "names"}`}</p>
        {market.places.length > 0 && <p className="historical-places">Saved places: {market.places.map((place) => place.name).join("; ")}</p>}
        {decisions.length > 0 && <ul className="historical-judgments">
          {decisions.map((decision) => <li key={decision.entityId}>
            <div><strong>{decision.venueName}</strong><span className={`decision-badge ${decision.status}`}>{decisionLabels[decision.status]}</span></div>
            <p>{decision.reason}</p>
            <small>Your judgment from an earlier revision, recorded {formatTimestamp(decision.decidedAt)} · not a booking, and not a statement about current candidate suitability{decision.needsReview ? " · review required after earlier plan changes" : ""}</small>
          </li>)}
        </ul>}
        {notes.length > 0 && <ul className="historical-notes">
          {notes.map((note, index) => {
            const place = market.places.find((candidate) => candidate.id === note.entityId);
            return <li key={`${note.entityId}-${note.field}-${index}`}>
              <strong>{place?.name ?? note.entityId} · {note.field}</strong>
              <p>{note.value}</p>
              <small><a href={note.sourceUrl} target="_blank" rel="noopener noreferrer">Public source<ArrowUpRight size={11} /></a> · checked {formatTimestamp(note.checkedAt)}{note.forDate ? ` · applies ${note.forDate}` : ""} · {note.needsReconfirmation ? "reconfirmation required" : "user-sourced, not independently verified"}{place ? "" : " · place name not saved"}{live && !decisions.some((decision) => decision.entityId === note.entityId) ? " · the venue is not in this market's current candidates or judgments" : ""}</small>
            </li>;
          })}
        </ul>}
        {confirming === market.id ? <div className="historical-forget" role="group" aria-label={`Confirm forgetting historical research for ${market.name}`}>
          <p className="decision-warning" id={`forget-warning-${market.id}`}>Forget {market.name}? Only the {contents.toLowerCase()} listed above are removed from this revision. {live ? "This market's current stops are untouched: its live candidate research, route and selected venues do not change." : "Your current stops, route and selected venues do not change, but its saved exclusions will no longer protect against selecting those venues if the market returns."} Undo can restore the previous saved revision.</p>
          <div className="historical-actions">
            {/* Focus moves here because the trigger is replaced by this warning. */}
            <button className="button-danger" type="button" autoFocus aria-describedby={`forget-warning-${market.id}`} disabled={disabled || busy} aria-busy={busy} onClick={() => void forget(market)}><Trash2 size={13} />{busy ? "Forgetting…" : `Forget historical research for ${market.name}`}</button>
            <button className="button-secondary" type="button" disabled={busy} onClick={() => setConfirming(null)}>Keep it</button>
          </div>
        </div> : <button className="text-button" type="button" disabled={disabled || busy} onClick={() => { setConfirming(market.id); setFeedback(null); }}><Trash2 size={13} />Forget historical research for {market.name}</button>}
      </article>;
    })}
    {disabled && blockedReason && <p className="field-hint historical-disabled">{blockedReason}</p>}
    {shown?.kind === "error" && <p className="form-error" role="alert">{shown.text}</p>}
    {shown?.kind === "notice" && <p ref={noticeRef} tabIndex={-1} className="historical-notice" role="status">{shown.text}</p>}
  </section>;
}
