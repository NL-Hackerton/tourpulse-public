import assert from "node:assert/strict";
import test from "node:test";
import { grantJudgingAccess, judgingSession, jsonBody, requireEmptyBody, requireOrigin, session } from "./session";
import { z } from "zod";

const origin = "https://tourpulse.example";
test("anonymous mutation rejects absent/cross-site origins and non-JSON requests", () => {
  assert.throws(() => requireOrigin(new Request(`${origin}/api/plan`, { method: "POST" })));
  assert.throws(() => requireOrigin(new Request(`${origin}/api/plan`, { method: "POST", headers: { origin: "https://other.example", "content-type": "application/json" } })));
  assert.throws(() => requireOrigin(new Request(`${origin}/api/plan`, { method: "POST", headers: { origin, "content-type": "text/plain" } })));
  assert.throws(() => requireOrigin(new Request(`${origin}/api/plan`, { method: "POST", headers: { origin, "content-type": "application/json", "sec-fetch-site": "cross-site" } })));
  assert.doesNotThrow(() => requireOrigin(new Request(`${origin}/api/plan`, { method: "POST", headers: { origin, "content-type": "application/json", "sec-fetch-site": "same-origin" } })));
});
test("same-origin uses the incoming Host without trusting forwarded host", () => {
  const request = (origin: string, host = "127.0.0.1:3017") => new Request("http://localhost:3017/api/sample", {
    method: "POST", headers: { host, origin, "x-forwarded-host": "evil.example", "content-type": "application/json" },
  });
  assert.doesNotThrow(() => requireOrigin(request("http://127.0.0.1:3017")));
  assert.throws(() => requireOrigin(request("http://evil.example")));
  assert.throws(() => requireOrigin(request("http://127.0.0.1:3017", "127.0.0.1:3017@evil.example")));
});
test("JSON boundary counts actual bytes and validates unknown input", async () => {
  const schema = z.object({ message: z.string().max(10) }).strict();
  const request = (body: string) => new Request(`${origin}/api/plan`, { method: "POST", headers: { origin, "content-type": "application/json" }, body });
  assert.deepEqual(await jsonBody(request('{"message":"valid"}'), schema), { message: "valid" });
  await assert.rejects(jsonBody(request('{"message":42}'), schema));
  await assert.rejects(jsonBody(request('{"message":"valid","unexpected":true}'), schema));
  await assert.rejects(jsonBody(request("{"), schema));
  await assert.rejects(jsonBody(request(JSON.stringify({ message: "界".repeat(6000) })), schema), (error: unknown) => error instanceof Error && error.message.includes("16 KiB"));
});

test("judging priority requires a valid code and remains bound to its signed anonymous identity", () => {
  const oldSecret = process.env.SESSION_SECRET, oldCode = process.env.JUDGE_ACCESS_CODE;
  process.env.SESSION_SECRET = "synthetic-session-secret-for-isolated-test";
  process.env.JUDGE_ACCESS_CODE = "synthetic-judging-code-for-isolated-test";
  try {
    const request = new Request(`${origin}/api/session`);
    assert.throws(() => grantJudgingAccess(request, "wrong"));
    const cookies = grantJudgingAccess(request, process.env.JUDGE_ACCESS_CODE).map((value) => value.split(";")[0]);
    const withCookies = (values: string[]) => new Request(request.url, { headers: { cookie: values.join("; ") } });
    assert.equal(judgingSession(withCookies(cookies)), true);
    const priority = cookies.find((value) => value.startsWith("tourpulse_judging="))!;
    assert.equal(judgingSession(withCookies([priority])), false);
    const differentOwner = session(request, true).cookie!.split(";")[0];
    assert.equal(judgingSession(withCookies([differentOwner, priority])), false);
    assert.equal(judgingSession(withCookies([...cookies, priority])), false);
    const changed = priority.slice(0, -1) + (priority.endsWith("0") ? "1" : "0");
    assert.equal(judgingSession(withCookies([cookies[0], changed])), false);
  } finally {
    if (oldSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = oldSecret;
    if (oldCode === undefined) delete process.env.JUDGE_ACCESS_CODE; else process.env.JUDGE_ACCESS_CODE = oldCode;
  }
});

test("DELETE accepts an empty transport stream but rejects actual bytes", async () => {
  await requireEmptyBody(new Request(`${origin}/api/runs/example`, { method: "DELETE", body: "" }));
  await assert.rejects(requireEmptyBody(new Request(`${origin}/api/runs/example`, { method: "DELETE", body: "x", headers: { "content-length": "0" } })), /does not accept/);
});
