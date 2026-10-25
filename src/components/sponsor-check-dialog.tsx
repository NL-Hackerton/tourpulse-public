"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ClipboardCheck, X } from "lucide-react";
import { isPublicSourceUrl, publicSourceUrlMessage, sponsorCheckSchema, type PlanAction, type ProposalType, type SponsorCheck } from "@/lib/contracts";
import { proposalTypeCopy } from "@/lib/proposal-preferences";
import { sponsorCheckLabels } from "@/lib/sponsor-check";

export default function SponsorCheckDialog({ brandId, brandName, purpose, current, disabled, onApply }: {
  brandId: string; brandName: string; purpose: ProposalType; current: SponsorCheck | null; disabled: boolean; onApply: (action: PlanAction) => Promise<boolean>;
}) {
  const purposeLabel = proposalTypeCopy[purpose].label;
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SponsorCheck["status"]>(current?.status ?? "discuss");
  const [offering, setOffering] = useState(current?.offering ?? "");
  const [reason, setReason] = useState(current?.reason ?? "");
  const [sourceUrl, setSourceUrl] = useState(current?.sourceUrl ?? "");
  const [checkedAt, setCheckedAt] = useState((current?.checkedAt ?? new Date().toISOString()).slice(0, 16));
  const [error, setError] = useState("");
  function changeOpen(next: boolean) {
    if (next) {
      setStatus(current?.status ?? "discuss"); setOffering(current?.offering ?? ""); setReason(current?.reason ?? "");
      setSourceUrl(current?.sourceUrl ?? ""); setCheckedAt((current?.checkedAt ?? new Date().toISOString()).slice(0, 16)); setError("");
    }
    setOpen(next);
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    if (!isPublicSourceUrl(sourceUrl)) { setError(publicSourceUrlMessage); return; }
    const parsed = sponsorCheckSchema.safeParse({ brandId, brandName, purpose, status, offering, reason, sourceUrl, checkedAt: `${checkedAt}:00.000Z` });
    if (!parsed.success) { setError("Describe the offering as a short phrase (3–120 characters) and give your reason (3–400 characters), with the public source URL and checked-at UTC time."); return; }
    if (await onApply({ type: "record_sponsor_check", check: parsed.data })) setOpen(false);
    else setError("This purpose check was not saved. Review the workspace error and retry.");
  }
  return <Dialog.Root open={open} onOpenChange={changeOpen}>
    <Dialog.Trigger asChild><button className="button-secondary decision-trigger" disabled={disabled} aria-label={`${current ? "Update fit check" : "Check fit for saved purpose"}: ${brandName}, ${purposeLabel}`}><ClipboardCheck size={14} />{current ? "Update fit check" : "Check fit for saved purpose"}</button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content confirmation-dialog">
      <div className="dialog-heading"><div><Dialog.Title>Is this brand worth discussing for {purposeLabel}?</Dialog.Title><Dialog.Description>{brandName}. Qloo found this brand through audience taste only. Record what a public source shows the brand offers for this purpose and your own judgment. This is your research, not a brand statement, availability or commitment. Do not enter private contact details.</Dialog.Description></div><Dialog.Close className="icon-button" aria-label="Close sponsor purpose check"><X size={19} /></Dialog.Close></div>
      <form onSubmit={submit}><fieldset disabled={disabled} className="confirmation-fields">
        <label>Fit for this purpose<select value={status} onChange={(event) => { const next = sponsorCheckSchema.shape.status.safeParse(event.target.value); if (next.success) setStatus(next.data); }}><option value="discuss">{sponsorCheckLabels.discuss}</option><option value="not_suitable">{sponsorCheckLabels.not_suitable}</option></select></label>
        <label>What the brand offers for this purpose, as a short phrase<input required minLength={3} maxLength={120} value={offering} onChange={(event) => setOffering(event.target.value)} placeholder="For example: casual shorts and swimwear" /></label>
        <p className="field-hint">The phrase may appear in the proposal, so describe only what the public page shows. It is not a claim of availability or interest.</p>
        <label>Your reason<textarea required minLength={3} maxLength={400} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="What the source says and why this brand is, or is not, a practical counterpart for the saved purpose." /></label>
        <label>Public source URL<input required type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://…" /></label>
        <label>Checked at (UTC)<input required type="datetime-local" value={checkedAt} onChange={(event) => setCheckedAt(event.target.value)} /></label>
        {status === "not_suitable" && <p className="decision-warning">Drafting a proposal to this brand for this purpose stays blocked until you update or forget this check.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button-primary" type="submit">Save purpose check</button>
      </fieldset></form>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
