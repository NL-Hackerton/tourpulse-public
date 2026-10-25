"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { Copy, Download, FileText, Printer, ShieldCheck, X } from "lucide-react";
import type { Brief, TourPlan } from "@/lib/contracts";
import { exportBriefEvidenceMarkdown, exportBriefMarkdown, RECIPIENT_BOUNDARY } from "@/lib/export";
import { downloadText } from "@/lib/client";
import EvidenceDialog from "./evidence-dialog";

interface Props {
  brief: Brief;
  plan?: TourPlan | null;
  onPrint: () => void;
  onPrintEvidence: () => void;
}

export default function BriefDialog({ brief, plan, onPrint, onPrintEvidence }: Props) {
  const [notice, setNotice] = useState("");
  async function copyEmail() {
    try { await navigator.clipboard.writeText(`${brief.emailSubject}\n\n${brief.emailBody}\n\n${RECIPIENT_BOUNDARY}`); setNotice("Email draft copied with its tentative-proposal boundary. Review the evidence appendix before sending."); }
    catch { setNotice("Clipboard access was unavailable. Select the draft text or download it instead."); }
  }
  return <Dialog.Root>
    <Dialog.Trigger asChild><button className="button-secondary"><FileText size={14} />Open proposal</button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content brief-dialog">
      <div className="dialog-heading"><div><Dialog.Title>Sponsor proposal draft</Dialog.Title><Dialog.Description>Revision {brief.revision}. A draft for review — not a sponsorship commitment and not sent.</Dialog.Description></div><Dialog.Close className="icon-button" aria-label="Close proposal"><X size={19} /></Dialog.Close></div>
      <div className="brief-toolbar">
        <button className="button-secondary" onClick={() => downloadText(exportBriefMarkdown(brief), `tourpulse-proposal-r${brief.revision}.md`, "text/markdown;charset=utf-8")}><Download size={14} />Proposal (.md)</button>
        <button className="button-secondary" onClick={() => downloadText(exportBriefEvidenceMarkdown(brief, plan ?? undefined), `tourpulse-proposal-evidence-r${brief.revision}.md`, "text/markdown;charset=utf-8")}><ShieldCheck size={14} />Evidence (.md)</button>
        <button className="button-secondary" onClick={onPrint}><Printer size={14} />Print proposal</button>
        <button className="button-secondary" onClick={onPrintEvidence}><Printer size={14} />Print evidence</button>
      </div>
      <Tabs.Root defaultValue="proposal"><Tabs.List className="dossier-tabs" aria-label="Proposal sections"><Tabs.Trigger value="proposal">Proposal</Tabs.Trigger><Tabs.Trigger value="email">Email draft</Tabs.Trigger><Tabs.Trigger value="evidence">Evidence</Tabs.Trigger></Tabs.List>
        <Tabs.Content value="proposal" className="dialog-scroll brief-prose"><p className="brief-draft-status">Draft · revision {brief.revision} · not sent</p><h2>{brief.title}</h2><p>{brief.summary}</p>{brief.sections.map((section, index) => <section key={index}><h3>{section.heading}</h3><p>{section.text}</p></section>)}<p className="brief-boundary">{RECIPIENT_BOUNDARY}</p></Tabs.Content>
        <Tabs.Content value="email" className="dialog-scroll brief-prose"><h3>{brief.emailSubject}</h3><p className="email-text">{brief.emailBody}</p><p className="brief-boundary">{RECIPIENT_BOUNDARY}</p><button className="button-secondary" onClick={copyEmail}><Copy size={14} />Copy email draft</button><p role="status">{notice}</p></Tabs.Content>
        <Tabs.Content value="evidence" className="dialog-scroll"><p className="dialog-note">Every number and named entity is rendered from the validated fact ledger, generated with {brief.model}. Facts, source timestamps and limitations are kept out of the recipient copy and collected here.</p>{brief.facts.map((fact) => <article className="fact-record" key={fact.id}><div><code>{fact.id}</code><span className="source-badge">{fact.kind}</span></div><h3>{fact.label}</h3><p>{fact.value}</p><EvidenceDialog title={fact.label} evidence={fact.evidence} /></article>)}<div className="brief-warnings">{brief.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div></Tabs.Content>
      </Tabs.Root>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
