"use client";

import { LoaderCircle } from "lucide-react";
import type { ActionPreview as Preview } from "@/lib/contracts";

const shortDate = (date: string | null) => date
  ? new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`))
  : "—";

/**
 * Read-only presentation of a validated preview. The caller owns `onApply`;
 * wire it to `tour.apply(preview.action)` so the same validated action is applied.
 * The component never dispatches an action by itself.
 */
export default function ActionPreviewCard({ preview, canApply, busy = false, onApply }: { preview: Preview; canApply: boolean; busy?: boolean; onApply: () => void }) {
  const schedule = preview.schedulePreview;
  const applyReady = canApply && Boolean(preview.action) && !preview.clarification;
  return <div className="action-preview" aria-live="polite">
    <strong>{preview.summary}</strong>
    {preview.clarification && <p>{preview.clarification}</p>}
    <dl>
      <dt>What changes</dt>
      <dd>{preview.changedFields.join("; ") || "No plan field changes"}</dd>
      <dt>What is affected</dt>
      <dd><ul className="preview-consequences">{preview.invalidates.map((consequence) => <li key={consequence}>{consequence}</li>)}</ul></dd>
    </dl>
    {schedule ? <section className="schedule-preview" aria-label="Schedule before and after">
      <h3>Schedule before and after</h3>
      <table className="schedule-preview-table">
        <thead><tr><th scope="col">Measure</th><th scope="col">Current</th><th scope="col">After this change</th></tr></thead>
        <tbody>
          <tr><th scope="row">Fits the window</th><td>{schedule.before.feasible ? "Yes" : "No"}</td><td>{schedule.after.feasible ? "Yes" : "No"}</td></tr>
          <tr><th scope="row">Calendar days used</th><td>{schedule.before.feasible ? schedule.before.totalDays : "Not scheduled"}</td><td>{schedule.after.feasible ? schedule.after.totalDays : "Not scheduled"}</td></tr>
          <tr><th scope="row">Show days</th><td>{schedule.before.feasible ? schedule.before.showDays : "Not scheduled"}</td><td>{schedule.after.feasible ? schedule.after.showDays : "Not scheduled"}</td></tr>
          <tr><th scope="row">Travel days</th><td>{schedule.before.feasible ? schedule.before.travelDays : "Not scheduled"}</td><td>{schedule.after.feasible ? schedule.after.travelDays : "Not scheduled"}</td></tr>
          <tr><th scope="row">Rest / waiting days</th><td>{schedule.before.feasible ? schedule.before.nonShowDays : "Not scheduled"}</td><td>{schedule.after.feasible ? schedule.after.nonShowDays : "Not scheduled"}</td></tr>
          <tr><th scope="row">Last scheduled day</th><td>{shortDate(schedule.before.endDate)}</td><td>{shortDate(schedule.after.endDate)}</td></tr>
          <tr><th scope="row">Extra days needed</th><td>{schedule.before.extraDays}</td><td>{schedule.after.extraDays}</td></tr>
        </tbody>
      </table>
      <h4>Show dates by city</h4>
      <ul className="schedule-preview-dates">{schedule.showDates.map((entry) => <li key={entry.city}>
        <span>{entry.city}</span>
        <span>{entry.before === entry.after
          ? shortDate(entry.after)
          : <><s>{shortDate(entry.before)}</s> → <strong>{shortDate(entry.after)}</strong></>}</span>
      </li>)}</ul>
      {schedule.warnings.length > 0 && <ul className="preview-warnings">{schedule.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
    </section> : preview.action && <p className="preview-uncomputed">Show dates, travel days and calendar-day counts are not computed for this change. Apply it or use a date, driving-hour or show-day control to see the schedule comparison.</p>}
    {preview.action && <details><summary>Exact proposed action</summary><pre>{JSON.stringify(preview.action, null, 2)}</pre></details>}
    {applyReady
      ? <button className="button-primary" disabled={busy} aria-busy={busy} onClick={onApply}>{busy ? <><LoaderCircle size={15} className="spin" aria-hidden="true" />Saving…</> : <>Apply to revision {preview.expectedRevision}</>}</button>
      : <p className="field-hint">{preview.clarification ? "Resolve the clarification before applying." : "Reconnect to the current saved revision before applying."}</p>}
    <small>Model: {preview.model} · revision {preview.expectedRevision}. Nothing has been applied.</small>
  </div>;
}
