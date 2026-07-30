import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  createGithubActionsOidcVerifier,
  GITHUB_ACTIONS_OIDC_JWKS,
  GITHUB_ACTIONS_OIDC_ISSUER,
  GithubActionsOidcError,
  branchRef,
  repositoryName,
  workflowPathName,
} from "../dist/github-oidc.js";

const NOW = 1_800_000_000_000;
const NOW_SECONDS = NOW / 1_000;

test("GitHub Actions OIDC binds an exact repository, workflow, audience, event, and pull request", async () => {
  const fixture = oidcFixture();
  let fetches = 0;
  const verifier = createGithubActionsOidcVerifier({
    now: () => NOW,
    fetch: async (url, init) => {
      fetches++;
      assert.equal(url, GITHUB_ACTIONS_OIDC_JWKS);
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.equal(init.credentials, "omit");
      assert.equal(init.headers["accept-encoding"], "identity");
      return jsonResponse({ keys: [fixture.jwk] }, GITHUB_ACTIONS_OIDC_JWKS);
    },
  });
  const token = fixture.token({
    ref: "refs/pull/482/merge",
    workflow_ref: "nearby/app/.github/workflows/clank-preview.yml@refs/pull/482/merge",
  });
  const policy = {
    audience: "https://clank.run",
    repository: "Nearby/App",
    repositoryId: "92837465",
    workflowPath: ".github/workflows/clank-preview.yml",
    eventName: "pull_request",
    operation: "deploy",
    previewName: "pull-482",
  };
  const identity = await verifier.verify(token, policy);
  assert.deepEqual(identity, {
    issuer: GITHUB_ACTIONS_OIDC_ISSUER,
    subject: "repo:nearby/app:pull_request",
    jti: "github-jti-0000000000000001",
    expiresAt: NOW + 5 * 60_000,
    repository: "nearby/app",
    repositoryId: "92837465",
    workflowRef: "nearby/app/.github/workflows/clank-preview.yml@refs/pull/482/merge",
    workflowSha: "a".repeat(40),
    eventName: "pull_request",
    ref: "refs/pull/482/merge",
    runId: "99112233",
    runAttempt: 2,
    previewName: "pull-482",
  });
  await verifier.verify(token, policy);
  assert.equal(fetches, 1);

  const cleanup = await verifier.verify(fixture.token({
    event_name: "pull_request_target",
    ref: "refs/heads/main",
    workflow_ref: "nearby/app/.github/workflows/clank-preview-cleanup.yml@refs/heads/main",
  }), {
    ...policy,
    workflowPath: ".github/workflows/clank-preview-cleanup.yml",
    eventName: "pull_request_target",
    operation: "remove",
    ref: "refs/heads/main",
  });
  assert.equal(cleanup.previewName, "pull-482");
  await assert.rejects(
    verifier.verify(fixture.token({
      event_name: "pull_request_target",
      ref: "refs/heads/release",
      workflow_ref:
        "nearby/app/.github/workflows/clank-preview-cleanup.yml@refs/heads/release",
    }), {
      ...policy,
      workflowPath: ".github/workflows/clank-preview-cleanup.yml",
      eventName: "pull_request_target",
      operation: "remove",
      ref: "refs/heads/main",
    }),
    GithubActionsOidcError,
  );
});

