import { redis, redisConfigured } from "@/lib/cache";
import { unstable_cache } from "next/cache";
export const runtime = "nodejs";
const dependencyStatus = unstable_cache(async () => {
  const configured = { redis: redisConfigured(), session: Boolean(process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32), qloo: Boolean(process.env.QLOO_API_KEY), ai: Boolean(process.env.HIVE_API_KEY) };
  let sharedStorage: "unconfigured" | "available" | "unavailable" = configured.redis ? "unavailable" : "unconfigured";
  if (configured.redis) { try { if (await redis(["PING"]) === "PONG") sharedStorage = "available"; } catch { sharedStorage = "unavailable"; } }
  const ready = configured.session && configured.qloo && configured.ai && sharedStorage === "available";
  return { ready, checkedAt: new Date().toISOString(), configured, dependencies: { sharedStorage, qloo: configured.qloo ? "configured-not-probed" : "unconfigured", ai: configured.ai ? "configured-not-probed" : "unconfigured" }, coordination: "Redis atomic admission and leases; fail-closed on storage errors. Redis failover can lose recent writes; not exactly-once upstream execution." };
}, ["tourpulse-health-v3"], { revalidate: 30 });

export async function GET() {
  const status = await dependencyStatus();
  return Response.json(status, { status: status.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
