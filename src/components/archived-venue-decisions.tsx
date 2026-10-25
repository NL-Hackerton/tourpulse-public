"use client";

import { useState } from "react";
import type { PlanAction, Stop } from "@/lib/contracts";
import { decisionLabels } from "@/lib/venue-review";

export default function ArchivedVenueDecisions({ stop, disabled, onApply }: {
  stop: Stop; disabled: boolean; onApply: (action: PlanAction) => Promise<boolean>;
}) {
  const [error, setError] = useState("");
  const archived = stop.venueDecisions.filter((decision) => !stop.venues.some((venue) => venue.id === decision.entityId));
  if (!archived.length) return null;
  return <details className="archived-decisions"><summary>Previous candidates · {archived.length} saved assessments</summary>
    <p>These rooms are not in the current results. Exclusions stay active if a room returns. Forgetting an archived assessment removes it and its attached source notes from this revision, and removes the selection block. Undo can restore them.</p>
    {archived.map((decision) => <article key={decision.entityId}>
      <h3>{decision.venueName}</h3><span className={`decision-badge ${decision.status}`}>{decisionLabels[decision.status]}</span>
      <p>{decision.reason}</p><small>Recorded {new Date(decision.decidedAt).toLocaleDateString()} · historical assessment, not a booking</small>
      {stop.confirmations.filter((note) => note.entityId === decision.entityId).map((note, index) => <p className="archived-source" key={index}>{note.field}: {note.value}<br /><a href={note.sourceUrl} target="_blank" rel="noopener noreferrer">Source checked {new Date(note.checkedAt).toLocaleDateString()}</a>{note.forDate && ` · applies ${note.forDate}`}</p>)}
      <button className="text-button" disabled={disabled} onClick={async () => {
        setError("");
        if (!await onApply({ type: "forget_venue_decision", cityId: stop.id, entityId: decision.entityId })) setError("The historical assessment was not removed. Review the workspace error and retry.");
      }}>Forget assessment and notes for {decision.venueName}</button>
    </article>)}
    {error && <p className="form-error" role="alert">{error}</p>}
  </details>;
}
