import "server-only";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ServiceError } from "./cache";

const cookieName = "tourpulse_session";
const lifetime = 48 * 3600;

function requestOrigin(request: Request): URL {
  const original = new URL(request.url);
  const host = request.headers.get("host") ?? original.host;
  const protocol = process.env.VERCEL === "1" && process.env.VERCEL_ENV !== "development" ? "https:" : original.protocol;
  if (!host || /[\\/\s@?#]/.test(host) || !URL.canParse(`${protocol}//${host}`)) throw new ServiceError("Invalid request host.", 400);
  // Next can rewrite request.url to localhost while retaining the browser's Host.
  // Never trust a client-supplied X-Forwarded-Host for this comparison.
  return new URL(`${protocol}//${host}`);
}
export function session(request: Request, create = false): { id: string; cookie: string | null } {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new ServiceError("Anonymous session signing is not configured.");
  const values = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`));
  if (values.length > 1) throw new ServiceError("Invalid session cookie.", 401);
  const value = values[0]?.slice(cookieName.length + 1);
  if (value) {
    const [id, expiry, signature, extra] = value.split(".");
    if (id && z.uuid().safeParse(id).success && expiry && /^\d{10}$/.test(expiry) && signature && /^[a-f0-9]{64}$/.test(signature) && !extra) {
      const expected = createHmac("sha256", secret).update(`${id}.${expiry}`).digest();
      if (timingSafeEqual(expected, Buffer.from(signature, "hex")) && Number(expiry) > Date.now() / 1000 && Number(expiry) <= Date.now() / 1000 + lifetime + 60) return { id, cookie: null };
    }
    throw new ServiceError("Session expired or invalid. Clear this site's session cookie and retry.", 401);
  }
  if (!create) throw new ServiceError("This run requires its original anonymous session.", 401);
  const id = randomUUID(); const expiry = Math.floor(Date.now() / 1000) + lifetime;
  const signature = createHmac("sha256", secret).update(`${id}.${expiry}`).digest("hex");
  const url = requestOrigin(request);
  const local = process.env.VERCEL !== "1" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new ServiceError("Secure HTTPS is required for anonymous sessions.");
  return { id, cookie: `${cookieName}=${id}.${expiry}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${lifetime}${local ? "" : "; Secure"}` };
}

export function judgingSession(request: Request): boolean {
  const values = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith("tourpulse_judging="));
  if (values.length !== 1) return false;
  const [owner, expiry, signature, extra] = values[0].slice("tourpulse_judging=".length).split(".");
  if (!owner || !expiry || !/^\d{10}$/.test(expiry) || !signature || !/^[a-f0-9]{64}$/.test(signature) || extra) return false;
  if (Number(expiry) <= Date.now() / 1000 || Number(expiry) > Date.now() / 1000 + lifetime + 60) return false;
  try {
    if (session(request).id !== owner) return false;
    const expected = createHmac("sha256", process.env.SESSION_SECRET!).update(`judging.${owner}.${expiry}`).digest();
    return timingSafeEqual(expected, Buffer.from(signature, "hex"));
  } catch (error) {
    if (error instanceof ServiceError && error.status === 401) return false;
    throw error;
  }
}

export function grantJudgingAccess(request: Request, code: string): string[] {
  const expected = process.env.JUDGE_ACCESS_CODE;
  if (!expected || expected.length < 32) throw new ServiceError("Judging priority has not been configured. The public application remains available.");
  if (!timingSafeEqual(createHash("sha256").update(code).digest(), createHash("sha256").update(expected).digest())) throw new ServiceError("The judging access code is invalid.", 403);
  const identity = session(request, true);
  const expiry = Math.floor(Date.now() / 1000) + lifetime;
  const signature = createHmac("sha256", process.env.SESSION_SECRET!).update(`judging.${identity.id}.${expiry}`).digest("hex");
  const url = requestOrigin(request);
  const local = process.env.VERCEL !== "1" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return [identity.cookie, `tourpulse_judging=${identity.id}.${expiry}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${lifetime}${local ? "" : "; Secure"}`].filter((value): value is string => value !== null);
}
export function requireOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (origin !== requestOrigin(request).origin || (fetchSite !== null && !["same-origin", "none"].includes(fetchSite))) throw new ServiceError("Cross-origin mutations are not allowed.", 403);
  if (request.method !== "DELETE" && (request.body !== null || request.headers.has("content-type")) && !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ServiceError("Use an application/json request.", 415);
}
export async function requireEmptyBody(request: Request) {
  if (!request.body) return;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      if (chunk.value.byteLength) { await reader.cancel(); throw new ServiceError("DELETE does not accept a request body.", 400); }
    }
  } finally { reader.releaseLock(); }
}
export async function jsonBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (Number(request.headers.get("content-length")) > 16384) throw new ServiceError("Request body exceeds 16 KiB.", 413);
  if (!request.body) throw new ServiceError("A JSON request body is required.", 400);
  const reader = request.body.getReader(); const decoder = new TextDecoder(); let bytes = 0; let text = "";
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 16384) { await reader.cancel(); throw new ServiceError("Request body exceeds 16 KiB.", 413); } text += decoder.decode(chunk.value, { stream: true }); }
    let raw: unknown;
    try { raw = JSON.parse(text + decoder.decode()); } catch { throw new ServiceError("Provide valid JSON.", 400); }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ServiceError("The request does not match the supported input contract.", 400);
    return parsed.data;
  } finally { reader.releaseLock(); }
}
