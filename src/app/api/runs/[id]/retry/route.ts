import { z } from "zod";
import { loadRun } from "@/lib/runs";
import { jsonBody, requireOrigin, session } from "@/lib/session";
import { apiError, executeRun, withWorkSlot } from "../../../_shared";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireOrigin(request); const identity = session(request);
    if (request.body) await jsonBody(request, z.object({}).strict());
    return await withWorkSlot(request, async () => executeRun(request, await loadRun((await context.params).id, identity.id)));
  } catch (error) { return apiError(error, request); }
}
