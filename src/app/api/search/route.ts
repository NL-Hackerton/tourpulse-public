import { z } from "zod";
import { entityTypes, searchResponseSchema } from "@/lib/contracts";
import { searchEntities } from "@/lib/qloo";
import { apiError, withWorkSlot } from "../_shared";

export const runtime = "nodejs";
const querySchema = z.object({ q: z.string().trim().min(2).max(120), type: z.enum(entityTypes) });
export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({ q: url.searchParams.get("q"), type: url.searchParams.get("type") });
  if (!parsed.success) return Response.json({ error: "Provide a search query of 2–120 characters and a supported entity type." }, { status: 400 });
  try {
    return await withWorkSlot(request, async () => {
      const { entities } = await searchEntities(parsed.data.q, parsed.data.type, request.signal);
      return Response.json(searchResponseSchema.parse({ entities }), { headers: { "Cache-Control": "private, no-store" } });
    });
  } catch (error) {
    return apiError(error, request);
  }
}
