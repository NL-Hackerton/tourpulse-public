import "server-only";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Evidence } from "./contracts";
import { acquireFlight, cacheKey, providerFetch, publishCache, readCache, releaseFlight, ServiceError } from "./cache";

const itemId = z.string().regex(/^Q[1-9]\d{0,14}$/);
const idsSchema = z.array(itemId).min(1).max(20);
const deathValueSchema = z.object({ type: z.literal("time"), value: z.object({ time: z.string().regex(/^[+-]\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/) }) });
const statementSchema = z.object({
  rank: z.enum(["preferred", "normal", "deprecated"]),
  mainsnak: z.object({ property: z.literal("P570"), snaktype: z.enum(["value", "somevalue", "novalue"]), datavalue: z.unknown().optional() }),
});
const itemSchema = z.object({
  id: itemId, missing: z.unknown().optional(),
  redirects: z.object({ from: itemId, to: itemId }).optional(),
  claims: z.object({ P570: z.array(statementSchema).optional() }).optional(),
});
const responseSchema = z.object({ entities: z.record(z.string(), z.unknown()), error: z.unknown().optional() });
const recordSchema = z.object({ id: itemId, present: z.boolean(), deathRecorded: z.boolean() });
const cacheSchema = z.object({ url: z.string(), fetchedAt: z.iso.datetime(), records: z.array(recordSchema) });
export type LifeRecord = z.infer<typeof recordSchema>;
export interface LifeLookup { records: LifeRecord[]; evidence: Evidence }

/** Missing/novalue never means alive. Deprecated claims are ignored; preferred
 * statements supersede normal statements. Somevalue records a death without a date. */
export function parseLifeRecords(payload: unknown, requestedIds: readonly string[]): LifeRecord[] {
  const parsed = responseSchema.parse(payload);
  if (parsed.error !== undefined) throw new Error("Wikidata returned an API error");
  return requestedIds.map((id) => {
    const item = itemSchema.parse(parsed.entities[id]);
    if (item.id !== id && (item.redirects?.from !== id || item.redirects.to !== item.id)) throw new Error("Wikidata returned an unverified entity redirect");
    if (item.missing !== undefined) return { id, present: false, deathRecorded: false };
    if (!item.claims) throw new Error("Wikidata omitted the requested claims");
    const statements = (item.claims.P570 ?? []).filter((claim) => claim.rank !== "deprecated");
    const preferred = statements.filter((claim) => claim.rank === "preferred");
    const selected = preferred.length ? preferred : statements;
    for (const claim of selected) {
      if (claim.mainsnak.snaktype === "value") {
        deathValueSchema.parse(claim.mainsnak.datavalue);
      }
    }
    return { id, present: true, deathRecorded: selected.some((claim) => claim.mainsnak.snaktype !== "novalue") };
  });
}

/** Only Qloo-linked IDs enter this endpoint. No names, prompts, credentials or
 * user research are sent to Wikidata. Cached records contain only the P570 result. */
export async function lookupWikidataLife(rawIds: readonly string[], signal?: AbortSignal): Promise<LifeLookup> {
  const ids = idsSchema.parse([...new Set(rawIds)].sort());
  signal = AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]);
  const endpoint = "https://www.wikidata.org/w/api.php";
  const params = { action: "wbgetentities", ids: ids.join("|"), props: "claims", format: "json", maxlag: "5" };
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const key = cacheKey(createHash("sha256").update(url.href).digest("hex"), "wikidata");
  const evidence = (fetchedAt: string, cached: boolean): Evidence => ({ provider: "wikidata", endpoint, params, fetchedAt, cached });
  const cachedResult = async (): Promise<LifeLookup | null> => {
    const stored = cacheSchema.safeParse(await readCache(key, signal));
    if (!stored.success || stored.data.url !== url.href) return null;
    const age = Date.now() - Date.parse(stored.data.fetchedAt);
    if (age < 0 || age >= 604800000 || stored.data.records.length !== ids.length || stored.data.records.some((record, index) => record.id !== ids[index])) return null;
    return { records: stored.data.records, evidence: evidence(stored.data.fetchedAt, true) };
  };
  let token: string | null = null;
  try {
    while (!token) {
      signal.throwIfAborted();
      const cached = await cachedResult();
      if (cached) return cached;
      token = await acquireFlight(key, signal);
      if (!token) await delay(200, undefined, { signal });
    }
    const cached = await cachedResult();
    if (cached) return cached;
    const response = await providerFetch("wikidata", url, {
      headers: { Accept: "application/json", "User-Agent": "TourPulse/1.0 (https://github.com/NL-Hackerton/tourpulse-public; performer research)" },
      credentials: "omit", cache: "no-store", signal,
    }, 15000);
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > 8_000_000) {
      await response.body?.cancel();
      throw new Error("Wikidata unavailable or oversized");
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let text = "", bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 8_000_000) { await reader.cancel(); throw new Error("Wikidata response too large"); }
        text += decoder.decode(chunk.value, { stream: true });
      }
    } finally { reader.releaseLock(); }
    const records = parseLifeRecords(JSON.parse(text + decoder.decode()), ids);
    const fetchedAt = new Date().toISOString();
    await publishCache(key, token, { url: url.href, fetchedAt, records }, signal);
    return { records, evidence: evidence(fetchedAt, false) };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ServiceError) throw error;
    throw new ServiceError("Linked biographical checks are unavailable. No unchecked replacement result was saved. Try again shortly.");
  } finally { if (token) await releaseFlight(key, token); }
}
