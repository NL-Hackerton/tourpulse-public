import { cancelRun, loadRun } from "@/lib/runs";
import { runResponseSchema } from "@/lib/contracts";
import { requireEmptyBody, requireOrigin, session } from "@/lib/session";
import { apiError, runResponse, verifyBrowser } from "../../_shared";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try { const identity = session(request); await verifyBrowser(); return runResponse(await loadRun((await context.params).id, identity.id)); }
  catch (error) { return apiError(error, request); }
}
export async function DELETE(request: Request, context: Context) {
  try { requireOrigin(request); const identity = session(request); await verifyBrowser(); await requireEmptyBody(request); const run = await cancelRun((await context.params).id, identity.id); return Response.json(runResponseSchema.parse({ run }), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return apiError(error, request); }
}
