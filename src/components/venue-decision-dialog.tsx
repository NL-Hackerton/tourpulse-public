"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ClipboardCheck, X } from "lucide-react";
import { venueDecisionSchema, type PlanAction, type Place, type Stop, type VenueDecision } from "@/lib/contracts";

export default function VenueDecisionDialog({ stop, place, disabled, onApply }: {
  stop: Stop; place: Place; disabled: boolean; onApply: (action: PlanAction) => Promise<boolean>;
}) {
  const current = stop.venueDecisions.find((decision) => decision.entityId === place.id);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<VenueDecision["status"]>(current?.status ?? "hold");
  const [reason, setReason] = useState(current?.reason ?? "");
  const [error, setError] = useState("");
  function changeOpen(next: boolean) {
    if (next) { setStatus(current?.status ?? "hold"); setReason(current?.reason ?? ""); setError(""); }
    setOpen(next);
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = venueDecisionSchema.safeParse({ entityId: place.id, venueName: place.name, status, reason, decidedAt: new Date().toISOString(), needsReview: false });
    if (!parsed.success) { setError("Explain the decision in at least three characters, without private contact details."); return; }
    if (await onApply({ type: "review_venue", cityId: stop.id, decision: parsed.data })) setOpen(false);
    else setError("The decision was not saved. Review the workspace error and try again.");
  }
  return <Dialog.Root open={open} onOpenChange={changeOpen}>
    <Dialog.Trigger asChild><button className="button-secondary decision-trigger" disabled={disabled} aria-label={`${current ? "Review decision" : "Assess this venue"}: ${place.name} in ${stop.name}`}><ClipboardCheck size={14} />{current ? "Review decision" : "Assess this venue"}</button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content confirmation-dialog">
      <div className="dialog-heading"><div><Dialog.Title>Keep, hold or exclude?</Dialog.Title><Dialog.Description>{place.name}. Record your judgment separately from Qloo's taste evidence. A shortlist is a lead to investigate, not a booking.</Dialog.Description></div><Dialog.Close className="icon-button" aria-label="Close venue assessment"><X size={19} /></Dialog.Close></div>
      <form onSubmit={submit}><fieldset disabled={disabled} className="confirmation-fields">
        <label>Research decision<select value={status} onChange={(event) => { const next = venueDecisionSchema.shape.status.safeParse(event.target.value); if (next.success) setStatus(next.data); }}><option value="shortlist">Shortlist for follow-up</option><option value="hold">Hold pending a check</option><option value="exclude">Exclude from this plan</option></select></label>
        <label>Why this decision?<textarea required minLength={3} maxLength={600} rows={4} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain the deciding constraint or next check. Cite any sourced notes you recorded; do not assume availability." /></label>
        <p className="field-hint">Use “Record your check” on the venue card to attach a public source and check date. This explanation is your assessment, not independently verified evidence.</p>
        {status === "exclude" && <p className="decision-warning">Excluding a venue removes it from the working route if selected. It remains visible with your reason and cannot be selected again until you review this decision.</p>}
        {current?.needsReview && <p className="decision-warning">The plan or sourced checks changed after your last decision. Saving confirms that you reviewed this context.</p>}
        {error && <p role="alert" className="form-error">{error}</p>}
        <button className="button-primary" type="submit">Save research decision</button>
        {current && <button className="text-button" type="button" onClick={async () => { if (await onApply({ type: "forget_venue_decision", cityId: stop.id, entityId: place.id })) setOpen(false); else setError("The saved decision could not be removed. Review the workspace error."); }}>Forget this assessment{current.status === "exclude" ? " and allow selection again" : ""}</button>}
      </fieldset></form>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
