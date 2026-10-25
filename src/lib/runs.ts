import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { actionSchema, briefSchema, planInputSchema, planSchema, runSchema, traceSchema, type Brief, type PlanAction, type PlanInput, type RunSnapshot, type TourPlan, type Trace } from "./contracts";
import { evalRedis, redis, ServiceError } from "./cache";

const recordSchema = z.object({ owner: z.uuid(), snapshot: runSchema, input: planInputSchema, action: actionSchema.nullable(), previous: planSchema.nullable(), token: z.string().nullable(), lease: z.number(), version: z.number().int() });
export type RunRecord = z.infer<typeof recordSchema>;
const ttl = 172800;
const prefix = "tourpulse:v10:run:";
const mutation = `local raw=redis.call('GET',KEYS[1]) if not raw then return 'missing' end local r=cjson.decode(raw) if r.owner~=ARGV[1] then return 'missing' end if r.version~=tonumber(ARGV[2]) then return 'conflict' end local next=cjson.decode(ARGV[3]) local t=redis.call('TIME') local now=t[1]*1000+math.floor(t[2]/1000) if r.snapshot.status=='running' and next.snapshot.status~='interrupted' and next.snapshot.status~='cancelled' and r.lease<=now then return 'conflict' end redis.call('SET',KEYS[1],ARGV[3],'EX',172800) return 'ok'`;
async function replace(record: RunRecord, next: RunRecord) {
  const result = await evalRedis(mutation, [prefix + record.snapshot.id], [record.owner, record.version, JSON.stringify({ ...next, version: record.version + 1 })]);
  if (result === "missing") throw new ServiceError("Run not found.", 404);
  if (result !== "ok") throw new ServiceError("Run state changed. Reconnect before retrying.", 409);
}
async function storageTime(): Promise<number> {
  const [seconds, micros] = z.tuple([z.coerce.number().finite(), z.coerce.number().finite()]).parse(await redis(["TIME"]));
  return seconds * 1000 + Math.floor(micros / 1000);
}
export async function loadRun(id: string, owner: string): Promise<RunRecord> {
  if (!z.uuid().safeParse(id).success) throw new ServiceError("Run not found.", 404);
  const raw = await redis(["GET", prefix + id]);
  if (raw === null) throw new ServiceError("Run not found or expired.", 404);
  let record: RunRecord;
  try { const data: unknown = JSON.parse(z.string().parse(raw)); record = recordSchema.parse(data); } catch { throw new ServiceError("Stored run is invalid."); }
  if (record.owner !== owner) throw new ServiceError("Run not found.", 404);
  if (record.snapshot.status === "running" && record.lease <= await storageTime()) {
    const next = { ...record, token: null, lease: 0, snapshot: { ...record.snapshot, status: "interrupted" as const, updatedAt: new Date().toISOString(), error: "This run stopped before finishing. Resume it to continue from the evidence already gathered." } };
    try { await replace(record, next); return { ...next, version: record.version + 1 }; } catch (error) { if (error instanceof ServiceError && error.status === 409) return loadRun(id, owner); throw error; }
  }
  return record;
}
export async function completedRun(id: string, owner: string, revision: number): Promise<RunRecord> {
  const record = await loadRun(id, owner);
  if (record.snapshot.revision !== revision || record.snapshot.status !== "complete" || !record.snapshot.plan) throw new ServiceError("Run revision or completion state changed. Reconnect before making changes.", 409);
  return record;
}
export async function createRun(owner: string, input: PlanInput, previousRecord?: RunRecord, action?: PlanAction): Promise<RunRecord> {
  const id = randomUUID();
  const record: RunRecord = { owner, input: planInputSchema.parse(input), action: action ? actionSchema.parse(action) : null, previous: previousRecord?.snapshot.plan ?? null, token: null, lease: 0, version: 0, snapshot: { id, revision: previousRecord ? previousRecord.snapshot.revision + 1 : 1, status: "queued", updatedAt: new Date().toISOString(), plan: null, trace: [], error: null, previousRunId: previousRecord?.snapshot.id ?? null } };
  if (previousRecord) {
    const result = await evalRedis("local raw=redis.call('GET',KEYS[1]) if not raw then return 0 end local r=cjson.decode(raw) if r.owner~=ARGV[1] or r.version~=tonumber(ARGV[2]) or r.snapshot.status~='complete' then return 0 end return redis.call('SET',KEYS[2],ARGV[3],'NX','EX',172800)", [prefix + previousRecord.snapshot.id, prefix + id], [owner, previousRecord.version, JSON.stringify(record)]);
    if (result !== "OK") throw new ServiceError("Previous run changed. Reconnect before applying.", 409);
  } else if (await redis(["SET", prefix + id, JSON.stringify(record), "NX", "EX", ttl]) !== "OK") throw new ServiceError("Could not create run.");
  return record;
}

