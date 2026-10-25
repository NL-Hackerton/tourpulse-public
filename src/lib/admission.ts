import "server-only";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { evalRedis, ServiceError } from "./cache";

const keys = ["tourpulse:v1:work:active:public", "tourpulse:v1:work:active:judge", "tourpulse:v1:work:waiting:public", "tourpulse:v1:work:waiting:judge"];
const acquireScript = `
local t=redis.call('TIME')
local now=t[1]*1000+math.floor(t[2]/1000)
for i=1,2 do redis.call('ZREMRANGEBYSCORE',KEYS[i],'-inf',now) end
for i=3,4 do redis.call('ZREMRANGEBYSCORE',KEYS[i],'-inf',now-12000) end
local judge=ARGV[2]=='1'
local waiting=judge and KEYS[4] or KEYS[3]
local active=judge and KEYS[2] or KEYS[1]
if not redis.call('ZSCORE',waiting,ARGV[1]) then
  local bound=judge and 8 or 24
  if redis.call('ZCARD',waiting)>=bound then return -1 end
  redis.call('ZADD',waiting,now,ARGV[1])
end
local first=redis.call('ZRANGE',waiting,0,0)[1]
local publicCount=redis.call('ZCARD',KEYS[1])
local judgeCount=redis.call('ZCARD',KEYS[2])
local room=publicCount+judgeCount<6 and (judge or (publicCount<4 and redis.call('ZCARD',KEYS[4])==0))
if first==ARGV[1] and room then
  redis.call('ZREM',waiting,ARGV[1])
  redis.call('ZADD',active,now+tonumber(ARGV[3]),ARGV[1])
  redis.call('PEXPIRE',active,360000)
  return 1
end
redis.call('PEXPIRE',waiting,15000)
return 0
`;

export interface WorkLease { expiresAt: number; release(): Promise<void>; }

export async function acquireWork(judging: boolean, durationMs: number, signal: AbortSignal): Promise<WorkLease> {
  const token = randomUUID();
  const queueDeadline = performance.now() + 12000;
  const release = async () => { await evalRedis("for i=1,4 do redis.call('ZREM',KEYS[i],ARGV[1]) end return 1", keys, [token]); };
  try {
    for (;;) {
      signal.throwIfAborted();
      if (performance.now() >= queueDeadline) throw new ServiceError("Shared execution capacity is busy. Retry shortly; for an accepted run, reconnect and resume it. No usage quota was consumed.");
      const requestedAt = performance.now();
      const result = z.number().parse(await evalRedis(acquireScript, keys, [token, judging ? 1 : 0, durationMs + 10000], signal));
      if (result < 0) throw new ServiceError("The shared waiting queue is full. Retry shortly. Your existing saved plan is unchanged.");
      if (result === 1) return { expiresAt: requestedAt + durationMs, release };
      await delay(900, undefined, { signal });
    }
  } catch (error) {
    // Tokens are unique and owner-scoped. Storage failure still leaves finite leases.
    await release().catch(() => undefined);
    throw error;
  }
}
