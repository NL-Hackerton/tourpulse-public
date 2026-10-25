import { z } from "zod";
import { grantJudgingAccess, jsonBody, requireOrigin, session } from "@/lib/session";
import { apiError, verifyBrowser } from "../_shared";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    requireOrigin(request);
    const body = await jsonBody(request, z.union([z.object({ reset: z.literal(true) }).strict(), z.object({ judgingCode: z.string().min(1).max(128) }).strict()]));
    await verifyBrowser();
    if ("judgingCode" in body) {
      const headers = new Headers({ "Cache-Control": "private, no-store" });
      for (const cookie of grantJudgingAccess(request, body.judgingCode)) headers.append("Set-Cookie", cookie);
      return Response.json({ judging: true }, { headers });
    }
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    const identity = session(new Request(request.url, { headers }), true);
    return Response.json({ reset: true }, { headers: { "Cache-Control": "private, no-store", "Set-Cookie": identity.cookie! } });
  } catch (error) { return apiError(error, request); }
}
