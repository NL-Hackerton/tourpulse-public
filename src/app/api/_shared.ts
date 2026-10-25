import { z } from "zod";
import { checkBotId } from "botid/server";
import { ServiceError } from "@/lib/cache";
import { AgentError } from "@/lib/agent";
import { planEventSchema, runResponseSchema, type PlanEvent, type Trace } from "@/lib/contracts";
import { applyAction } from "@/lib/actions";
import { createTour } from "@/lib/planner";
import { QlooError, safeError } from "@/lib/qloo";
import { checkpointRun, claimRun, type RunRecord } from "@/lib/runs";
import { acquireWork } from "@/lib/admission";
import { judgingSession } from "@/lib/session";
import { workContext } from "@/lib/work-context";

export const revisionRequest = z.object({ runId: z.uuid(), expectedRevision: z.number().int().positive() });
export async function verifyBrowser() {
  let isBot: boolean;
  try { ({ isBot } = await checkBotId({ advancedOptions: { checkLevel: "basic" } })); }
  catch { throw new ServiceError("Browser verification is unavailable. Reload the page and retry; no provider work was started."); }
  if (isBot) throw new ServiceError("Browser verification failed. Open the application in a regular browser, reload it and retry.", 403);
}
export async function withWorkSlot(request: Request, operation: () => Promise<Response>): Promise<Response> {
  await verifyBrowser();
  const path = new URL(request.url).pathname;
  const durationMs = path === "/api/plan" || path === "/api/apply" || path.endsWith("/retry") ? 285000 : path === "/api/brief" || path === "/api/replan" ? 110000 : 30000;
  const judging = judgingSession(request);
  const lease = await acquireWork(judging, durationMs, request.signal);
  const admissionStopped = new AbortController();
  const signal = AbortSignal.any([request.signal, admissionStopped.signal, AbortSignal.timeout(durationMs)]);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    admissionStopped.abort();
    await lease.release().catch(() => undefined); // Finite server-time leases recover a failed cleanup.
  };
  try {
    const response = await workContext.run({ judging, signal, expiresAt: lease.expiresAt, release }, operation);
    if (!response.body || !response.headers.get("content-type")?.startsWith("application/x-ndjson")) {
      await release();
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) { await release(); controller.close(); }
          else controller.enqueue(chunk.value);
        } catch (error) { await release(); controller.error(error); }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { await release(); } },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  } catch (error) { await release(); throw error; }
}
export function apiError(error: unknown, request?: Request): Response {
  return Response.json({ error: error instanceof AgentError ? error.message : safeError(error) }, { status: request?.signal.aborted ? 499 : error instanceof ServiceError || error instanceof QlooError || error instanceof AgentError ? error.status : 502, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
export function runResponse(record: RunRecord) { return Response.json(runResponseSchema.parse({ run: { ...record.snapshot, trace: record.snapshot.plan?.trace ?? record.snapshot.trace } }), { headers: { "Cache-Control": "private, no-store" } }); }
export async function executeRun(request: Request, record: RunRecord, cookie: string | null = null): Promise<Response> {
  const claimed = await claimRun(record.snapshot.id, record.owner);
  const token = claimed.token!;
  const stopped = new AbortController();
  const admissionSignal = workContext.getStore()?.signal;
  const releaseAdmission = workContext.getStore()?.release;
  const signal = AbortSignal.any([request.signal, stopped.signal, AbortSignal.timeout(270000), ...(admissionSignal ? [admissionSignal] : [])]);
  const traces: Trace[] = [...claimed.snapshot.trace];
  const encoder = new TextEncoder();
  let disconnected = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: PlanEvent) => { if (!disconnected) controller.enqueue(encoder.encode(`${JSON.stringify(planEventSchema.parse(event))}\n`)); };
      let pending: Promise<unknown> = Promise.resolve();
      let storageError: unknown = null;
      const checkpoint = () => {
        pending = pending.then(() => checkpointRun(claimed.snapshot.id, claimed.owner, token, [...traces])).catch((error: unknown) => { storageError = error; stopped.abort(); });
      };
      const heartbeat = setInterval(checkpoint, 10000);
      try {
        send({ type: "accepted", runId: claimed.snapshot.id, revision: claimed.snapshot.revision });
        const emit = (event: PlanEvent) => {
          signal.throwIfAborted();
          const parsed = planEventSchema.parse(event);
          if (parsed.type === "trace") { traces.push(parsed.trace); send(parsed); checkpoint(); }
          // Result becomes visible only after the token/revision-protected commit.
        };
        const plan = claimed.action && claimed.previous
          ? await applyAction(claimed.previous, claimed.action, emit, signal)
          : await createTour(claimed.input, emit, signal, claimed.previous ?? undefined);
        clearInterval(heartbeat);
        await pending;
        if (storageError) throw storageError;
        signal.throwIfAborted();
        const complete = await checkpointRun(claimed.snapshot.id, claimed.owner, token, traces, plan);
        send({ type: "result", plan: complete.snapshot.plan! });
      } catch (error) {
        const wasAborted = signal.aborted;
        stopped.abort();
        clearInterval(heartbeat);
        await pending;
        try { await checkpointRun(claimed.snapshot.id, claimed.owner, token, traces, undefined, { status: wasAborted ? "interrupted" : "failed", message: safeError(storageError ?? error) }); } catch { /* Cancellation or a newer lease owns the authoritative state. */ }
        send({ type: "error", message: safeError(storageError ?? error) });
      } finally { clearInterval(heartbeat); await releaseAdmission?.(); if (!disconnected) controller.close(); }
    },
    cancel() { disconnected = true; stopped.abort(); },
  });
  const headers = new Headers({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "private, no-store, no-transform", "X-Content-Type-Options": "nosniff", "X-Accel-Buffering": "no" });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(stream, { headers });
}
