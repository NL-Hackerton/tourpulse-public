import { runResponseSchema, tourTypeSchema } from "@/lib/contracts";
import { redisConfigured } from "@/lib/cache";
import { readSample } from "@/lib/samples";
import { apiError, withWorkSlot } from "../_shared";
import { z } from "zod";
import { adoptSample } from "@/lib/runs";
import { jsonBody, requireOrigin, session } from "@/lib/session";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const mode = tourTypeSchema.safeParse(new URL(request.url).searchParams.get("mode") ?? "music");
  if (!mode.success) return Response.json({ error: "Unsupported tour mode." }, { status: 400 });
  if (!redisConfigured()) return Response.json({ error: "No shared sample is available." }, { status: 404 });
  try {
    return await withWorkSlot(request, async () => {
      const run = await readSample(mode.data, request.signal);
      if (!run) return Response.json({ error: "No completed canonical preset sample is available." }, { status: 404 });
      return Response.json(runResponseSchema.parse({ run }), { headers: { "Cache-Control": "private, no-store" } });
    });
  } catch (error) { return apiError(error, request); }
}

export async function POST(request: Request) {
  try {
    requireOrigin(request);
    const { mode, requestId } = await jsonBody(request, z.object({ mode: tourTypeSchema, requestId: z.uuid() }).strict());
    return await withWorkSlot(request, async () => {
      const sample = await readSample(mode, request.signal);
      if (!sample?.plan) return Response.json({ error: "No completed sample is available." }, { status: 404 });
      const visitor = session(request, true);
      const run = await adoptSample(visitor.id, sample.plan, requestId);
      return Response.json(runResponseSchema.parse({ run }), { headers: {
        "Cache-Control": "private, no-store", ...(visitor.cookie ? { "Set-Cookie": visitor.cookie } : {}),
      } });
    });
  } catch (error) { return apiError(error, request); }
}
