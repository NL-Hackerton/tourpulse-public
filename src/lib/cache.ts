import "server-only";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import { z } from "zod";
import { workContext } from "./work-context";

export class ServiceError extends Error {
  constructor(message: string, public status = 503) { super(message); }
}
export function redisConfigured(): boolean { return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN); }
export async function redis(command: (string | number)[], signal?: AbortSignal): Promise<unknown> {
  const endpoint = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!endpoint || !token) throw new ServiceError("Saved results are temporarily unavailable. Try again shortly.");
  const url = new URL(endpoint);
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(url.hostname) && url.protocol === "http:")) throw new ServiceError("Saved results are temporarily unavailable. Try again shortly.");
  try {
    const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(command), cache: "no-store", redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]) });
    if (!response.ok || Number(response.headers.get("content-length")) > 24_000_000) { await response.body?.cancel(); throw new Error("redis response"); }
    if (!response.body) throw new Error("redis body");
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = ""; let size = 0;
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 24_000_000) { await reader.cancel(); throw new Error("redis size"); } text += decoder.decode(chunk.value, { stream: true }); } } finally { reader.releaseLock(); }
    const raw: unknown = JSON.parse(text + decoder.decode());
    const envelope = z.object({ result: z.unknown().optional(), error: z.string().optional() }).parse(raw);
    if (envelope.error || !("result" in envelope)) throw new Error("redis command");
    return envelope.result;
  } catch { signal?.throwIfAborted(); throw new ServiceError("Shared storage is unavailable. No operation was admitted without coordination."); }
}
export async function evalRedis(script: string, keys: string[], args: (string | number)[], signal?: AbortSignal): Promise<unknown> { return redis(["EVAL", script, keys.length, ...keys, ...args], signal); }
const prefix = "tourpulse:v2:";
const qlooCachePrefix = "tourpulse:v3:qloo:";
const wikidataCachePrefix = "tourpulse:v1:wikidata:";
const compress = promisify(gzip), decompress = promisify(gunzip);
export function cacheKey(hash: string, provider: "qloo" | "wikidata" = "qloo") { return `${provider === "wikidata" ? wikidataCachePrefix : qlooCachePrefix}${hash}`; }
export async function readCache(key: string, signal?: AbortSignal): Promise<unknown> {
  const value = await redis(["GET", key], signal);
  if (value === null) return null;
  const encoded = z.string().parse(value);
  try {
    const text = key.startsWith(qlooCachePrefix) || key.startsWith(wikidataCachePrefix)
      ? (await decompress(Buffer.from(encoded, "base64"), { maxOutputLength: 24_000_000 })).toString("utf8")
      : encoded;
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch { return null; }
}
export async function acquireFlight(key: string, signal?: AbortSignal): Promise<string | null> {
  const token = randomUUID();
  return await redis(["SET", `${key}:flight`, token, "NX", "PX", 90000], signal) === "OK" ? token : null;
}
export async function publishCache(key: string, token: string, value: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const encoded = (await compress(JSON.stringify(value))).toString("base64");
  const result = await evalRedis("if redis.call('GET',KEYS[2])~=ARGV[1] then return 0 end redis.call('SET',KEYS[1],ARGV[2],'PX',604800000) redis.call('DEL',KEYS[2]) return 1", [key, `${key}:flight`], [token, encoded], signal);
  if (result !== 1) throw new ServiceError("This request took too long and was not saved. Try again.");
}
export async function releaseFlight(key: string, token: string) { await evalRedis("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", [`${key}:flight`], [token]); }
export async function providerFetch(resource: "qloo" | "hive" | "wikidata", input: RequestInfo | URL, init?: RequestInit, requestTimeoutMs?: number): Promise<Response> {
  const context = workContext.getStore();
  const signals = [init?.signal, context?.signal].filter((value): value is AbortSignal => Boolean(value));
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  // The admission budget covers the whole request, not only its start.
  const timeLimitMessage = "This request reached its time limit, so no further provider request was sent. Try again; a saved plan run can also be reconnected and resumed.";
  for (;;) {
    signal?.throwIfAborted();
    if (context && performance.now() >= context.expiresAt) throw new ServiceError(timeLimitMessage);
    const requestedAt = performance.now();
    // A grant may be consumed for at most 1000 ms, conservatively measured from
    // BEFORE the Redis request (including RTT). Grants are 1260 ms apart, leaving
    // at least 260 ms between valid dispatch windows. A late grant is discarded.
    const wait = z.number().parse(await evalRedis("local t=redis.call('TIME') local now=t[1]*1000+math.floor(t[2]/1000) local last=tonumber(redis.call('GET',KEYS[1]) or '0') if now-last<1260 then return 1260-(now-last) end redis.call('SET',KEYS[1],now,'PX',60000) return 0", [`${prefix}dispatch:v1:${resource}`], [], signal));
    if (wait === 0) {
      const requestSignal = requestTimeoutMs === undefined ? signal : AbortSignal.any([AbortSignal.timeout(requestTimeoutMs), ...(signal ? [signal] : [])]);
      requestSignal?.throwIfAborted();
      if (performance.now() - requestedAt >= 1000) continue;
      if (context && performance.now() >= context.expiresAt) throw new ServiceError(timeLimitMessage);
      // No await or user callback separates freshness validation from dispatch.
      return fetch(input, { ...init, redirect: "error", signal: requestSignal });
    }
    await delay(Math.max(1, wait), undefined, { signal });
  }
}