test("GitHub Actions OIDC failures are fixed and reject claim, signature, key, and time confusion", async () => {
  const fixture = oidcFixture();
  const verifier = createGithubActionsOidcVerifier({
    now: () => NOW,
    fetch: async () => jsonResponse({ keys: [fixture.jwk] }, GITHUB_ACTIONS_OIDC_JWKS),
  });
  const policy = {
    audience: "https://clank.run",
    repository: "nearby/app",
    repositoryId: "92837465",
    workflowPath: ".github/workflows/clank-preview.yml",
    eventName: "pull_request",
    operation: "deploy",
    previewName: "pull-482",
  };
  const validOverrides = {
    ref: "refs/pull/482/merge",
    workflow_ref: "nearby/app/.github/workflows/clank-preview.yml@refs/pull/482/merge",
  };
  const invalid = [
    fixture.token({ ...validOverrides, aud: "https://attacker.example" }),
    fixture.token({ ...validOverrides, repository_id: "92837466" }),
    fixture.token({ ...validOverrides, event_name: "push" }),
    fixture.token({ ...validOverrides, ref: "refs/heads/main" }),
    fixture.token({ ...validOverrides, exp: NOW_SECONDS - 1 }),
    fixture.token({ ...validOverrides, exp: NOW_SECONDS + 601 }),
    `${fixture.token(validOverrides).slice(0, -1)}A`,
  ];
  for (const token of invalid) {
    await assert.rejects(
      verifier.verify(token, policy),
      (error) => error instanceof GithubActionsOidcError
        && error.code === "INVALID_GITHUB_IDENTITY"
        && error.message === "The GitHub Actions identity is invalid or expired.",
    );
  }

  const unknownKey = fixture.token(validOverrides, { kid: "unknown-key-01" });
  await assert.rejects(verifier.verify(unknownKey, policy), GithubActionsOidcError);
  await assert.rejects(
    verifier.verify(fixture.token(validOverrides), { ...policy, previewName: "pull-481" }),
    GithubActionsOidcError,
  );
  await assert.rejects(
    verifier.verify(fixture.token({
      ...validOverrides,
      workflow_ref:
        "nearby/app/.github/workflows/CLANK-preview.yml@refs/pull/482/merge",
    }), policy),
    GithubActionsOidcError,
  );
});

test("GitHub binding identifiers reject ambiguous repositories and workflow paths", () => {
  assert.equal(repositoryName("Nearby/Clank.Run"), "nearby/clank.run");
  assert.equal(
    workflowPathName(".github/workflows/clank-preview.yml"),
    ".github/workflows/clank-preview.yml",
  );
  assert.equal(branchRef("refs/heads/main"), "refs/heads/main");
  for (const value of ["nearby", "../nearby/app", "nearby/app/extra", "nearby/a b"]) {
    assert.throws(() => repositoryName(value), TypeError);
  }
  for (const value of [
    "clank-preview.yml",
    ".github/actions/clank-preview.yml",
    ".github/workflows/../preview.yml",
    ".github/workflows/preview.json",
  ]) {
    assert.throws(() => workflowPathName(value), TypeError);
  }
  for (const value of [
    "refs/pull/1/merge",
    "refs/heads/../main",
    "refs/heads/release.lock",
    "refs/heads/a//b",
  ]) {
    assert.throws(() => branchRef(value), TypeError);
  }
});

function oidcFixture() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const exported = publicKey.export({ format: "jwk" });
  const jwk = {
    kty: "RSA",
    use: "sig",
    alg: "RS256",
    kid: "github-key-0001",
    n: exported.n,
    e: exported.e,
  };
  const token = (overrides = {}, headerOverrides = {}) => {
    const header = encode({ typ: "JWT", alg: "RS256", kid: jwk.kid, ...headerOverrides });
    const payload = encode({
      iss: GITHUB_ACTIONS_OIDC_ISSUER,
      sub: "repo:nearby/app:pull_request",
      aud: "https://clank.run",
      iat: NOW_SECONDS,
      nbf: NOW_SECONDS - 5,
      exp: NOW_SECONDS + 5 * 60,
      jti: "github-jti-0000000000000001",
      repository: "nearby/app",
      repository_id: "92837465",
      workflow_ref: "nearby/app/.github/workflows/clank-preview.yml@refs/pull/482/merge",
      workflow_sha: "a".repeat(40),
      event_name: "pull_request",
      ref: "refs/pull/482/merge",
      run_id: "99112233",
      run_attempt: 2,
      actor: "octocat",
      repository_visibility: "private",
      ...overrides,
    });
    const signingInput = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256").update(signingInput).end().sign(privateKey, "base64url");
    return `${signingInput}.${signature}`;
  };
  return { jwk, token };
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function jsonResponse(value, url) {
  const body = JSON.stringify(value);
  const response = new Response(body, {
    status: 200,
    headers: {
      "content-length": String(Buffer.byteLength(body)),
      "content-type": "application/json",
    },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
