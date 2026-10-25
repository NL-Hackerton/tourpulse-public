import { agentMessageSchema, previewSchema } from "@/lib/contracts";
import { previewChange } from "@/lib/agent";
import { completedRun } from "@/lib/runs";
import { ServiceError } from "@/lib/cache";
import { jsonBody, requireOrigin, session } from "@/lib/session";
import { apiError, revisionRequest, withWorkSlot } from "../_shared";
export const runtime = "nodejs";
export const maxDuration = 120;
const requestSchema = revisionRequest.extend({ message: agentMessageSchema }).strict();
export async function POST(request: Request) {
  try {
    requireOrigin(request); const identity = session(request);
    const body = await jsonBody(request, requestSchema);
    return await withWorkSlot(request, async () => {
      const record = await completedRun(body.runId, identity.id, body.expectedRevision);
      const preview = await previewChange(record.snapshot.plan!, body.message, AbortSignal.any([request.signal, AbortSignal.timeout(100000)]));
      if (preview.expectedRevision !== body.expectedRevision) throw new ServiceError("Preview returned a mismatched revision.", 502);
      await completedRun(body.runId, identity.id, body.expectedRevision);
      return Response.json(previewSchema.parse(preview), { headers: { "Cache-Control": "private, no-store" } });
    });
  } catch (error) { return apiError(error, request); }
}
