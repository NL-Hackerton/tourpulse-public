import { createHash, timingSafeEqual } from "node:crypto";
import { tourTypes } from "@/lib/contracts";
import { warmCanonicalSample } from "@/lib/samples";
import { acquireWork } from "@/lib/admission";
import { workContext } from "@/lib/work-context";
import { apiError } from "../../_shared";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const supplied = request.headers.get("authorization") ?? "";
  if (!secret || secret.length < 32 || !timingSafeEqual(createHash("sha256").update(supplied).digest(), createHash("sha256").update(`Bearer ${secret}`).digest())) {
    return Response.json({ error: "Operator authentication required." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  // Automatic maintenance ends with judging; no post-event provider work is scheduled.
  if (Date.now() > Date.parse("2026-11-06T04:45:00Z")) return Response.json({ status: "judging-period-ended", warmed: [] });
  try {
    const lease = await acquireWork(false, 270000, request.signal);
    const stopped = new AbortController();
    const signal = AbortSignal.any([request.signal, stopped.signal, AbortSignal.timeout(270000)]);
    let released = false;
    const release = async () => { if (!released) { released = true; stopped.abort(); await lease.release(); } };
    try {
      return await workContext.run({ judging: false, signal, expiresAt: lease.expiresAt, release }, async () => {
        const startDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
        const warmed = [];
        for (const mode of tourTypes) {
          const run = await warmCanonicalSample(mode, startDate, () => {}, signal);
          warmed.push({ mode, stops: run.plan!.stops.length, savedAt: run.updatedAt });
        }
        return Response.json({ status: "complete", warmed }, { headers: { "Cache-Control": "no-store" } });
      });
    } finally { await release(); }
  } catch (error) { return apiError(error, request); }
}
