import "server-only";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Entity, Evidence, Tag } from "./contracts";
import { acquireFlight, cacheKey, providerFetch, publishCache, readCache, redis, releaseFlight, ServiceError } from "./cache";
import { catalogDestination, isComedian } from "./entity-policy";

const finite = z.number().finite();
const coordinateSchema = z.object({ lat: finite.min(-90).max(90).optional(), lon: finite.min(-180).max(180).optional(), latitude: finite.min(-90).max(90).optional(), longitude: finite.min(-180).max(180).optional(), geohash: z.string().optional() });
const rawTagSchema = z.object({ id: z.string().optional(), tag_id: z.string().optional(), name: z.string().optional(), type: z.string().optional() })
  .refine((tag) => Boolean(tag.id || tag.tag_id || tag.type?.startsWith("urn:tag:")))
  .transform((tag) => ({ id: tag.tag_id || tag.id || "", name: tag.name || tag.tag_id || tag.id || "", type: tag.type ?? "" }));
const contributionSchema = z.object({ entity_id: z.uuid(), score: finite });
const externalIdsSchema = z.object({ wikidata: z.object({ id: z.string() }).optional() });
export const rowSchema = z.object({
  entity_id: z.uuid(), name: z.string().min(1), type: z.string().optional(), subtype: z.string().optional(), types: z.array(z.string()).optional(), popularity: finite.nullish(), location: coordinateSchema.nullish(),
  properties: z.object({ description: z.string().nullish(), short_description: z.string().nullish(), address: z.string().nullish(), neighborhood: z.string().nullish(), website: z.string().nullish(), popularity: finite.nullish(), geocode: z.object({ country_code: z.string().optional(), latitude: finite.optional(), longitude: finite.optional() }).optional() }).passthrough().nullish(),
  tags: z.array(rawTagSchema).optional(),
  query: z.object({ affinity: finite.nullish(), affinity_rank: finite.nullish(), popularity: finite.nullish(), explainability: z.object({ "signal.interests.entities": z.array(contributionSchema).optional() }).passthrough().optional() }).passthrough().optional(),
});
export type QlooRow = z.infer<typeof rowSchema>;
export const cellRowSchema = z.object({ location: coordinateSchema.extend({ geohash: z.string().regex(/^[0123456789bcdefghjkmnpqrstuvwxyz]{1,12}$/) }), query: z.object({ affinity_rank: finite.min(0).max(1), popularity: finite.min(0).max(1) }).catchall(z.unknown()) });
const resultSchema = z.object({ entities: z.array(z.unknown()).optional(), heatmap: z.array(z.unknown()).optional(), tags: z.array(z.unknown()).optional(), a: z.array(z.unknown()).optional(), b: z.array(z.unknown()).optional(), matchEntities: z.array(z.unknown()).optional() });
const envelopeSchema = z.object({ success: z.boolean().optional(), results: z.union([z.array(z.unknown()), resultSchema]).optional(), entities: z.array(z.unknown()).optional(), tags: z.array(z.unknown()).optional(), a: z.array(z.unknown()).optional(), b: z.array(z.unknown()).optional(), matchEntities: z.array(z.unknown()).optional() }).refine((v) => v.success !== false && (v.results !== undefined || v.entities !== undefined || v.tags !== undefined || v.a !== undefined || v.b !== undefined || v.matchEntities !== undefined));
export type Payload = z.infer<typeof envelopeSchema>;
const cacheSchema = z.object({ url: z.string(), fetchedAt: z.iso.datetime(), body: envelopeSchema });
export type QlooResponse = { body: Payload; evidence: Evidence; ms: number };
export class QlooError extends Error { constructor(message: string, public status = 502, public evidence: Evidence | null = null) { super(message); } }
export function safeError(error: unknown): string {
  if (error instanceof QlooError || error instanceof ServiceError) return error.message;
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) return "Request cancelled or timed out. Please try again.";
  return "Unable to complete this request. Please try again.";
}
const parameterNames: Record<string, true> = {
  query: true, types: true, take: true, page: true, sort_by: true, entity_ids: true,
  "filter.type": true, "filter.tags": true, "filter.exclude.tags": true, "filter.exclude.entities": true,
  "filter.results.entities": true, "filter.location": true, "filter.location.radius": true,
  "filter.popularity.min": true, "filter.popularity.max": true, "signal.interests.entities": true,
  "operator.filter.tags": true, "feature.explainability": true,
  "filter.query": true, "filter.results.tags": true, "filter.parents.types": true,
  "a.signal.interests.entities": true, "b.signal.interests.entities": true,
};
const recommendationParameters = ["filter.type", "filter.tags", "filter.exclude.tags", "filter.exclude.entities", "filter.popularity.min", "filter.popularity.max", "signal.interests.entities", "operator.filter.tags", "feature.explainability", "take"];
const endpointParameters: Record<string, readonly string[]> = {
  "/search": ["query", "types", "take", "page", "sort_by"],
  "/entities": ["entity_ids", "take"],
  "/v2/tags": ["filter.query", "filter.results.tags", "filter.parents.types", "take", "page"],
  "/v2/analysis/compare": ["a.signal.interests.entities", "b.signal.interests.entities"],
};
const insightParameters: Record<string, readonly string[]> = {
  "urn:heatmap": ["filter.type", "filter.location", "filter.location.radius", "signal.interests.entities", "take"],
  "urn:entity:place": [...recommendationParameters, "filter.location", "filter.location.radius", "filter.results.entities", "page"],
  "urn:entity:destination": [...recommendationParameters, "filter.results.entities"],
  "urn:entity:artist": recommendationParameters, "urn:entity:person": recommendationParameters,
  "urn:entity:podcast": recommendationParameters, "urn:entity:brand": recommendationParameters,
};
export async function qloo(endpoint: "/search" | "/entities" | "/v2/insights" | "/v2/tags" | "/v2/analysis/compare", params: Record<string, string>, signal?: AbortSignal): Promise<QlooResponse> {
  signal?.throwIfAborted();
  signal = AbortSignal.any([AbortSignal.timeout(85000), ...(signal ? [signal] : [])]);
  const started = performance.now();
  if (!process.env.QLOO_API_KEY) throw new QlooError("Qloo API is not configured on this server.", 503);
  const url = new URL(endpoint, "https://hackathon.api.qloo.com");
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (!Object.hasOwn(parameterNames, key) || value.length > 12000 || /[\u0000-\u001f]/.test(value)) throw new QlooError("Unsupported Qloo request parameters.", 400);
    const endpointAllowed = endpoint === "/v2/insights" ? insightParameters[params["filter.type"]] : endpointParameters[endpoint];
    if (!endpointAllowed || !endpointAllowed.includes(key)) throw new QlooError("This parameter is not supported for the requested Qloo data type.", 400);
    if ((key === "entity_ids" || key.endsWith(".entities") || key.startsWith("entity_ids.")) && !value.split(",").every((id) => z.uuid().safeParse(id).success)) throw new QlooError("Entity filters require verified entity IDs.", 400);
    if (["take", "page", "filter.location.radius"].includes(key) && (!/^\d+$/.test(value) || Number(value) > (key === "take" ? 100 : key === "page" ? 100 : 200000))) throw new QlooError("Qloo request parameter is outside the allowed bounds.", 400);
    if (key === "types" && !/^(urn:entity:(artist|movie|tv_show|brand|podcast|book|person|place|destination))(,urn:entity:(artist|movie|tv_show|brand|podcast|book|person|place|destination))*$/.test(value)) throw new QlooError("Unsupported entity type.", 400);
    if (key === "filter.type" && !/^urn:(entity:(artist|movie|tv_show|brand|podcast|book|person|place|destination)|heatmap)$/.test(value)) throw new QlooError("Unsupported insight type.", 400);
    url.searchParams.set(key, value);
  }
  const key = cacheKey(createHash("sha256").update(url.href).digest("hex"));
  const evidence = (fetchedAt: string, cached: boolean): Evidence => ({ provider: "qloo", endpoint, params, fetchedAt, cached });
  let token: string | null = null;
  const waitingUntil = Date.now() + 100000;
  while (!token) {
    const cached = cacheSchema.safeParse(await readCache(key, signal));
    if (cached.success && cached.data.url === url.href && Date.now() - Date.parse(cached.data.fetchedAt) >= 0 && Date.now() - Date.parse(cached.data.fetchedAt) < 604800000) return { body: cached.data.body, evidence: evidence(cached.data.fetchedAt, true), ms: performance.now() - started };
    token = await acquireFlight(key, signal);
    if (!token) { if (Date.now() >= waitingUntil) throw new QlooError("Another request is still fetching this data. Please retry.", 503); await delay(200, undefined, { signal }); }
  }
  try {
    const cachedAfterClaim = cacheSchema.safeParse(await readCache(key, signal));
    if (cachedAfterClaim.success && cachedAfterClaim.data.url === url.href && Date.now() - Date.parse(cachedAfterClaim.data.fetchedAt) >= 0 && Date.now() - Date.parse(cachedAfterClaim.data.fetchedAt) < 604800000) return { body: cachedAfterClaim.data.body, evidence: evidence(cachedAfterClaim.data.fetchedAt, true), ms: performance.now() - started };
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try { response = await providerFetch("qloo", url, { headers: { "X-Api-Key": process.env.QLOO_API_KEY }, cache: "no-store", signal }, 15000); }
      catch (error) { signal?.throwIfAborted(); if (error instanceof ServiceError) throw error; if (attempt < 2) { await delay(500 * 2 ** attempt, undefined, { signal }); continue; } throw new QlooError("Qloo could not be reached after limited retries."); }
      const fetchedAt = new Date().toISOString();
      const metadata: Record<string, string | number> = { status: response.status, fetchedAt };
      for (const header of ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-second-ratelimit-limit", "x-second-ratelimit-remaining", "x-second-ratelimit-reset", "x-month-ratelimit-limit", "x-month-ratelimit-remaining", "x-month-ratelimit-reset"]) { const value = response.headers.get(header); if (value && /^[\w .,:+\-/]{1,100}$/.test(value)) metadata[header] = value; }
      await redis(["SET", "tourpulse:v2:qloo:rate", JSON.stringify(metadata), "EX", 86400], signal);
      if (response.status === 429 && attempt < 2) {
        const retry = response.headers.get("retry-after"); const seconds = retry === null ? NaN : Number(retry);
        const wait = Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - Date.now() : 500 * 2 ** attempt;
        await response.body?.cancel();
        if (wait > 10000) throw new QlooError("Qloo rate limit reached. Wait before trying again.", 429, evidence(fetchedAt, false));
        await delay(Math.max(500, Number.isFinite(wait) ? wait : 1000), undefined, { signal }); continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new QlooError(response.status === 429 ? "Qloo rate limit reached." : response.status === 403 ? "Qloo does not permit this request." : "Qloo returned an unsuccessful response.", response.status === 429 ? 429 : response.status === 403 ? 403 : 502, evidence(fetchedAt, false)); }
      let body: Payload;
      try {
        if (!response.body || Number(response.headers.get("content-length")) > 8_000_000) { await response.body?.cancel(); throw new Error("size"); }
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = ""; let bytes = 0;
        try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 8_000_000) { await reader.cancel(); throw new Error("size"); } text += decoder.decode(chunk.value, { stream: true }); } } finally { reader.releaseLock(); }
        const raw: unknown = JSON.parse(text + decoder.decode()); body = envelopeSchema.parse(raw);
      } catch { signal?.throwIfAborted(); throw new QlooError("Qloo returned malformed or oversized data."); }
      signal?.throwIfAborted();
      await publishCache(key, token, { url: url.href, fetchedAt, body }, signal);
      return { body, evidence: evidence(fetchedAt, false), ms: performance.now() - started };
    }
    throw new QlooError("Qloo request could not be completed.");
  } finally { await releaseFlight(key, token); }
}
export function entityRows(body: Payload): QlooRow[] {
  const raw = Array.isArray(body.results) ? body.results : body.results?.entities ?? body.entities;
  if (!raw) throw new QlooError("Qloo returned an unexpected entity response.");
  return z.array(rowSchema).parse(raw);
}
export function normalizeEntity(row: QlooRow): Entity {
  const lat = row.location?.lat ?? row.location?.latitude ?? row.properties?.geocode?.latitude;
  const lon = row.location?.lon ?? row.location?.longitude ?? row.properties?.geocode?.longitude;
  const location = lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
  const type = row.types?.find((value) => value.startsWith("urn:entity:")) ?? row.subtype ?? row.type ?? "unknown";
  const rawCountry = row.properties?.country;
  const reportedCountry = (typeof rawCountry === "string" ? rawCountry.trim() : "") || row.properties?.geocode?.country_code?.trim() || null;
  const catalogCountry = (type === "urn:entity:destination" || type === "destination") && catalogDestination(row.name, location) ? "United States of America" : null;
  const deathDate = typeof row.properties?.date_of_death === "string" ? row.properties.date_of_death.trim() || null : null;
  const external = externalIdsSchema.safeParse(row.properties?.external);
  const linkedId = external.success ? external.data.wikidata?.id.toUpperCase() : undefined;
  const wikidataId = linkedId && /^Q[1-9]\d{0,14}$/.test(linkedId) ? linkedId : null;
  return { id: row.entity_id.toLowerCase(), name: row.name, type, popularity: row.popularity ?? row.properties?.popularity ?? null, description: (row.properties?.short_description ?? row.properties?.description ?? "").slice(0, 280), deathDate, wikidataId, tags: (row.tags ?? []).map((tag) => tag.id).filter(Boolean), location, country: reportedCountry || catalogCountry, countrySource: reportedCountry ? "qloo" : catalogCountry ? "fixed_catalog" : null };
}
export async function searchEntities(query: string, type: string, signal?: AbortSignal) {
  const result = await qloo("/search", { query, types: `urn:entity:${type}`, take: "8" }, signal);
  const entities = entityRows(result.body).map(normalizeEntity).filter((entity) => type !== "person" || isComedian(entity));
  return { ...result, entities };
}
export async function searchTags(query: string, signal?: AbortSignal): Promise<{ tags: Tag[]; evidence: Evidence; ms: number }> {
  const result = await qloo("/v2/tags", { "filter.query": query, "filter.parents.types": "urn:entity:brand", take: "20" }, signal);
  const raw = Array.isArray(result.body.results) ? result.body.results : result.body.results?.tags ?? result.body.tags;
  const tags = z.array(rawTagSchema).parse(raw).filter((tag) => tag.id.startsWith("urn:tag:"));
  return { tags, evidence: result.evidence, ms: result.ms };
}

