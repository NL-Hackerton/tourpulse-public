"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { briefSchema, planInputSchema, presetResponseSchema, previewSchema, runResponseSchema, type ActionPreview, type Entity, type PlanAction, type PlanInput, type RunSnapshot, type TourPlan, type TourType, type Trace } from "@/lib/contracts";
import { allowedAnchor, validHeadliner } from "@/lib/entity-policy";
import { ClientError, requestJson, streamRun } from "@/lib/client";

export type Settings = Omit<PlanInput, "headlinerId" | "anchorIds">;
export const initialSettings: Settings = { tourType: "music", stopCount: 4, startDate: "2026-11-05", endDate: "2026-11-18", startCity: "Philadelphia", maxDriveHours: 5, showDayPreference: "compact", capacity: 300, alreadyPlayed: [], candidateCityIds: [], neighborhoods: [], sponsorIncludeTags: [], sponsorExcludeTags: [], nicheWeight: 0.3, proposalPreferences: { proposalType: "on_site_activation", focusCityId: null, constraints: [] } };
// Revisioned storage keeps sessions on the current persisted plan contract.
export const savedRunKey = "tourpulse:v10:last-run";
export const historyKey = "tourpulse:v10:run-history";
// A successful operation the workspace may acknowledge (for example by moving
// lost keyboard focus to the status message). `id` changes on every success.
export interface Completion { id: number; kind: "plan" | "apply" | "retry" | "undo" | "reconnect" | "brief"; action: PlanAction["type"] | null }

