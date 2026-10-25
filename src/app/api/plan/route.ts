import { planInputSchema } from "@/lib/contracts";
import { createRun } from "@/lib/runs";
import { jsonBody, requireOrigin, session } from "@/lib/session";
import { apiError, executeRun, withWorkSlot } from "../_shared";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) {
  try {
    requireOrigin(request);
    const input = await jsonBody(request, planInputSchema);
    return await withWorkSlot(request, async () => {
      const identity = session(request, true);
      const record = await createRun(identity.id, input);
      return await executeRun(request, record, identity.cookie);
    });
  } catch (error) { return apiError(error, request); }
}