export async function verifySponsorTags(ids: string[], signal?: AbortSignal): Promise<{ tags: Tag[]; evidence: Evidence; ms: number } | null> {
  if (!ids.length) return null;
  const wanted = new Set(ids);
  const result = await qloo("/v2/tags", { "filter.results.tags": [...wanted].join(","), "filter.parents.types": "urn:entity:brand", take: "50" }, signal);
  const raw = Array.isArray(result.body.results) ? result.body.results : result.body.results?.tags ?? result.body.tags;
  const tags = z.array(rawTagSchema).parse(raw).filter((tag) => tag.id.startsWith("urn:tag:"));
  const returned = new Set(tags.map((tag) => tag.id));
  if ([...wanted].some((id) => !returned.has(id))) throw new QlooError("One or more sponsor tags cannot be verified for brands. Search and select them again.", 400);
  return { tags, evidence: result.evidence, ms: result.ms };
}
export function contributions(row: QlooRow, seedIds: string[]): Record<string, number> {
  const allowed = new Set(seedIds.map((id) => id.toLowerCase()));
  return Object.fromEntries((row.query?.explainability?.["signal.interests.entities"] ?? []).filter((value) => allowed.has(value.entity_id.toLowerCase())).map((value) => [value.entity_id.toLowerCase(), value.score]));
}
