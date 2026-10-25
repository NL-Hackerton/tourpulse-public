"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Activity, ArrowRight, ChevronDown, ChevronRight, CircleHelp, Download, FileText, Headphones, LoaderCircle, MapPin, Mic, Music2, Play, Podcast, Printer, RefreshCw, Send, SlidersHorizontal, Square, Undo2, X } from "lucide-react";
import * as Tabs from "@radix-ui/react-tabs";
import { agentMessageLimit, candidateCities, entityTypes, presetSeeds, tourTypes, type PlanAction, type TourType } from "@/lib/contracts";
import { exportCsv, exportMarkdown, exportBriefMarkdown, exportBriefEvidenceMarkdown } from "@/lib/export";
import { downloadText } from "@/lib/client";
import { useTour } from "./use-tour";
import EntitySearch from "./entity-search";
import RouteOverview from "./route-overview";
import StopDossier from "./stop-dossier";
import JudgingAccess from "./judging-access";
import DecisionOverview from "./decision-overview";
import HistoricalResearchPanel from "./historical-research";
import ActionPreviewCard from "./action-preview";
import ProposalPrint from "./proposal-print";
import DaySheetPrint from "./day-sheet-print";
import { DailyDriveChart, RouteMetrics, RouteOrderChart } from "./tour-visuals";
import { decisionLabels } from "@/lib/venue-review";

