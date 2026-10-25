"use client";

import { useId, useRef, useState } from "react";
import { proposalConstraints, proposalTypes, type ProposalConstraint, type ProposalPreferences, type ProposalType, type Stop, type TourPlan } from "@/lib/contracts";
import { proposalConstraintLabels, proposalTypeCopy } from "@/lib/proposal-preferences";
import "./proposal-preferences-panel.css";

interface Props {
  plan: TourPlan; stop: Stop; value: ProposalPreferences; unsaved: boolean; issue: string | null; disabled: boolean;
  onChange: (value: ProposalPreferences) => void; onDiscard: () => void; onSave: () => Promise<boolean>;
}

/**
 * Controlled editor for the saved proposal purpose. Edits stay local until Save
 * applies them through the normal plan action; the parent owns the edit state so
 * switching tabs or markets does not discard it.
 */
export default function ProposalPreferencesPanel({ plan, stop, value, unsaved, issue, disabled, onChange, onDiscard, onSave }: Props) {
  const id = useId();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const onSite = value.proposalType === "on_site_activation";
  const target = plan.stops.find((market) => market.id === value.focusCityId);
  // A market chosen before switching to a tour-wide purpose is remembered for
  // this edit and offered again on return; it is never saved with the tour-wide purpose.
  const rememberedTarget = useRef<string | null>(null);
  const targetRef = useRef<HTMLSelectElement>(null);
  const purposeRef = useRef<HTMLFieldSetElement>(null);
  const setType = (proposalType: ProposalType) => {
    if (value.focusCityId) rememberedTarget.current = value.focusCityId;
    const remembered = plan.stops.some((market) => market.id === rememberedTarget.current) ? rememberedTarget.current : null;
    onChange({ ...value, proposalType, focusCityId: proposalType === "on_site_activation" ? value.focusCityId ?? remembered : null });
  };
  // Buttons that disappear after activation hand focus to the control they changed.
  const focusAfterRender = (element: () => HTMLElement | null | undefined) => requestAnimationFrame(() => element()?.focus());
  const toggle = (constraint: ProposalConstraint, checked: boolean) => onChange({ ...value, constraints: proposalConstraints.filter((item) => item === constraint ? checked : value.constraints.includes(item)) });
  async function save() {
    setError(""); setSaving(true);
    try { if (!await onSave()) setError("Preferences were not saved. Review the workspace error and retry; your edits are kept."); }
    finally { setSaving(false); }
  }
  return <section className="proposal-preferences" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`}>Proposal preferences</h3>
    <p className="field-hint">Your planning hypotheses for the draft, not services or interest the brand has confirmed. The saved choices apply to every draft until you change them.</p>
    <fieldset disabled={disabled} ref={purposeRef}><legend>Purpose</legend>
      {proposalTypes.map((type) => <label className="preference-option" key={type}><input type="radio" name={`${id}-purpose`} checked={value.proposalType === type} onChange={() => setType(type)} /><span><strong>{proposalTypeCopy[type].label}</strong><small>{proposalTypeCopy[type].description}</small></span></label>)}
    </fieldset>
    {onSite ? <div className="preference-target">
      <label htmlFor={`${id}-target`}>Target market</label>
      <select id={`${id}-target`} ref={targetRef} disabled={disabled} value={target ? target.id : ""} onChange={(event) => onChange({ ...value, focusCityId: event.target.value || null })}>
        <option value="">Choose a market in the route</option>
        {plan.stops.map((market) => <option key={market.id} value={market.id}>{market.name}</option>)}
      </select>
      {value.focusCityId !== stop.id && <button type="button" className="text-button" disabled={disabled} onClick={() => { onChange({ ...value, focusCityId: stop.id }); focusAfterRender(() => targetRef.current); }}>Use {stop.name}</button>}
      {value.focusCityId !== null && !target && <p className="form-error">The saved target market is no longer in the route. Choose a current market.</p>}
    </div> : <p className="preference-scope"><strong>Scope</strong>Tour-wide · no venue is targeted</p>}
    <fieldset disabled={disabled}><legend>Constraints</legend>
      {proposalConstraints.map((constraint) => <label className="preference-option" key={constraint}><input type="checkbox" checked={value.constraints.includes(constraint)} onChange={(event) => toggle(constraint, event.target.checked)} /><span>{proposalConstraintLabels[constraint]}</span></label>)}
    </fieldset>
    {issue && <p className="form-error" role="alert">{issue}</p>}
    <div className="preference-actions">
      <button type="button" className="button-secondary" disabled={disabled || saving || !unsaved || issue !== null} onClick={() => void save()}>Save preferences</button>
      {unsaved && <button type="button" className="text-button" disabled={saving} onClick={() => { setError(""); onDiscard(); focusAfterRender(() => purposeRef.current?.querySelector<HTMLInputElement>("input:checked")); }}>Discard edits</button>}
    </div>
    <p className="field-hint" aria-live="polite">{unsaved ? "Unsaved edits. Saving clears any existing proposal draft; drafting stays blocked until you save or discard." : "Showing your saved preferences."}</p>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
