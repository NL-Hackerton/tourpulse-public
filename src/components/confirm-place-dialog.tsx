"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ClipboardCheck, X } from "lucide-react";
import { confirmationSchema, isPublicSourceUrl, publicSourceUrlMessage, type PlanAction, type Place, type Stop } from "@/lib/contracts";

export default function ConfirmPlaceDialog({ stop, place, date, disabled, onApply }: { stop: Stop; place: Place; date: string; disabled: boolean; onApply: (action: PlanAction) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<"capacity" | "operating" | "availability" | "fee">("capacity");
  const [value, setValue] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [checkedAt, setCheckedAt] = useState(new Date().toISOString().slice(0, 16));
  const [forDate, setForDate] = useState(date);
  const [dateScoped, setDateScoped] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    if (!isPublicSourceUrl(sourceUrl)) { setError(publicSourceUrlMessage); return; }
    const raw = { entityId: place.id, field, value, sourceUrl, checkedAt: `${checkedAt}:00.000Z`, forDate: dateScoped || field === "availability" ? forDate : null, needsReconfirmation: false };
    const parsed = confirmationSchema.safeParse(raw);
    if (!parsed.success) { setError("Provide the value, source URL, checked-at UTC time and any applicable date."); return; }
    if (await onApply({ type: "confirm_place", cityId: stop.id, confirmation: parsed.data })) setOpen(false);
    else setError("This confirmation was not saved. Review the workspace error and retry.");
  }
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><button className="text-button" disabled={disabled} aria-label={`Record your check for ${place.name} in ${stop.name}`}><ClipboardCheck size={13} />Record your check</button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content confirmation-dialog">
      <div className="dialog-heading"><div><Dialog.Title>Record a venue check</Dialog.Title><Dialog.Description>{place.name}. These are your sourced notes, not facts verified by Qloo or a booking confirmation. Do not enter private contact details.</Dialog.Description></div><Dialog.Close className="icon-button" aria-label="Close venue check"><X size={19} /></Dialog.Close></div>
      <form onSubmit={submit}><fieldset disabled={disabled} className="confirmation-fields">
        <label>What did you check?<select value={field} onChange={(e) => { const next = confirmationSchema.shape.field.safeParse(e.target.value); if (next.success) setField(next.data); }}><option value="capacity">Capacity</option><option value="operating">Operating status</option><option value="availability">Date availability</option><option value="fee">Fee</option></select></label>
        <label>Observed value<input required value={value} maxLength={400} onChange={(e) => setValue(e.target.value)} placeholder="Only what the source confirms" /></label>
        <label>Public source URL<input required type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://…" /></label>
        <label>Checked at (UTC)<input required type="datetime-local" value={checkedAt} onChange={(e) => setCheckedAt(e.target.value)} /></label>
        {field !== "availability" && <label className="checkbox-label"><input type="checkbox" checked={dateScoped} onChange={(e) => setDateScoped(e.target.checked)} />This check applies to a specific date</label>}
        {(dateScoped || field === "availability") && <label>Applies on<input required type="date" value={forDate} onChange={(e) => setForDate(e.target.value)} /></label>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button-primary" type="submit">Save sourced note</button>
      </fieldset></form>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