export function useTour() {
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [headliner, setHeadliner] = useState<Entity | null>(null);
  const [anchors, setAnchors] = useState<Entity[]>([]);
  const [plan, setPlan] = useState<TourPlan | null>(null);
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<ActionPreview | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [activeAction, setActiveAction] = useState<PlanAction["type"] | null>(null);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const activeId = useRef<string | null>(null);
  const runRef = useRef<RunSnapshot | null>(null);
  runRef.current = run;
  function completed(kind: Completion["kind"], action: PlanAction["type"] | null = null) { setCompletion((last) => ({ id: (last?.id ?? 0) + 1, kind, action })); }

  function failure(cause: unknown) {
    setError(cause instanceof z.ZodError ? "The response did not match the supported contract. No incomplete result was applied." : cause instanceof Error ? cause.message : "The operation could not complete. Try again.");
    setErrorStatus(cause instanceof ClientError ? cause.status : null);
  }
  function remember(id: string) {
    activeId.current = id;
    try { sessionStorage.setItem(savedRunKey, id); } catch { /* Persistence may be disabled; the current workspace still works. */ }
  }
  function saveHistory(ids: string[]) {
    setHistory(ids);
    try { sessionStorage.setItem(historyKey, JSON.stringify(ids)); } catch { /* History remains available in this tab. */ }
  }
  function showPlan(next: TourPlan) {
    setPlan(next); setSettings(next.input); setHeadliner(next.headliner); setAnchors(next.anchors); setDirty(false); setPreview(null);
    setSelectedId((id) => next.stops.some((stop) => stop.id === id) ? id : next.schedule.orderedStopIds[0] ?? next.stops[0]?.id ?? "");
  }
  function accept(snapshot: RunSnapshot) {
    remember(snapshot.id); setRun(snapshot); setTraces(snapshot.plan?.trace ?? snapshot.trace);
    if (snapshot.plan) showPlan(snapshot.plan);
    if (snapshot.status === "complete") { setError(""); setErrorStatus(null); }
    else if (snapshot.error && snapshot.status !== "cancelled") { setError(snapshot.error); setErrorStatus(null); }
    if (snapshot.error) setNotice(snapshot.error);
  }
  function invalidate() { setDirty(Boolean(plan)); setPreview(null); setNotice(""); }
  function changeSetting<K extends keyof Settings>(key: K, value: Settings[K]) { setSettings((s) => ({ ...s, [key]: value })); invalidate(); }
  function changeMode(mode: TourType) {
    setSettings((s) => ({ ...s, tourType: mode, neighborhoods: [] }));
    if (headliner && !validHeadliner(headliner, mode)) setHeadliner(null);
    setAnchors((items) => items.filter(allowedAnchor)); invalidate();
  }
  function chooseHeadliner(entity: Entity | null) { setHeadliner(entity); if (entity) setAnchors((items) => items.filter((a) => a.id !== entity.id)); invalidate(); }
  function chooseAnchors(items: Entity[]) { setAnchors(items); invalidate(); }
  function resetInputs() { const saved = run?.plan ?? plan; if (saved) showPlan(saved); }

  // Resolves to what was loaded: a saved sample result, or only its inputs.
  async function loadPreset(mode: TourType, recordHistory = true): Promise<"sample" | "inputs" | null> {
    controller.current?.abort(); const current = ++generation.current; const abort = new AbortController(); controller.current = abort;
    setBusy("preset"); setError(""); setErrorStatus(null); setPreview(null);
    const oldId = runRef.current?.status === "complete" ? runRef.current.id : runRef.current?.previousRunId;
    try {
      try {
        const copied = await requestJson("/api/sample", runResponseSchema, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, requestId: crypto.randomUUID() }), signal: abort.signal });
        if (current !== generation.current) return null;
        if (recordHistory && oldId && oldId !== copied.run.id) saveHistory([...history.filter((id) => id !== oldId), oldId].slice(-20));
        accept(copied.run); setNotice("Showing a real cached sample.");
        return "sample";
      } catch (cause) {
        if (!(cause instanceof ClientError && cause.status === 404)) throw cause;
        const preset = await requestJson(`/api/preset?mode=${mode}`, presetResponseSchema, { signal: abort.signal });
        if (current !== generation.current) return null;
        setSettings({ ...initialSettings, tourType: mode }); setHeadliner(preset.headliner); setAnchors(preset.anchors);
        setPlan(null); setRun(null); activeId.current = null; setTraces([]); setDirty(false);
        setNotice("Preset loaded. Choose Plan tour to generate a result.");
        return "inputs";
      }
    } catch (cause) { if (!abort.signal.aborted && current === generation.current) failure(cause); }
    finally { if (current === generation.current) setBusy(null); }
    return null;
  }

  async function readRun(id: string, fallbackId = history.at(-1)) {
    const current = generation.current;
    const { run: snapshot } = await requestJson(`/api/runs/${encodeURIComponent(id)}`, runResponseSchema);
    if (current !== generation.current) throw new DOMException("This restore was superseded.", "AbortError");
    let previous: RunSnapshot | null = null;
    const previousId = snapshot.previousRunId ?? fallbackId;
    if (!snapshot.plan && previousId && previousId !== snapshot.id) {
      try { previous = (await requestJson(`/api/runs/${encodeURIComponent(previousId)}`, runResponseSchema)).run; }
      catch (cause) {
        if (!(cause instanceof ClientError && cause.status === 404)) {
          if (current === generation.current) accept(snapshot);
          throw cause;
        }
      }
    }
    if (current !== generation.current) throw new DOMException("This restore was superseded.", "AbortError");
    accept(snapshot);
    if (previous?.plan && previous.status === "complete") {
      showPlan(previous.plan);
      setNotice(`Saved attempt is ${snapshot.status}. Revision ${previous.revision} is shown read-only; restore it or resume the attempt.`);
      if (snapshot.error && snapshot.status !== "cancelled") setError(`${snapshot.error} Previous revision ${previous.revision} is shown read-only. Restore it or resume the saved attempt.`);
    } else if (snapshot.status !== "complete") setNotice(`Saved attempt is ${snapshot.status}. Resume it or load a preset; no incomplete result was applied.`);
    return snapshot;
  }
  async function refresh() {
    if (!activeId.current) return;
    setBusy("reconnect"); setError("");
    try { const next = await readRun(activeId.current); if (next.status === "complete") { setNotice("Saved result restored."); completed("reconnect"); } }
    catch (cause) { failure(cause); } finally { setBusy(null); }
  }
  async function execute(url: string, body: unknown, kind: "plan" | "apply" | "retry") {
    controller.current?.abort(); const current = ++generation.current; const abort = new AbortController(); controller.current = abort;
    const before = runRef.current; let acceptedId: string | null = kind === "retry" ? before?.id ?? null : null;
    let returnedPlan: TourPlan | null = null;
    let successful = false;
    setBusy(kind); setError(""); setErrorStatus(null); setNotice(""); setPreview(null); setTraces([]);
    if (kind === "plan") setPlan(null);
    try {
      await streamRun(url, body, abort.signal, (event) => {
        if (current !== generation.current) return;
        if (event.type === "accepted") {
          acceptedId = event.runId; remember(event.runId);
          const priorId = before?.status === "complete" ? before.id : before?.previousRunId ?? history.at(-1);
          if (priorId && priorId !== event.runId && kind !== "retry") saveHistory([...history.filter((id) => id !== priorId), priorId].slice(-20));
          setRun({ id: event.runId, revision: event.revision, status: "running", updatedAt: new Date().toISOString(), plan: null, trace: [], error: null, previousRunId: kind === "retry" ? before?.previousRunId ?? null : kind === "apply" ? before?.id ?? null : null });
        } else if (event.type === "trace") setTraces((items) => [...items, event.trace]);
        else if (event.type === "error") { setError(event.message); setRun((r) => r ? { ...r, status: "failed", error: event.message } : r); }
        else { returnedPlan = event.plan; setPlan(event.plan); setTraces(event.plan.trace); }
      });
      if (acceptedId && current === generation.current) {
        const final = await requestJson(`/api/runs/${encodeURIComponent(acceptedId)}`, runResponseSchema, { signal: abort.signal });
        accept(final.run);
        if (final.run.status === "complete") {
          successful = true;
          const feasible = final.run.plan?.schedule.feasible;
          setNotice(kind === "apply" ? `Change saved as revision ${final.run.plan?.revision ?? final.run.revision}.${feasible ? "" : " This tour no longer fits the window; adjust the dates or driving limit."}`
            : feasible ? "Tour ready. Review candidates and confirm operational details before outreach." : "This tour does not fit the window. Adjust the dates or driving limit.");
        }
        else if (final.run.error) setError(final.run.error);
      } else if (returnedPlan && !acceptedId) throw new ClientError("The server did not identify a saved run. Reconnect before using this result.", 502);
    } catch (cause) {
      if (!abort.signal.aborted && current === generation.current) {
        if (!acceptedId && kind === "plan") { setPlan(before?.plan ?? null); setDirty(Boolean(before?.plan)); }
        failure(cause);
        setNotice(acceptedId ? "Reconnect to inspect the saved run. Retry only after its execution is interrupted or failed." : "No new run was accepted. Your previous saved result is unchanged; retry when capacity is available.");
      }
    } finally { if (current === generation.current) setBusy(null); }
    return successful;
  }
  async function start() {
    if (!headliner || !validHeadliner(headliner, settings.tourType)) { setError("Search and select a verified headliner for this tour mode."); return; }
    const input = planInputSchema.safeParse({ ...settings, headlinerId: headliner.id, anchorIds: anchors.map((a) => a.id) });
    if (!input.success) { setError(input.error.issues.map((i) => i.message).join(". ")); return; }
    setDirty(false);
    const planned = await execute("/api/plan", input.data, "plan");
    if (planned) completed("plan");
    return planned;
  }
  async function apply(action: PlanAction) {
    if (!run || !plan || dirty || busy || run.status !== "complete") return false;
    setActiveAction(action.type);
    try {
      const applied = await execute("/api/apply", { runId: run.id, expectedRevision: plan.revision, action }, "apply");
      if (applied && action.type === "replace_city") setSelectedId(action.replacementId);
      if (applied) completed("apply", action.type);
      return applied;
    } finally { setActiveAction(null); }
  }
  async function retry() { if (run && !dirty && ["failed", "interrupted"].includes(run.status) && await execute(`/api/runs/${run.id}/retry`, {}, "retry")) completed("retry"); }
  async function cancel() {
    const id = activeId.current; ++generation.current; controller.current?.abort(); setBusy("cancel");
    try {
      if (id) { const response = await requestJson(`/api/runs/${id}`, runResponseSchema, { method: "DELETE" }); accept(response.run); }
      setNotice("Cancellation recorded. Already completed provider work may remain in the private cache.");
    } catch (cause) { failure(cause); } finally { setBusy(null); }
  }
  async function undo() {
    const id = run?.previousRunId ?? history.at(-1);
    if (!id || busy || (run && ["queued", "running"].includes(run.status))) return;
    setBusy("undo"); setError("");
    const undone = plan?.revision;
    try {
      const restored = await readRun(id);
      saveHistory(history.filter((entry) => entry !== id));
      if (restored.status === "complete") {
        const revision = restored.plan?.revision ?? restored.revision;
        setNotice(`${undone !== undefined && undone !== revision ? `Undid revision ${undone} and restored` : "Restored"} saved revision ${revision}. No new Qloo request was needed.`);
        completed("undo");
      }
    }
    catch (cause) { failure(cause); } finally { setBusy(null); }
  }
  async function askAgent(message: string) {
    if (!run || !plan || dirty || busy || run.status !== "complete") return;
    const abort = new AbortController(); controller.current = abort; const current = ++generation.current;
    setBusy("preview"); setError(""); setPreview(null);
    try {
      const next = await requestJson("/api/replan", previewSchema, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: run.id, expectedRevision: plan.revision, message }), signal: abort.signal });
      if (current === generation.current) setPreview(next);
    } catch (cause) { if (!abort.signal.aborted) failure(cause); } finally { if (current === generation.current) setBusy(null); }
  }
  async function draft() {
    if (!run || !plan?.selectedSponsorId || dirty || busy || run.status !== "complete") return;
    const abort = new AbortController(); controller.current = abort; const current = ++generation.current;
    setBusy("brief"); setError("");
    try {
      const result = await requestJson("/api/brief", z.object({ brief: briefSchema }), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: run.id, expectedRevision: plan.revision, brandId: plan.selectedSponsorId }), signal: abort.signal });
      if (current === generation.current) { setPlan((p) => p?.revision === result.brief.revision ? { ...p, brief: result.brief } : p); await readRun(run.id); setNotice("Source-grounded proposal draft saved for this revision. Review before outreach."); completed("brief"); }
    } catch (cause) { if (!abort.signal.aborted) failure(cause); } finally { if (current === generation.current) setBusy(null); }
  }
  function stopAgentRequest() { ++generation.current; controller.current?.abort(); setBusy(null); setNotice("AI response stopped in this tab. No proposed change was applied."); }
  async function resetSession() {
    setBusy("session");
    try {
      await requestJson("/api/session", z.object({ reset: z.literal(true) }), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reset: true }) });
      try { sessionStorage.removeItem(savedRunKey); sessionStorage.removeItem(historyKey); } catch { /* Recovery still works when browser storage is disabled. */ }
      saveHistory([]); activeId.current = null; setRun(null); setPlan(null);
      await loadPreset(settings.tourType, false);
    } catch (cause) { failure(cause); } finally { setBusy(null); }
  }

  useEffect(() => {
    let disposed = false;
    const boot = async () => {
      let id: string | null = null;
      let restoredHistory: string[] = [];
      try {
        id = sessionStorage.getItem(savedRunKey);
        const old: unknown = JSON.parse(sessionStorage.getItem(historyKey) ?? "[]");
        const parsed = z.array(z.uuid()).max(20).safeParse(old); if (parsed.success) { restoredHistory = parsed.data; setHistory(parsed.data); }
      } catch { /* Invalid local references are not accepted as server state. */ }
      if (id && z.uuid().safeParse(id).success) {
        setBusy("reconnect");
        activeId.current = id;
        try {
          const snapshot = await readRun(id, restoredHistory.at(-1));
          if (!disposed && snapshot.status === "complete") setNotice("Restored your saved run.");
          return;
        } catch (cause) {
          if (disposed) return;
          if (!(cause instanceof ClientError && cause.status === 404)) { failure(cause); return; }
        }
        finally { if (!disposed) setBusy(null); }
      }
      if (!disposed) await loadPreset("music", false);
    };
    void boot();
    return () => { disposed = true; controller.current?.abort(); ++generation.current; };
    // The initial private-session restore runs once per mounted workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (busy || !run || !["queued", "running"].includes(run.status)) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      try { const next = await requestJson(`/api/runs/${run.id}`, runResponseSchema, { signal: abort.signal }); accept(next.run); }
      catch (cause) { if (!abort.signal.aborted) failure(cause); }
    }, 1800);
    return () => { clearTimeout(timer); abort.abort(); };
    // A saved run is polled only while its genuine server state is active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, busy]);

  return { settings, headliner, anchors, plan, run, traces, selectedId, setSelectedId, busy, activeAction, completion, dirty, error, errorStatus, notice, preview, history,
    canMutate: Boolean(plan && run?.status === "complete" && !busy && !dirty),
    hasSavedRun: Boolean(activeId.current),
    changeSetting, changeMode, chooseHeadliner, chooseAnchors, resetInputs, loadPreset, start, apply, retry, cancel, undo, refresh, askAgent, draft, resetSession, stopAgentRequest,
    dismissError: () => { setError(""); setErrorStatus(null); }, setNotice };
}
