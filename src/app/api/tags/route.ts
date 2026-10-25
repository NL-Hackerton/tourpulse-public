import { z } from "zod";
import { tagResponseSchema } from "@/lib/contracts";
import { searchTags } from "@/lib/qloo";
import { apiError, withWorkSlot } from "../_shared";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const parsed = z.string().trim().min(2).max(120).safeParse(new URL(request.url).searchParams.get("q"));
  if (!parsed.success) return Response.json({ error: "Provide a tag query of 2–120 characters." }, { status: 400 });
  try { return await withWorkSlot(request, async () => { const result = await searchTags(parsed.data, request.signal); return Response.json(tagResponseSchema.parse({ tags: result.tags }), { headers: { "Cache-Control": "private, no-store" } }); }); }
  catch (error) { return apiError(error, request); }
}
