import { z } from "zod";
import { briefSchema } from "@/lib/contracts";
import { draftBrief } from "@/lib/brief";
import { attachBrief, completedRun } from "@/lib/runs";
import { ServiceError } from "@/lib/cache";
import { jsonBody, requireOrigin, session } from "@/lib/session";
import { apiError, revisionRequest, withWorkSlot } from "../_shared";
export const runtime = "nodejs";
export const maxDuration = 120;
const requestSchema = revisionRequest.extend({ brandId: z.uuid() }).strict();
export async function POST(request: Request) {
  try {
    requireOrigin(request); const identity = session(request);
    const body = await jsonBody(request, requestSchema);
    return await withWorkSlot(request, async () => {
      const record = await completedRun(body.runId, identity.id, body.expectedRevision);
      if (!record.snapshot.plan!.sponsors.some((sponsor) => sponsor.entity.id === body.brandId)) throw new ServiceError("Choose a sponsor present in this plan.", 400);
      const generated = await draftBrief(record.snapshot.plan!, body.brandId, AbortSignal.any([request.signal, AbortSignal.timeout(100000)]));
      const brief = await attachBrief(body.runId, identity.id, body.expectedRevision, generated);
      return Response.json({ brief: briefSchema.parse(brief) }, { headers: { "Cache-Control": "private, no-store" } });
    });
  } catch (error) { return apiError(error, request); }
}