const modeLabels: Record<TourType, string> = { music: "Music", standup: "Stand-up", podcast: "Live podcast" };
const headlinerTypes = { music: "artist", standup: "person", podcast: "podcast" } as const;
const entityTypeLabel = (type: string) => { const key = type.replace("urn:entity:", ""); return key === "tv_show" ? "TV show" : key === "video_game" ? "Video game" : key.charAt(0).toUpperCase() + key.slice(1); };
const modeIcons = { music: Music2, standup: Mic, podcast: Podcast } as const;
const shortDate = (date: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
const weekday = (date: string) => new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

type View = "Plan" | "Map" | "Dossier" | "Trace";

// What the workspace is doing, in the user's terms: a short topbar label and
// the status line. Only describes what actually happens to the visible result.
const busyMessages: Record<string, readonly [short: string, long: string]> = {
  plan: ["Planning…", "Finding markets and venues for a new tour. The working result appears when the run finishes."],
  retry: ["Resuming…", "Resuming the saved attempt. What you see stays read-only until it finishes."],
  preview: ["Preparing preview…", "Preparing a preview of your requested change. Nothing changes until you apply it."],
  brief: ["Drafting proposal…", "Drafting the proposal and checking it against its sources. Your saved plan remains available; nothing is sent."],
  reconnect: ["Reconnecting…", "Reconnecting to your saved run."],
  undo: ["Restoring…", "Restoring the previous saved revision."],
  preset: ["Loading sample…", "Loading the sample tour."],
  cancel: ["Cancelling…", "Cancelling the run."],
  session: ["Starting session…", "Starting a new private session."],
  queued: ["Waiting to start…", "Your saved run is queued. This page checks for the result automatically."],
  running: ["Processing…", "Your saved run is still processing. This page checks for the result automatically."],
};
const actionLabels: Partial<Record<PlanAction["type"], string>> = {
  confirm_place: "Saving your source check",
  review_venue: "Saving your venue judgment",
  forget_venue_decision: "Forgetting the venue judgment",
  forget_market_research: "Forgetting historical research",
  set_proposal_preferences: "Saving proposal preferences",
  record_sponsor_check: "Saving your sponsor purpose check",
  forget_sponsor_check: "Forgetting the sponsor purpose check",
  select_venue: "Choosing the venue",
  select_support: "Choosing the support candidate",
  select_partner: "Updating nearby partner places",
  select_sponsor: "Choosing the sponsor",
  select_neighborhood: "Choosing the neighborhood",
  set_sponsor_tags: "Updating brand categories",
  replace_city: "Replacing the market and recalculating the route",
};
function busyMessage(working: string, action: PlanAction["type"] | null, revision: number | undefined): readonly [string, string] {
  if (working !== "apply") return busyMessages[working] ?? ["Working…", "Working on your request."];
  return ["Saving change…", `${(action && actionLabels[action]) ?? "Applying your change"}.${revision ? " The current saved result stays visible but locked until this change is saved." : ""}`];
}
// Live server progress is shown from real trace records, never as a percentage.
const progressKinds: Record<string, true> = { plan: true, apply: true, retry: true, queued: true, running: true };

export default function TourConsole() {
  const tour = useTour();
  const { plan, run, settings, headliner, anchors, busy, dirty } = tour;
  const [mobileTab, setMobileTab] = useState<View>("Map");
  const [anchorType, setAnchorType] = useState<(typeof entityTypes)[number]>("movie");
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  const [showScores, setShowScores] = useState(false);
  const [centerTab, setCenterTab] = useState("overview");
  const [traceOpen, setTraceOpen] = useState(false);
  const [pendingPreset, setPendingPreset] = useState<TourType | null>(null);
  // Below the desktop breakpoint the activity log is always shown, so its toggle is inert.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const update = () => setNarrow(query.matches);
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const [exportOpen, setExportOpen] = useState(false);
  const [reviewRequest, setReviewRequest] = useState(0);
  const [agentMessage, setAgentMessage] = useState("");
  const [printKind, setPrintKind] = useState<"day" | "brief" | "briefEvidence">("day");
  const selectedStop = plan?.stops.find((stop) => stop.id === tour.selectedId) ?? plan?.stops[0];
  const historicalResearch = plan?.archivedResearch ?? [];
  const liveStopIds = plan?.stops.map((stop) => stop.id) ?? [];
  const canExport = Boolean(tour.canMutate && plan?.schedule.feasible);
  const working = busy || (run && ["queued", "running"].includes(run.status) ? run.status : null);
  const [busyShort, busyLong] = working ? busyMessage(working, tour.activeAction, plan?.revision) : ["", ""];
  const latestTrace = working && progressKinds[working] ? tour.traces.at(-1) : undefined;
  const undoAvailable = Boolean(tour.history.length || run?.previousRunId);
  const undoContext = !undoAvailable ? "Nothing to undo yet in this session." : dirty ? "Restore or plan your changed inputs before undoing."
    : plan && run?.status === "complete" ? `Returns to the saved result from before revision ${plan.revision}, with its research notes. No new Qloo request.`
    : "Returns to your last completed saved result. No new Qloo request.";
  const messageRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tour.error || document.querySelector('[role="dialog"]')) return;
    messageRef.current?.focus({ preventScroll: true });
    messageRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [tour.error]);
  // After a successful operation, a control that held focus may have been
  // disabled or removed, dropping focus to the page. Only then move it to the
  // status message. Waiting a frame and a task lets a closing dialog return
  // focus to its trigger first; an open dialog is never interrupted. The
  // historical panel announces its own forget result.
  useEffect(() => {
    const done = tour.completion;
    if (!done || done.action === "forget_market_research") return;
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        const active = document.activeElement;
        const lost = !active || active === document.body || !active.isConnected || (active instanceof HTMLButtonElement && active.disabled) || (active instanceof HTMLElement && !active.getClientRects().length);
        if (!lost || document.querySelector('[role="dialog"]')) return;
        messageRef.current?.focus({ preventScroll: true });
      });
    });
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [tour.completion]);

  // On narrow screens the document scrolls under one sticky rail (sections +
  // status). A new section starts directly below that rail instead of at the
  // previous section's scroll depth.
  function positionSection() {
    const grid = gridRef.current, rail = railRef.current;
    if (!grid || !rail || !window.matchMedia("(max-width: 1023px)").matches) return;
    const top = grid.getBoundingClientRect().top + window.scrollY - rail.offsetHeight;
    if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top) });
  }
  function changeTab(tab: View) {
    flushSync(() => setMobileTab(tab));
    positionSection();
  }
  // Opens a market's dossier and moves focus to its heading on every layout.
  function reviewCity(cityId: string) {
    flushSync(() => { tour.setSelectedId(cityId); setMobileTab("Dossier"); setReviewRequest((count) => count + 1); });
    const panel = document.querySelector<HTMLElement>(".dossier-panel");
    panel?.scrollTo({ top: 0 });
    positionSection();
    const heading = panel?.querySelector<HTMLElement>(".stop-heading h2");
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  // Restoring inputs removes the button itself; focus moves to the restored result.
  function restoreInputs() {
    tour.resetInputs();
    requestAnimationFrame(() => {
      const heading = document.getElementById("research-results");
      (heading?.getClientRects().length ? heading : messageRef.current)?.focus({ preventScroll: true });
    });
  }

  function exportDay(kind: "md" | "csv") {
    if (!plan || !canExport) return;
    downloadText(kind === "md" ? exportMarkdown(plan) : exportCsv(plan), `tourpulse-${plan.input.tourType}-${plan.input.startDate}-r${plan.revision}.${kind}`, kind === "md" ? "text/markdown;charset=utf-8" : "text/csv;charset=utf-8");
    setExportOpen(false); tour.setNotice(`Revision ${plan.revision} Day Sheet downloaded as ${kind.toUpperCase()}.`);
  }
  function print(kind: "day" | "brief" | "briefEvidence") {
    if (!canExport || (kind !== "day" && (!plan?.brief || plan.brief.revision !== plan.revision))) return;
    flushSync(() => { setPrintKind(kind); setExportOpen(false); });
    window.print();
  }
  // A preset that only fills the inputs leaves the next step on the Plan tab;
  // the clicked card is then hidden, so focus moves to the setup heading.
  async function startPreset(mode: TourType) {
    setPendingPreset(mode);
    try {
      if (await tour.loadPreset(mode) !== "inputs") return;
      changeTab("Plan");
      const heading = document.querySelector<HTMLElement>(".setup-panel h2");
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    } finally { setPendingPreset(null); }
  }
  async function askAgent(event?: React.FormEvent) {
    event?.preventDefault();
    if (!agentMessage.trim()) return;
    await tour.askAgent(agentMessage.trim());
  }

  return <main className="tour-app">
    <a className="skip-link" href="#research-results">Skip to research results</a>
    <header className="topbar">
      <a className="brand" href="/" aria-label="TourPulse home"><span className="brand-symbol"><Activity size={16} strokeWidth={2.5} /></span><span>Tour<span className="brand-light">Pulse</span></span></a>
      <span className="header-rule" aria-hidden="true"><ChevronRight size={14} /></span><span className="workspace-label"><Headphones size={16} />{modeLabels[settings.tourType]} planning</span>
      <div className="topbar-actions">{plan && <button className="preset-button" disabled={Boolean(working)} onClick={() => void startPreset(settings.tourType)}>{busy === "preset" ? <LoaderCircle size={14} className="spin" /> : <Play size={12} fill="currentColor" />}<span>Load preset</span></button>}{(working || plan) && <span className={`connection ${plan ? "connected" : ""}`}><span />{working ? busyShort : `Saved revision ${plan?.revision}`}</span>}
        <div className="export-control" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setExportOpen(false); }} onKeyDown={(event) => { if (event.key === "Escape") setExportOpen(false); }}>
          <button className="button-secondary" disabled={!canExport} aria-expanded={exportOpen} onClick={() => setExportOpen(!exportOpen)}><Download size={15} /><span>Export</span><ChevronDown size={13} /></button>
          {exportOpen && <div className="export-menu"><button onClick={() => exportDay("md")}><FileText size={15} />Day Sheet (.md)</button><button onClick={() => exportDay("csv")}><Download size={15} />Day Sheet (.csv)</button><button onClick={() => print("day")}><Printer size={15} />Print Day Sheet</button>{plan?.brief && <><button onClick={() => { downloadText(exportBriefMarkdown(plan.brief!), `tourpulse-proposal-r${plan.revision}.md`, "text/markdown;charset=utf-8"); setExportOpen(false); }}><FileText size={15} />Recipient proposal (.md)</button><button onClick={() => { downloadText(exportBriefEvidenceMarkdown(plan.brief!, plan), `tourpulse-proposal-evidence-r${plan.revision}.md`, "text/markdown;charset=utf-8"); setExportOpen(false); }}><FileText size={15} />Proposal evidence (.md)</button><button onClick={() => print("brief")}><Printer size={15} />Print recipient proposal</button><button onClick={() => print("briefEvidence")}><Printer size={15} />Print proposal evidence</button></>}</div>}
        </div>
      </div>
    </header>

    <div className="workspace-rail" ref={railRef}>
      <nav className="mobile-tabs" aria-label="Workspace sections">{(["Plan", "Map", "Dossier", "Trace"] as const).map((tab) => <button key={tab} aria-current={mobileTab === tab ? "page" : undefined} onClick={() => changeTab(tab)}>{tab === "Map" ? "Route" : tab}</button>)}</nav>
      {(tour.error || tour.notice || dirty || working) && <div ref={messageRef} tabIndex={-1} className={`message-bar ${tour.error ? "error" : dirty ? "warning" : ""}`} role={tour.error ? "alert" : "status"}>
      <span className="message-text">{working && !tour.error && !dirty && <LoaderCircle size={14} className="spin" aria-hidden="true" />} {tour.error || (dirty ? "Inputs changed. The previous result is read-only until you Plan tour again." : working ? busyLong : tour.notice)}{!tour.error && !dirty && latestTrace && <small className="message-progress" aria-live="off">Latest update: {latestTrace.message}</small>}</span>
      <div className="message-actions">
        {busy && ["preview", "brief"].includes(busy) && <button className="text-button" onClick={tour.stopAgentRequest}>Stop AI response</button>}
        {dirty && <button className="text-button" disabled={Boolean(working)} onClick={restoreInputs}>Restore inputs</button>}
        {tour.errorStatus === 401 && <button className="text-button" disabled={Boolean(busy)} onClick={() => void tour.resetSession()}>Start new session</button>}
        {!working && run && ["failed", "interrupted", "cancelled"].includes(run.status) && <>
          {(run.previousRunId || tour.history.length > 0) && <button className="text-button" onClick={() => void tour.undo()}>Undo last change</button>}
          {run.status !== "cancelled" && <button className="text-button" disabled={dirty} onClick={() => void tour.retry()}>Resume saved attempt</button>}
          <button className="text-button" onClick={() => void startPreset(settings.tourType)}>Load a preset</button>
        </>}
        {tour.error && !run && tour.hasSavedRun && <button className="text-button" disabled={Boolean(busy)} onClick={() => void tour.refresh()}>Reconnect saved run</button>}
        {!working && !plan && !run && tour.history.length > 0 && <button className="text-button" onClick={() => void tour.undo()}>Undo last change</button>}
        {tour.error && <button className="icon-button" aria-label="Dismiss error" onClick={tour.dismissError}><X size={15} /></button>}
      </div>
    </div>}
    </div>

    <div className="workspace-grid" data-mobile-tab={mobileTab} ref={gridRef}>
      <aside className="setup-panel">
        <div className="panel-heading"><span><Headphones size={16} />Audience</span></div>
        <fieldset className="setup-fields" disabled={Boolean(working)}>
          <section className="audience-section">
            <label className="stacked-field mode-field">Tour format<select value={settings.tourType} onChange={(event) => { const mode = tourTypes.find((item) => item === event.target.value); if (mode) { tour.changeMode(mode); setActiveAnchor(null); } }}>{tourTypes.map((mode) => <option key={mode} value={mode}>{modeLabels[mode]}</option>)}</select></label>
            {headliner ? <div className="headliner-card"><span className="artist-avatar"><Music2 size={23} /></span><div><span className="field-label">{settings.tourType === "podcast" ? "Headlining program" : "Headliner"}</span><strong>{headliner.name}</strong></div><button className="icon-button" aria-label="Change headliner" onClick={() => tour.chooseHeadliner(null)}><X size={15} /></button></div> : <EntitySearch label={settings.tourType === "podcast" ? "Headlining program" : "Headliner"} type={headlinerTypes[settings.tourType]} disabled={Boolean(working)} onSelect={tour.chooseHeadliner} />}
            <div className="anchor-heading"><span className="field-label">Cultural anchors</span><span className="subtle">{anchors.length} / 4</span></div>
            <div className="anchor-list">{anchors.map((entity) => <div className={`anchor-chip ${activeAnchor === entity.id ? "selected" : ""}`} key={entity.id}><button className="anchor-name" aria-pressed={activeAnchor === entity.id} onClick={() => setActiveAnchor(activeAnchor === entity.id ? null : entity.id)}><span>{entityTypeLabel(entity.type)}</span>{entity.name}</button><button className="icon-button" aria-label={`Remove ${entity.name}`} onClick={() => { tour.chooseAnchors(anchors.filter((a) => a.id !== entity.id)); if (activeAnchor === entity.id) setActiveAnchor(null); }}><X size={12} /></button></div>)}</div>
            {anchors.length < 4 && <div className="anchor-add"><label className="sr-only" htmlFor="anchor-category">Anchor category</label><select id="anchor-category" value={anchorType} onChange={(event) => { const type = entityTypes.find((item) => item === event.target.value); if (type) setAnchorType(type); }}>{(["movie", "tv_show", "brand", "podcast", "book"] as const).map((type) => <option key={type} value={type}>{entityTypeLabel(type)}</option>)}</select><EntitySearch label="Add an anchor" type={anchorType} disabled={Boolean(working)} excluded={[...anchors.map((a) => a.id), ...(headliner ? [headliner.id] : [])]} onSelect={(entity) => tour.chooseAnchors([...anchors, entity])} /></div>}
          </section>
          <section className="settings-section"><div className="section-title"><SlidersHorizontal size={15} /><h2>Tour setup</h2></div>
            <span className="field-label">Candidate markets</span><div className="fixed-field"><MapPin size={14} /><span className="fixed-field-name">{settings.candidateCityIds.length ? "Custom candidate set" : "Northeast & Mid-Atlantic"}</span><span>{settings.candidateCityIds.length || 8} cities</span></div>
            <div className="form-pair"><label>Stops<input aria-label="Number of stops" type="number" min={2} max={6} value={Number.isFinite(settings.stopCount) ? settings.stopCount : ""} onChange={(e) => tour.changeSetting("stopCount", e.target.valueAsNumber)} /></label><label>Target seats<input aria-label="Target seats" type="number" min={50} max={10000} step={50} value={Number.isFinite(settings.capacity) ? settings.capacity : ""} onChange={(e) => tour.changeSetting("capacity", e.target.valueAsNumber)} /></label></div>
            <div className="form-pair dates"><label>First day<input type="date" value={settings.startDate} onChange={(e) => tour.changeSetting("startDate", e.target.value)} /></label><label>Last day<input type="date" min={settings.startDate} value={settings.endDate} onChange={(e) => tour.changeSetting("endDate", e.target.value)} /></label></div>
            <label className="stacked-field">Departure city<select value={settings.startCity} onChange={(e) => tour.changeSetting("startCity", e.target.value)}>{candidateCities.map((city) => <option key={city.name}>{city.name}</option>)}</select></label>
            <label className="drive-label" htmlFor="drive-hours">Maximum daily drive<strong>{settings.maxDriveHours} hours</strong></label><input id="drive-hours" className="range-input" type="range" min={1} max={10} step={0.5} value={settings.maxDriveHours} onChange={(e) => tour.changeSetting("maxDriveHours", Number(e.target.value))} />
            <label className="stacked-field">Show-day preference<select value={settings.showDayPreference} onChange={(event) => tour.changeSetting("showDayPreference", event.target.value === "thu_sat" ? "thu_sat" : "compact")}><option value="compact">Compact: fewest off days</option><option value="thu_sat">Prefer Thursday–Saturday</option></select></label>
            <details className="played-settings"><summary>Markets already played</summary><div>{(plan?.candidateCities ?? candidateCities).map((city) => <label key={city.name}><input type="checkbox" checked={settings.alreadyPlayed.includes(city.name)} onChange={(e) => tour.changeSetting("alreadyPlayed", e.target.checked ? [...settings.alreadyPlayed, city.name] : settings.alreadyPlayed.filter((name) => name !== city.name))} />{city.name}</label>)}</div></details>
          </section>
        </fieldset>
        <div className="plan-action">{working && ["plan", "apply", "retry", "running", "queued"].includes(working) ? <button className="button-primary" onClick={() => void tour.cancel()}><Square size={13} fill="currentColor" />Cancel run</button> : <button className="button-primary" disabled={!headliner || Boolean(working)} onClick={async () => { if (await tour.start()) changeTab("Map"); }}><span>Plan tour</span><ArrowRight size={16} /></button>}</div>
        {plan && <section className="agent-panel"><div className="section-title"><Activity size={15} /><h2>Ask the agent</h2></div>
          <form onSubmit={askAgent}><label className="sr-only" htmlFor="agent-message">Requested plan change</label><textarea id="agent-message" aria-describedby={agentMessage.length > agentMessageLimit * 0.8 ? "agent-character-count" : undefined} value={agentMessage} maxLength={agentMessageLimit} disabled={!tour.canMutate} onChange={(e) => setAgentMessage(e.target.value)} placeholder="Swap Boston for Montreal…" rows={3} />{agentMessage.length > agentMessageLimit * 0.8 && <p id="agent-character-count" className="field-hint">{agentMessage.length} / {agentMessageLimit} characters</p>}<div className="agent-controls">{busy === "preview" ? <button className="button-secondary" type="button" onClick={tour.stopAgentRequest}><Square size={12} />Stop response</button> : <button className="button-secondary" disabled={!tour.canMutate || !agentMessage.trim()} type="submit"><Send size={13} />Preview change</button>}<button type="button" className="text-button" aria-describedby="undo-context" disabled={Boolean(working) || !undoAvailable || dirty} title={undoContext} onClick={() => void tour.undo()}><Undo2 size={13} />Undo last change</button></div><p id="undo-context" className="sr-only">{undoContext}</p></form>
          <div className="agent-examples">{["Limit the daily drive to 3 hours.", "Swap Boston for Montreal.", "Only non-alcoholic beverage sponsors."].map((example) => <button disabled={!tour.canMutate} key={example} onClick={() => setAgentMessage(example)}>{example}</button>)}</div>
          {tour.preview && <ActionPreviewCard preview={tour.preview} canApply={Boolean(tour.canMutate && tour.preview.expectedRevision === plan?.revision && tour.preview.action)} busy={busy === "apply"} onApply={() => { if (tour.preview?.action) void tour.apply(tour.preview.action); }} />}
        </section>}
      </aside>

      <section className="center-panel"><div className="route-heading"><div><h1 id="research-results" tabIndex={-1}>{plan ? plan.headliner.name : "Good taste travels."}</h1>
        {plan && <p className="route-meta"><span>{modeLabels[plan.input.tourType]}</span><span>{plan.stops.length} markets</span><span>{shortDate(plan.input.startDate)}–{shortDate(plan.input.endDate)}</span></p>}</div></div>
        {!plan && <div className="preset-cards">{tourTypes.map((mode) => {
          const Icon = modeIcons[mode];
          return <button key={mode} className="preset-card" disabled={Boolean(working)} aria-label={`Load ${modeLabels[mode]} preset: ${presetSeeds[mode].headliner[0]}`} onClick={() => void startPreset(mode)}>
            <span className="preset-card-icon">{busy === "preset" && pendingPreset === mode ? <LoaderCircle size={20} className="spin" /> : <Icon size={20} />}</span>
            <span className="preset-card-mode">{modeLabels[mode]}</span><strong>{presetSeeds[mode].headliner[0]}</strong><ArrowRight size={16} aria-hidden="true" />
          </button>;
        })}</div>}
        {plan?.schedule.feasible && <RouteMetrics plan={plan} />}
        {plan && <Tabs.Root value={centerTab} onValueChange={setCenterTab}>
          <Tabs.List className="page-tabs" aria-label="Route views"><Tabs.Trigger value="overview">Overview</Tabs.Trigger><Tabs.Trigger value="schedule">Day sheet</Tabs.Trigger><Tabs.Trigger value="map">Map and neighborhoods</Tabs.Trigger></Tabs.List>
          <div className="page-toolbar"><span className="status-chip"><i aria-hidden="true" />Tentative · revision {plan.revision}</span><button className="button-secondary" aria-expanded={showScores} onClick={() => setShowScores(!showScores)}><CircleHelp size={15} />How evidence is ranked</button></div>
        {showScores && <div className="score-explainer"><strong>Discovery signals, not demand forecasts.</strong><p>City Fit blends destination rank (60%) and mean venue / partner affinity (40%). If place evidence is missing, only destination rank is used. Support and sponsor comparisons use the same retained places and withhold composite ordering when evidence is incomplete or sensitive. Candidates are potential partners and sponsors only; no partnership, intent or permission is implied.</p><p>Anchor Delta compares the entire anchor bundle to the headliner alone. Heatmap contributions are grouped by entity type, not individual causal effects. The Niche / Broad slider previews neighborhood scores locally.</p><p>Target seats select venue types, not verified capacity. Drive estimates use straight-line distance × 1.25 at 90 km/h. No venue, artist or sponsor availability is guaranteed.</p></div>}
        <Tabs.Content value="map" className="page-tab-content"><RouteOverview plan={plan} selectedId={tour.selectedId} onSelect={tour.setSelectedId} onNeighborhoodSelect={(cityId, geohash) => void tour.apply({ type: "select_neighborhood", cityId, geohash })} activeAnchor={activeAnchor} nicheWeight={plan.input.nicheWeight ?? settings.nicheWeight} disabled={!tour.canMutate} /></Tabs.Content>
          {plan && !plan.schedule.feasible && <div className="infeasible" role="alert"><h2>This route needs more room.</h2><p>{plan.schedule.extraDays} additional day{plan.schedule.extraDays === 1 ? "" : "s"} needed under the current limits.</p><ul>{plan.schedule.suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}</ul><button className="button-secondary" onClick={() => changeTab("Plan")}>Adjust tour setup</button></div>}
        <Tabs.Content value="overview" className="page-tab-content">
          {plan.schedule.feasible && <div className="chart-grid"><RouteOrderChart plan={plan} /><DailyDriveChart plan={plan} /></div>}
        {plan && <DecisionOverview plan={plan} onReview={reviewCity} />}
        {plan && <HistoricalResearchPanel markets={historicalResearch} liveStopIds={liveStopIds} planKey={run?.id ?? plan.id} disabled={!tour.canMutate} blockedReason={!tour.canMutate ? (working ? "Finish the current run before changing historical research." : dirty ? "Inputs changed. Replan before changing historical research." : "Reconnect to the completed saved revision before changing historical research.") : null} onApply={tour.apply} />}
        </Tabs.Content>
        <Tabs.Content value="schedule" className="page-tab-content day-sheet">
          {plan?.schedule.feasible && <div className="day-sheet-scroll"><table className="itinerary-table"><caption className="sr-only">Tentative itinerary including selected venue, support and sponsor. All driving is estimated.</caption><thead><tr><th>Day</th><th>Stop / selections</th><th>Drive</th><th>Venue review</th></tr></thead><tbody>{plan.schedule.rows.map((row, index) => {
            const stop = plan.stops.find((item) => item.id === row.cityId);
            const decision = stop?.venueDecisions.find((item) => item.entityId === stop.selectedVenueId);
            return <tr key={`${row.date}-${index}`} className={`${row.kind !== "show" ? "non-show" : ""} ${row.cityId === tour.selectedId ? "selected-row" : ""}`}><td><strong>{shortDate(row.date)}</strong><small>{weekday(row.date)}</small></td><td>{row.kind === "show" && stop ? <button className="stop-button" onClick={() => reviewCity(stop.id)}><strong>{row.city}</strong><span>{row.venue || "Choose a venue candidate"}</span>{row.neighborhood && <small>{row.neighborhood}</small>}<small>Support: {row.support.join("; ") || "not selected"}</small><small>Sponsor: {row.sponsors.join("; ") || "not selected"}</small></button> : <><strong>{row.kind === "rest" ? "Non-show / rest day" : "Travel day"}</strong><small>{row.reason}</small></>}{row.warnings.map((warning) => <small className="inline-warning" key={warning}>{warning}</small>)}</td><td>{Math.round(row.driveKm)} km<small>{row.driveHours.toFixed(1)} h est.</small></td><td>{row.kind === "show" ? decision ? <span className={`decision-badge ${decision.needsReview ? "review" : decision.status}`} title={decision.needsReview ? "Marked for review after a newer source check or a show-date change. Your earlier reason is kept." : undefined}>{decision.needsReview ? "Revisit decision" : decisionLabels[decision.status]}</span> : <span className="decision-badge unreviewed">Needs assessment</span> : "—"}</td></tr>;
          })}</tbody></table></div>}
          {plan && <details className="plan-warnings"><summary>Data and operating limits</summary>{[...new Set([...plan.warnings, ...plan.schedule.warnings])].map((warning) => <p key={warning}>{warning}</p>)}</details>}
        </Tabs.Content></Tabs.Root>}
      </section>

      <StopDossier plan={plan} stop={selectedStop} canMutate={tour.canMutate} busy={busy} reviewRequest={reviewRequest} activeAnchor={activeAnchor} onApply={tour.apply} onDraft={tour.draft} onPrintBrief={() => print("brief")} onPrintBriefEvidence={() => print("briefEvidence")} />
      <section className={`trace-panel${traceOpen ? " open" : ""}`}><button className="panel-heading trace-toggle" aria-expanded={narrow || traceOpen} disabled={narrow} onClick={() => setTraceOpen(!traceOpen)}><span><Activity size={15} />Evidence and activity{working && <LoaderCircle size={13} className="spin" />}</span><span className="subtle">{tour.traces.length} {tour.traces.length === 1 ? "step" : "steps"}{tour.traces.length > 0 && ` · last: ${tour.traces.at(-1)?.step}`}<ChevronDown size={14} aria-hidden="true" /></span></button>
        <div className="trace-controls">{run && <span>Run {run.status} · revision {run.revision}</span>}<button className="text-button" disabled={!tour.hasSavedRun || Boolean(busy)} onClick={() => void tour.refresh()}><RefreshCw size={12} />Reconnect</button></div>
        <div className="trace-content">{!tour.traces.length ? <p className="trace-empty">No activity yet.</p> : tour.traces.map((trace, index) => <details key={`${index}-${trace.step}`} className={`trace-item ${trace.status}`}><summary><span className="trace-dot" /><span>{trace.step}</span><span className="trace-message">{trace.message}</span><span className="trace-time">{trace.evidence?.cached ? "cache" : `${Math.round(trace.ms)} ms`}</span></summary><div><p>{trace.count} results · {trace.status}</p>{trace.evidence && <><code>{trace.evidence.endpoint}</code><small>Source fetched {new Date(trace.evidence.fetchedAt).toLocaleString()}</small><pre>{JSON.stringify(trace.evidence.params, null, 2)}</pre></>}</div></details>)}</div>
      </section>
    </div>
    <footer className="workspace-footer"><span><span className="footer-dot" />Discovery, not a demand forecast or booking</span><JudgingAccess /><span>Run history expires after 48 hours</span></footer>

    {plan && <div className="print-sheet" data-print-kind={printKind}>
      {!canExport ? <p>This is not a current, feasible itinerary. Restore or replan before exporting.</p> : printKind !== "day" && plan.brief ? <ProposalPrint brief={plan.brief} evidenceOnly={printKind === "briefEvidence"} plan={plan} /> : <DaySheetPrint plan={plan} />}
    </div>}
  </main>;
}
