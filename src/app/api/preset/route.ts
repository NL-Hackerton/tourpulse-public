import { tourTypeSchema } from "@/lib/contracts";
import { resolvePreset } from "@/lib/samples";
import { apiError, withWorkSlot } from "../_shared";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const mode = tourTypeSchema.safeParse(new URL(request.url).searchParams.get("mode") ?? "music");
  if (!mode.success) return Response.json({ error: "Unsupported preset mode." }, { status: 400 });
  try { return await withWorkSlot(request, async () => Response.json(await resolvePreset(mode.data, request.signal), { headers: { "Cache-Control": "private, no-store" } })); }
  catch (error) { return apiError(error, request); }
}
