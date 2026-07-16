import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from "../dist/webauthn.js";

const base64url = (value) => Buffer.from(value).toString("base64url");
const decode = (value) => new Uint8Array(Buffer.from(value, "base64url"));
const sha256 = (value) => new Uint8Array(createHash("sha256").update(value).digest());

function concatenate(...values) {
  const bytes = values.map((value) => value instanceof Uint8Array ? value : new Uint8Array(value));
  const output = new Uint8Array(bytes.reduce((total, value) => total + value.byteLength, 0));
  let offset = 0;
  for (const value of bytes) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function unsigned32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function cborHeader(major, length) {
  if (length < 24) return Uint8Array.of((major << 5) | length);
  if (length <= 0xff) return Uint8Array.of((major << 5) | 24, length);
  if (length <= 0xffff) return Uint8Array.of((major << 5) | 25, length >> 8, length & 0xff);
  throw new Error("Test CBOR value is too large.");
}

function cbor(value) {
  if (typeof value === "number") {
    return value >= 0 ? cborHeader(0, value) : cborHeader(1, -1 - value);
  }
  if (typeof value === "string") {
    const encoded = new TextEncoder().encode(value);
    return concatenate(cborHeader(3, encoded.byteLength), encoded);
  }
  if (value instanceof Uint8Array) return concatenate(cborHeader(2, value.byteLength), value);
  if (value instanceof Map) {
    return concatenate(
      cborHeader(5, value.size),
      ...[...value].flatMap(([key, entry]) => [cbor(key), cbor(entry)]),
    );
  }
  throw new Error(`Unsupported test CBOR value: ${String(value)}`);
}

test("WebAuthn registration and authentication verify RP binding, UV, signatures, and counters", async () => {
  const rpId = "todo.test";
  const origin = "https://todo.test";
  const challenge = base64url(Buffer.from("registration challenge with enough entropy"));
  const credentialId = new Uint8Array(24).map((_, index) => index + 1);
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = new Map([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, decode(jwk.x)],
    [-3, decode(jwk.y)],
  ]);
  const credentialLength = Uint8Array.of(credentialId.byteLength >> 8, credentialId.byteLength & 0xff);
  const registrationAuthData = concatenate(
    sha256(rpId),
    Uint8Array.of(0x45),
    unsigned32(4),
    new Uint8Array(16),
    credentialLength,
    credentialId,
    cbor(cose),
  );
  const attestation = cbor(new Map([
    ["fmt", "none"],
    ["attStmt", new Map()],
    ["authData", registrationAuthData],
  ]));
  const registrationClientData = new TextEncoder().encode(JSON.stringify({
    type: "webauthn.create",
    challenge,
    origin,
    crossOrigin: false,
  }));
  const credential = {
    id: base64url(credentialId),
    rawId: base64url(credentialId),
    type: "public-key",
    response: {
      clientDataJSON: base64url(registrationClientData),
      attestationObject: base64url(attestation),
      transports: ["internal", "hybrid", "internal", "not-real"],
    },
  };
  const stored = await verifyPasskeyRegistration({
    credential,
    challenge,
    origin,
    rpId,
    requireUserVerification: true,
  });
  assert.equal(stored.credentialId, base64url(credentialId));
  assert.equal(stored.algorithm, -7);
  assert.equal(stored.counter, 4);
  assert.deepEqual(stored.transports, ["hybrid", "internal"]);

  const authenticationChallenge = base64url(Buffer.from("authentication challenge with enough entropy"));
  const authenticationClientData = new TextEncoder().encode(JSON.stringify({
    type: "webauthn.get",
    challenge: authenticationChallenge,
    origin,
    crossOrigin: false,
  }));
  const authenticationAuthData = concatenate(
    sha256(rpId),
    Uint8Array.of(0x05),
    unsigned32(5),
  );
  const signed = concatenate(authenticationAuthData, sha256(authenticationClientData));
  const signature = sign("sha256", signed, privateKey);
  const assertion = {
    id: base64url(credentialId),
    rawId: base64url(credentialId),
    type: "public-key",
    response: {
      clientDataJSON: base64url(authenticationClientData),
      authenticatorData: base64url(authenticationAuthData),
      signature: base64url(signature),
      userHandle: null,
    },
  };
  const verified = await verifyPasskeyAuthentication({
    credential: assertion,
    challenge: authenticationChallenge,
    origin,
    rpId,
    stored,
    requireUserVerification: true,
  });
  assert.deepEqual(verified, { counter: 5, userVerified: true });

  await assert.rejects(
    verifyPasskeyAuthentication({
      credential: assertion,
      challenge: authenticationChallenge,
      origin: "https://evil.test",
      rpId,
      stored,
      requireUserVerification: true,
    }),
    /origin/i,
  );
  await assert.rejects(
    verifyPasskeyAuthentication({
      credential: assertion,
      challenge: authenticationChallenge,
      origin,
      rpId,
      stored: { ...stored, counter: 5 },
      requireUserVerification: true,
    }),
    /counter/i,
  );
});

test("WebAuthn rejects oversized and excessively nested CBOR claims without allocating them", async () => {
  const clientData = base64url(new TextEncoder().encode(JSON.stringify({
    type: "webauthn.create",
    challenge: "challenge",
    origin: "https://todo.test",
    crossOrigin: false,
  })));
  const oversizedMap = base64url(Uint8Array.of(
    0xa0 | 27,
    0, 0, 0, 0,
    0, 1, 0, 0,
  ));
  await assert.rejects(
    verifyPasskeyRegistration({
      credential: {
        id: "AQIDBAUGBwg",
        rawId: "AQIDBAUGBwg",
        type: "public-key",
        response: {
          clientDataJSON: clientData,
          attestationObject: oversizedMap,
        },
      },
      challenge: "challenge",
      origin: "https://todo.test",
      rpId: "todo.test",
    }),
    /collection length|safe range/i,
  );

  const nested = new Uint8Array(66).fill(0x81);
  nested[nested.length - 1] = 0;
  await assert.rejects(
    verifyPasskeyRegistration({
      credential: {
        id: "AQIDBAUGBwg",
        rawId: "AQIDBAUGBwg",
        type: "public-key",
        response: {
          clientDataJSON: clientData,
          attestationObject: base64url(nested),
        },
      },
      challenge: "challenge",
      origin: "https://todo.test",
      rpId: "todo.test",
    }),
    /nesting/i,
  );
});