export async function adoptSample(owner: string, sample: TourPlan, requestId: string): Promise<RunSnapshot> {
  const id = randomUUID();
  const plan = planSchema.parse({ ...sample, id: randomUUID(), revision: 1, brief: null });
  const snapshot: RunSnapshot = { id, revision: 1, status: "complete", updatedAt: new Date().toISOString(), plan,
    trace: plan.trace, error: null, previousRunId: null };
  const record: RunRecord = { owner, snapshot, input: plan.input, action: null, previous: null, token: null, lease: 0, version: 0 };
  const adoptionKey = `${prefix}adoption:${owner}:${sample.input.tourType}:${z.uuid().parse(requestId)}`;
  const savedId = z.uuid().parse(await evalRedis("local id=redis.call('GET',KEYS[1]) if id then return id end redis.call('SET',KEYS[2],ARGV[2],'EX',172800) redis.call('SET',KEYS[1],ARGV[1],'EX',172800) return ARGV[1]", [adoptionKey, prefix + id], [id, JSON.stringify(record)]));
  return savedId === id ? snapshot : (await loadRun(savedId, owner)).snapshot;
}
export async function claimRun(id: string, owner: string): Promise<RunRecord> {
  const record = await loadRun(id, owner);
  if (!["queued", "failed", "interrupted"].includes(record.snapshot.status)) throw new ServiceError(record.snapshot.status === "complete" ? "Run already completed. Read its saved result instead." : "Run is active or cancelled.", 409);
  const next = { ...record, token: randomUUID(), lease: await storageTime() + 45000, snapshot: { ...record.snapshot, status: "running" as const, error: null, updatedAt: new Date().toISOString() } };
  await replace(record, next);
  return { ...next, version: record.version + 1 };
}
export async function checkpointRun(id: string, owner: string, token: string, traces: Trace[], plan?: TourPlan, failure?: { status: "failed" | "interrupted"; message: string }): Promise<RunRecord> {
  const record = await loadRun(id, owner);
  const now = await storageTime();
  if (record.token !== token || record.snapshot.status !== "running" || record.lease <= now) throw new ServiceError("Execution was cancelled or superseded.", 409);
  const parsedPlan = plan ? planSchema.parse(plan) : null;
  if (parsedPlan && (parsedPlan.revision !== record.snapshot.revision || (record.previous && parsedPlan.id !== record.previous.id))) throw new ServiceError("Planner returned a mismatched revision.", 502);
  const status = parsedPlan ? "complete" : failure?.status ?? "running";
  const next: RunRecord = { ...record, token: status === "running" ? token : null, lease: status === "running" ? now + 45000 : 0, snapshot: { ...record.snapshot, status, trace: z.array(traceSchema).max(1000).parse(parsedPlan?.trace ?? traces), plan: parsedPlan, error: failure?.message ?? null, updatedAt: new Date().toISOString() } };
  await replace(record, next);
  return { ...next, version: record.version + 1 };
}
export async function cancelRun(id: string, owner: string): Promise<RunSnapshot> {
  const record = await loadRun(id, owner);
  if (record.snapshot.status === "complete" || record.snapshot.status === "cancelled") return record.snapshot;
  const next: RunRecord = { ...record, token: null, lease: 0, snapshot: { ...record.snapshot, status: "cancelled", error: "Cancelled by this session.", updatedAt: new Date().toISOString() } };
  await replace(record, next); return next.snapshot;
}
export async function attachBrief(id: string, owner: string, revision: number, brief: Brief): Promise<Brief> {
  const parsed = briefSchema.parse(brief);
  const record = await completedRun(id, owner, revision);
  const plan = record.snapshot.plan!;
  if (parsed.planId !== plan.id || parsed.revision !== revision || !plan.sponsors.some((sponsor) => sponsor.entity.id === parsed.brandId) || parsed.proposalType !== plan.input.proposalPreferences.proposalType) throw new ServiceError("Brief does not match this plan revision.", 409);
  const next = { ...record, snapshot: { ...record.snapshot, plan: { ...plan, brief: parsed }, updatedAt: new Date().toISOString() } };
  await replace(record, next); return parsed;
}
