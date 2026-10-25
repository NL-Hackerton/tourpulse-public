import assert from "node:assert/strict";
import test from "node:test";
import { actionSchema, agentMessageSchema, planInputSchema } from "./contracts";
import { syntheticPlan } from "./domain-fixture";

test("case variants of the same UUID cannot masquerade as distinct audience seeds", () => {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const input = { ...syntheticPlan().input, headlinerId: id.toUpperCase(), anchorIds: [id] };
  assert.equal(planInputSchema.safeParse(input).success, false);
});

test("selection identifiers are canonical before matching verified candidates", () => {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const action = actionSchema.parse({ type: "select_venue", cityId: id.toUpperCase(), venueId: id.toUpperCase() });
  assert.equal(action.type, "select_venue");
  if (action.type === "select_venue") {
    assert.equal(action.cityId, id);
    assert.equal(action.venueId, id);
  }
});

test("agent requests accept the advertised boundary and reject blank or oversized input", () => {
  assert.equal(agentMessageSchema.parse("x".repeat(2001)).length, 2001);
  assert.equal(agentMessageSchema.parse("x".repeat(4000)).length, 4000);
  assert.equal(agentMessageSchema.safeParse("x".repeat(4001)).success, false);
  assert.equal(agentMessageSchema.safeParse(" \n ").success, false);
});
