import assert from "node:assert/strict";
import test from "node:test";
import {
  defineGovernancePolicy,
  entitlement,
  evaluateFeatureFlag,
  evaluatePolicy,
  issueApproval,
  resolveEntitlements,
  verifyApproval,
} from "../dist/governance.js";

const policy = defineGovernancePolicy({
  revision: "workspace-42.7",
  rules: [
    { id: "deny-prod-agent-delete", actions: ["data.delete"], principalKinds: ["agent"], resource: "production:*", effect: "approval", approvalTtlMs: 60_000 },
    { id: "member-writes", actions: ["data.*"], roles: ["member"], effect: "allow" },
    { id: "readers", actions: ["data.read"], roles: ["reader"], effect: "allow" },
  ],
  entitlements: [
    { key: "projects", limit: 10 },
    { key: "custom-domains", limit: true },
  ],
  flags: [
    { key: "studio-v2", enabled: true, default: "classic", variants: [{ name: "studio", weight: 5_000, value: "studio" }] },
    { key: "operator-console", enabled: true, default: false, allowRoles: ["operator"] },
    { key: "future", enabled: true, default: false, startsAt: "2030-01-01T00:00:00.000Z" },
  ],
});

test("governance policy combines deny-by-default authorization and entitlements", () => {
  assert.equal(entitlement(policy, "projects"), 10);
  assert.equal(entitlement(policy, "missing"), undefined);
  assert.equal(evaluatePolicy(policy, {
    action: "data.update",
    resource: "project:one",
    principal: { id: "person_1", kind: "user", roles: ["member"] },
  }).effect, "allow");
  assert.equal(evaluatePolicy(policy, {
    action: "billing.change",
    principal: { id: "person_1", kind: "user", roles: ["member"] },
  }).effect, "deny");
});

test("entitlement layers are typed, ordered, and reject invented capacity keys", () => {
  assert.deepEqual(resolveEntitlements({ projects: 1, domains: 1, mcp: false }, { projects: 10, mcp: true }, { projects: 25 }), { projects: 25, domains: 1, mcp: true });
  assert.throws(() => resolveEntitlements({ projects: 1 }, { backups: 5 }), /unknown/u);
  assert.throws(() => resolveEntitlements({ projects: 1 }, { projects: true }), /invalid/u);
});

test("feature evaluations are stable, targeted, and schedule-aware", () => {
  const left = evaluateFeatureFlag(policy, "studio-v2", { subject: "account-9" });
  const right = evaluateFeatureFlag(policy, "studio-v2", { subject: "account-9" });
  assert.deepEqual(left, right);
  assert.equal(evaluateFeatureFlag(policy, "operator-console", {
    principal: { id: "operator_1", kind: "user", roles: ["operator"] },
  }).reason, "targeted");
  assert.equal(evaluateFeatureFlag(policy, "future", { now: "2029-01-01T00:00:00.000Z" }).reason, "scheduled");
});

test("agent approvals are scoped, expiring, tamper-evident, and replay-aware", async () => {
  const request = {
    action: "data.delete",
    resource: "production:todos",
    principal: { id: "agent_codex", kind: "agent", roles: ["member"] },
  };
  assert.equal(evaluatePolicy(policy, request).effect, "approval");
  const now = Date.parse("2026-08-01T12:00:00.000Z");
  const secret = "a-policy-secret-that-is-longer-than-thirty-two-bytes";
  const grant = await issueApproval({
    policy,
    request,
    approvedBy: "person_1",
    secret,
    now,
    randomBytes: () => new Uint8Array(18).fill(7),
  });
  assert.equal(await verifyApproval({ grant, policy, request, secret, now: now + 1 }), true);
  assert.equal(await verifyApproval({ grant, policy, request, secret, now: now + 1, usedNonces: new Set([grant.nonce]) }), false);
  assert.equal(await verifyApproval({ grant, policy, request: { ...request, resource: "production:users" }, secret, now: now + 1 }), false);
  assert.equal(await verifyApproval({ grant, policy, request, secret, now: now + 60_001 }), false);
  assert.equal(await verifyApproval({ grant: { ...grant, approvedBy: "attacker" }, policy, request, secret, now: now + 1 }), false);
});

test("governance inputs reject ambiguous and unsafe policy shapes", () => {
  assert.throws(() => defineGovernancePolicy({ revision: "one", rules: [{ id: "duplicate", actions: ["*"], effect: "allow" }, { id: "duplicate", actions: ["*"], effect: "deny" }] }), /duplicated/u);
  assert.throws(() => defineGovernancePolicy({ revision: "one", rules: [{ id: "ambiguous", actions: ["data.*.delete"], effect: "allow" }] }), /action is invalid/u);
  assert.throws(() => evaluatePolicy(policy, { action: "data.read", principal: { id: "*", kind: "user" } }), /principal ID is invalid/u);
  assert.throws(() => defineGovernancePolicy({ revision: "one", flags: [{ key: "bad", enabled: true, default: false, variants: [{ name: "all", weight: 10_001, value: true }] }] }), /weight/u);
  assert.throws(() => defineGovernancePolicy({ revision: "one", unexpected: true }), /unknown field/u);
});
