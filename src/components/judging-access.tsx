"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { z } from "zod";
import { requestJson } from "@/lib/client";

export default function JudgingAccess() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  async function activate(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage(""); setError(false);
    try {
      await requestJson("/api/session", z.object({ judging: z.literal(true) }), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ judgingCode: code }) });
      setCode(""); setMessage("Judging priority is active for this anonymous session. Every feature remains available to public visitors too.");
    } catch (cause) { setError(true); setMessage(cause instanceof Error ? cause.message : "Priority access could not be activated. Please retry."); }
    finally { setBusy(false); }
  }
  return <Dialog.Root onOpenChange={(open) => { if (!open) setCode(""); }}>
    <Dialog.Trigger asChild><button className="text-button">Judging access</button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content">
      <div className="dialog-heading"><div><Dialog.Title>Judging priority</Dialog.Title><Dialog.Description>Optional access code from the private testing instructions. It reserves execution capacity during busy periods; it does not unlock features or bypass provider limits.</Dialog.Description></div><Dialog.Close className="icon-button" aria-label="Close judging access"><X size={19} /></Dialog.Close></div>
      <form onSubmit={activate}>
        <label className="stacked-field">Access code<input type="password" autoComplete="off" maxLength={128} value={code} disabled={busy} onChange={(event) => setCode(event.target.value)} /></label>
        <div className="brief-toolbar"><button className="button-primary" disabled={busy || !code}>{busy ? "Verifying…" : "Activate priority"}</button></div>
      </form>
      {message && <p role={error ? "alert" : "status"}>{message}</p>}
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
