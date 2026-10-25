"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { BookOpen, X } from "lucide-react";
import type { Evidence } from "@/lib/contracts";
import { evidenceProvider, evidenceText } from "@/lib/export";

export default function EvidenceDialog({ title, evidence, note }: { title: string; evidence: Evidence[]; note?: string }) {
  const unique = [...new Map(evidence.map((entry) => [evidenceText(entry), entry])).values()];
  if (!unique.length) return <span className="field-hint">No provider source{note ? ` · ${note}` : ""}</span>;
  return <Dialog.Root>
    <Dialog.Trigger asChild><button className="text-button source-trigger" aria-label={`Sources (${unique.length}) for ${title}`}><BookOpen size={13} />Sources ({unique.length})</button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content evidence-drawer">
      <div className="dialog-heading"><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>Actual request conditions and source timestamps. Cached observations are not current booking or availability checks.</Dialog.Description></div><Dialog.Close className="icon-button" aria-label="Close sources"><X size={19} /></Dialog.Close></div>
      {note && <p className="dialog-note">{note}</p>}
      <div className="dialog-scroll">{unique.map((entry, index) => <article className="source-record" key={index}>
        <div><strong>{evidenceProvider(entry)}</strong><code>{entry.endpoint}</code><span className="source-badge">{entry.cached ? "Cached response" : "Fetched at generation"}</span></div>
        <p>Source fetched: <time dateTime={entry.fetchedAt}>{new Date(entry.fetchedAt).toLocaleString()}</time></p>
        <pre>{JSON.stringify(entry.params, null, 2)}</pre>
        {entry.provider === "wikidata" && <><p>P570 biographical check only. No death record does not establish current activity or availability.</p><p>{(entry.params.ids ?? "").split("|").filter((id) => /^Q[1-9]\d{0,14}$/.test(id)).map((id) => <a key={id} className="text-button" href={`https://www.wikidata.org/wiki/${id}#P570`} target="_blank" rel="noopener noreferrer">{id}</a>)}</p></>}
      </article>)}</div>
      <a className="text-button" href="https://docs.qloo.com/reference/api-overview" target="_blank" rel="noopener noreferrer">Qloo API documentation</a>
      {unique.some((entry) => entry.provider === "wikidata") && <a className="text-button" href="https://www.wikidata.org/wiki/Wikidata:Licensing" target="_blank" rel="noopener noreferrer">Wikidata structured data (CC0)</a>}
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
