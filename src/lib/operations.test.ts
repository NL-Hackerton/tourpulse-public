import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { acquireFlight, cacheKey, publishCache, readCache, redis, redisConfigured, releaseFlight } from "./cache";
import { adoptSample, cancelRun, checkpointRun, claimRun, createRun, loadRun } from "./runs";
import type { PlanInput } from "./contracts";
import { syntheticPlan } from "./domain-fixture";
import { applyAction } from "./actions";
import type { Trace } from "./contracts";

const enabled = process.env.TOURPULSE_REDIS_TESTS === "1" && redisConfigured();
test("real Redis single-flight rejects stale publisher and cannot unlock another owner", { skip: !enabled }, async () => {
  const key = cacheKey(`test:${randomUUID()}`);
  try {
    const token = await acquireFlight(key);
    assert.ok(token);
    assert.equal(await acquireFlight(key), null);
    await releaseFlight(key, "wrong-owner");
    assert.equal(await acquireFlight(key), null);
    await assert.rejects(publishCache(key, "wrong-owner", { synthetic: true }));
    assert.equal(await readCache(key), null);
    await publishCache(key, token, { synthetic: true });
    assert.deepEqual(await readCache(key), { synthetic: true });
    const remaining = await redis(["PTTL", key]);
    assert.equal(typeof remaining, "number");
    assert.ok(typeof remaining === "number" && remaining > 604790000 && remaining <= 604800000);
  } finally { await redis(["DEL", key, `${key}:flight`]); }
});
test("corrupt compressed provider cache is a miss and cancellation cannot publish a replacement", { skip: !enabled }, async () => {
  const key = cacheKey(`test:${randomUUID()}`);
  try {
    await redis(["SET", key, "not-a-gzip-stream", "EX", 60]);
    assert.equal(await readCache(key), null);
    const token = await acquireFlight(key);
    assert.ok(token);
    await assert.rejects(publishCache(key, token, { synthetic: true }, AbortSignal.abort()));
    assert.equal(await readCache(key), null);
  } finally { await redis(["DEL", key, `${key}:flight`]); }
});
test("real Redis run CAS admits one executor, enforces ownership and fences cancelled completion", { skip: !enabled }, async () => {
  const owner = randomUUID();
  const input: PlanInput = { tourType: "music", headlinerId: randomUUID(), anchorIds: [], stopCount: 2, startDate: "2027-01-01", endDate: "2027-01-05", startCity: "Boston", maxDriveHours: 4, showDayPreference: "compact", capacity: 200, alreadyPlayed: [], candidateCityIds: [], neighborhoods: [], sponsorIncludeTags: [], sponsorExcludeTags: [], nicheWeight: 0.2, proposalPreferences: { proposalType: "on_site_activation", focusCityId: null, constraints: [] } };
  const run = await createRun(owner, input);
  try {
    await assert.rejects(loadRun(run.snapshot.id, randomUUID()));
    const contenders = await Promise.allSettled([claimRun(run.snapshot.id, owner), claimRun(run.snapshot.id, owner)]);
    assert.equal(contenders.filter((result) => result.status === "fulfilled").length, 1);
    const winner = contenders.find((result) => result.status === "fulfilled");
    assert.ok(winner && winner.status === "fulfilled" && winner.value.token);
    const token = winner.value.token;
    const cancelled = await cancelRun(run.snapshot.id, owner);
    assert.equal(cancelled.status, "cancelled");
    await assert.rejects(checkpointRun(run.snapshot.id, owner, token, []));
    await assert.rejects(claimRun(run.snapshot.id, owner));
    assert.equal((await loadRun(run.snapshot.id, owner)).snapshot.status, "cancelled");
  } finally { await redis(["DEL", `tourpulse:v10:run:${run.snapshot.id}`]); }
});

test("adopted samples have private ownership and independent artifact identity", { skip: !enabled }, async () => {
  const owner = randomUUID(), sample = syntheticPlan(), requestId = randomUUID();
  const [copy, replay] = await Promise.all([adoptSample(owner, sample, requestId), adoptSample(owner, sample, requestId)]);
  try {
    assert.equal(copy.id, replay.id);
    assert.notEqual(copy.plan!.id, sample.id);
    assert.equal(copy.revision, 1);
    assert.deepEqual(copy.plan!.stops, sample.stops);
    assert.equal((await loadRun(copy.id, owner)).snapshot.status, "complete");
    await assert.rejects(loadRun(copy.id, randomUUID()));
  } finally { await redis(["DEL", `tourpulse:v10:run:${copy.id}`, `tourpulse:v10:run:adoption:${owner}:music:${requestId}`]); }
});

test("an expired execution lease can be reclaimed without accepting its former executor", { skip: !enabled }, async () => {
  const owner = randomUUID(), run = await createRun(owner, syntheticPlan().input);
  const key = `tourpulse:v10:run:${run.snapshot.id}`;
  try {
    const former = await claimRun(run.snapshot.id, owner);
    await redis(["SET", key, JSON.stringify({ ...former, lease: 0 }), "EX", 60]);
    assert.equal((await loadRun(run.snapshot.id, owner)).snapshot.status, "interrupted");
    const next = await claimRun(run.snapshot.id, owner);
    assert.notEqual(next.token, former.token);
    await assert.rejects(checkpointRun(run.snapshot.id, owner, former.token!, []));
    assert.equal((await loadRun(run.snapshot.id, owner)).token, next.token);
  } finally { await redis(["DEL", key]); }
});

test("completed local revisions retain source evidence rather than only their live progress trace", { skip: !enabled }, async () => {
  const owner = randomUUID(), requestId = randomUUID(), sample = syntheticPlan();
  sample.trace = [{ step: "S1", message: "Synthetic identity evidence", status: "ok", count: 1, ms: 0, evidence: sample.seedEvidence[0] }];
  const adopted = await adoptSample(owner, sample, requestId);
  let childId: string | undefined;
  try {
    const previous = await loadRun(adopted.id, owner);
    const action = { type: "set_drive" as const, maxDriveHours: 3 };
    const child = await createRun(owner, previous.input, previous, action);
    childId = child.snapshot.id;
    const claimed = await claimRun(childId, owner);
    const progress: Trace[] = [];
    const changed = await applyAction(previous.snapshot.plan!, action, (event) => { if (event.type === "trace") progress.push(event.trace); });
    assert.equal(progress.some((trace) => trace.evidence?.endpoint === "/entities"), false);
    await checkpointRun(childId, owner, claimed.token!, progress, changed);
    const restored = await loadRun(childId, owner);
    assert.equal(restored.snapshot.revision, 2);
    assert.ok(restored.snapshot.trace.some((trace) => trace.evidence?.endpoint === "/entities" && trace.evidence.fetchedAt === sample.seedEvidence[0].fetchedAt));
    assert.equal(restored.snapshot.plan!.input.maxDriveHours, 3);
  } finally {
    await redis(["DEL", `tourpulse:v10:run:${adopted.id}`, `tourpulse:v10:run:adoption:${owner}:music:${requestId}`, ...(childId ? [`tourpulse:v10:run:${childId}`] : [])]);
  }
});
