import { actionSchema } from "@/lib/contracts";
import { completedRun, createRun } from "@/lib/runs";
import { jsonBody, requireOrigin, session } from "@/lib/session";
import { apiError, executeRun, revisionRequest, withWorkSlot } from "../_shared";
export const runtime = "nodejs";
export const maxDuration = 300;
const requestSchema = revisionRequest.extend({ action: actionSchema }).strict();
export async function POST(request: Request) {
  try {
    requireOrigin(request); const identity = session(request);
    const body = await jsonBody(request, requestSchema);
    return await withWorkSlot(request, async () => {
      const previous = await completedRun(body.runId, identity.id, body.expectedRevision);
      const record = await createRun(identity.id, previous.snapshot.plan!.input, previous, body.action);
      return await executeRun(request, record);
    });
  } catch (error) { return apiError(error, request); }
}
