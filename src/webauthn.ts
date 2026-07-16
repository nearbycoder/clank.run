export interface PasskeyRegistrationCredential {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: readonly string[];
  };
}

export interface PasskeyAuthenticationCredential {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string | null;
  };
}

export interface StoredPasskey {
  credentialId: string;
  publicKey: JsonWebKey;
  algorithm: number;
  counter: number;
  transports: readonly string[];
}

export interface VerifiedPasskeyAuthentication {
  counter: number;
  userVerified: boolean;
}

export function passkeyRegistrationOptions(input: {
  challenge: string;
  rpId: string;
  rpName: string;
  userId: string;
  userName: string;
  userDisplayName: string;
  excludeCredentialIds?: readonly string[];
  timeoutMs?: number;
  requireUserVerification?: boolean;
}): PublicKeyCredentialCreationOptionsJSON {
  return {
    challenge: input.challenge,
    rp: { id: input.rpId, name: input.rpName },
    user: {
      id: base64Url(new TextEncoder().encode(input.userId)),
      name: input.userName,
      displayName: input.userDisplayName,
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    timeout: input.timeoutMs ?? 5 * 60 * 1_000,
    attestation: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: input.requireUserVerification ? "required" : "preferred",
    },
    excludeCredentials: (input.excludeCredentialIds ?? []).map((id) => ({
      type: "public-key",
      id,
    })),
  };
}

export function passkeyAuthenticationOptions(input: {
  challenge: string;
  rpId: string;
  credentialIds: readonly { id: string; transports?: readonly string[] }[];
  timeoutMs?: number;
  requireUserVerification?: boolean;
}): PublicKeyCredentialRequestOptionsJSON {
  return {
    challenge: input.challenge,
    rpId: input.rpId,
    timeout: input.timeoutMs ?? 5 * 60 * 1_000,
    userVerification: input.requireUserVerification ? "required" : "preferred",
    allowCredentials: input.credentialIds.map((credential) => ({
      type: "public-key",
      id: credential.id,
      transports: credential.transports,
    })),
  };
}

export async function verifyPasskeyRegistration(input: {
  credential: PasskeyRegistrationCredential;
  challenge: string;
  origin: string;
  rpId: string;
  requireUserVerification?: boolean;
}): Promise<StoredPasskey> {
  validateCredentialEnvelope(input.credential);
  const clientBytes = decodeBase64Url(input.credential.response.clientDataJSON, "clientDataJSON");
  const client = parseClientData(clientBytes, "webauthn.create", input.challenge, input.origin);
  void client;
  const attestation = decodeCbor(decodeBase64Url(
    input.credential.response.attestationObject,
    "attestationObject",
  ));
  if (!(attestation instanceof Map)) throw new TypeError("Passkey attestation must be a CBOR map.");
  if (attestation.get("fmt") !== "none") {
    throw new TypeError("Only WebAuthn none attestation is accepted.");
  }
  const statement = attestation.get("attStmt");
  if (!(statement instanceof Map) || statement.size !== 0) throw new TypeError("None attestation must not contain a statement.");
  const authData = attestation.get("authData");
  if (!(authData instanceof Uint8Array)) throw new TypeError("Passkey attestation is missing authenticator data.");
  const parsed = await parseAuthenticatorData(authData, input.rpId, input.requireUserVerification ?? false, true);
  const rawId = decodeBase64Url(input.credential.rawId, "rawId");
  if (!timingSafeBytes(rawId, parsed.credentialId!)) throw new TypeError("Passkey credential ID does not match authenticator data.");
  if (input.credential.id !== input.credential.rawId) {
    const id = decodeBase64Url(input.credential.id, "id");
    if (!timingSafeBytes(id, rawId)) throw new TypeError("Passkey ID and raw ID do not match.");
  }
  const cose = decodeCbor(parsed.publicKeyBytes!);
  if (!(cose instanceof Map)) throw new TypeError("Passkey public key is invalid.");
  const converted = cosePublicKey(cose);
  return {
    credentialId: base64Url(rawId),
    publicKey: converted.key,
    algorithm: converted.algorithm,
    counter: parsed.counter,
    transports: sanitizeTransports(input.credential.response.transports ?? []),
  };
}

export async function verifyPasskeyAuthentication(input: {
  credential: PasskeyAuthenticationCredential;
  challenge: string;
  origin: string;
  rpId: string;
  stored: StoredPasskey;
  requireUserVerification?: boolean;
}): Promise<VerifiedPasskeyAuthentication> {
  validateCredentialEnvelope(input.credential);
  const rawId = decodeBase64Url(input.credential.rawId, "rawId");
  if (base64Url(rawId) !== input.stored.credentialId) throw new TypeError("Passkey credential is not registered.");
  const clientBytes = decodeBase64Url(input.credential.response.clientDataJSON, "clientDataJSON");
  parseClientData(clientBytes, "webauthn.get", input.challenge, input.origin);
  const authData = decodeBase64Url(input.credential.response.authenticatorData, "authenticatorData");
  const parsed = await parseAuthenticatorData(authData, input.rpId, input.requireUserVerification ?? false, false);
  const signed = concat(authData, await sha256Bytes(clientBytes));
  const signature = decodeBase64Url(input.credential.response.signature, "signature");
  if (!await verifySignature(input.stored.algorithm, input.stored.publicKey, signed, signature)) {
    throw new TypeError("Passkey signature is invalid.");
  }
  if (
    input.stored.counter !== 0
    && parsed.counter !== 0
    && parsed.counter <= input.stored.counter
  ) throw new TypeError("Passkey signature counter did not advance.");
  return { counter: parsed.counter, userVerified: parsed.userVerified };
}

export function serializeRegistrationCredential(credential: PublicKeyCredential): PasskeyRegistrationCredential {
  const response = credential.response as AuthenticatorAttestationResponse;
  const transports = typeof response.getTransports === "function" ? response.getTransports() : [];
  return {
    id: credential.id,
    rawId: base64Url(new Uint8Array(credential.rawId)),
    type: "public-key",
    response: {
      clientDataJSON: base64Url(new Uint8Array(response.clientDataJSON)),
      attestationObject: base64Url(new Uint8Array(response.attestationObject)),
      transports,
    },
  };
}

export function serializeAuthenticationCredential(credential: PublicKeyCredential): PasskeyAuthenticationCredential {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: base64Url(new Uint8Array(credential.rawId)),
    type: "public-key",
    response: {
      clientDataJSON: base64Url(new Uint8Array(response.clientDataJSON)),
      authenticatorData: base64Url(new Uint8Array(response.authenticatorData)),
      signature: base64Url(new Uint8Array(response.signature)),
      userHandle: response.userHandle ? base64Url(new Uint8Array(response.userHandle)) : null,
    },
  };
}

export function registrationOptionsForBrowser(
  options: PublicKeyCredentialCreationOptionsJSON,
): PublicKeyCredentialCreationOptions {
  return {
    ...options,
    challenge: decodeBase64Url(options.challenge, "challenge"),
    user: {
      ...options.user,
      id: decodeBase64Url(options.user.id, "user.id"),
    },
    excludeCredentials: options.excludeCredentials?.map((credential) => ({
      ...credential,
      id: decodeBase64Url(credential.id, "excludeCredentials.id"),
      transports: credential.transports as AuthenticatorTransport[] | undefined,
    })),
  } as PublicKeyCredentialCreationOptions;
}

export function authenticationOptionsForBrowser(
  options: PublicKeyCredentialRequestOptionsJSON,
): PublicKeyCredentialRequestOptions {
  return {
    ...options,
    challenge: decodeBase64Url(options.challenge, "challenge"),
    allowCredentials: options.allowCredentials?.map((credential) => ({
      ...credential,
      id: decodeBase64Url(credential.id, "allowCredentials.id"),
      transports: credential.transports as AuthenticatorTransport[] | undefined,
    })),
  } as PublicKeyCredentialRequestOptions;
}

export interface PublicKeyCredentialCreationOptionsJSON {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: readonly { type: "public-key"; alg: number }[];
  timeout: number;
  attestation: "none";
  authenticatorSelection: {
    residentKey: "preferred";
    userVerification: "preferred" | "required";
  };
  excludeCredentials: readonly PublicKeyCredentialDescriptorJSON[];
}

export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: "preferred" | "required";
  allowCredentials: readonly PublicKeyCredentialDescriptorJSON[];
}

export interface PublicKeyCredentialDescriptorJSON {
  type: "public-key";
  id: string;
  transports?: readonly string[];
}

interface ParsedAuthenticatorData {
  counter: number;
  userVerified: boolean;
  credentialId?: Uint8Array;
  publicKeyBytes?: Uint8Array;
}

async function parseAuthenticatorData(
  bytes: Uint8Array,
  rpId: string,
  requireUserVerification: boolean,
  requireAttestedData: boolean,
): Promise<ParsedAuthenticatorData> {
  if (bytes.byteLength < 37) throw new TypeError("Authenticator data is too short.");
  const expectedRpId = await sha256Bytes(new TextEncoder().encode(rpId));
  if (!timingSafeBytes(bytes.slice(0, 32), expectedRpId)) throw new TypeError("Passkey RP ID hash does not match.");
  const flags = bytes[32];
  if ((flags & 0x01) === 0) throw new TypeError("Passkey user presence is required.");
  const userVerified = (flags & 0x04) !== 0;
  if (requireUserVerification && !userVerified) throw new TypeError("Passkey user verification is required.");
  const counter = new DataView(bytes.buffer, bytes.byteOffset + 33, 4).getUint32(0);
  const hasAttestedData = (flags & 0x40) !== 0;
  if (requireAttestedData && !hasAttestedData) throw new TypeError("Passkey registration is missing attested credential data.");
  if (!hasAttestedData) return { counter, userVerified };
  if (bytes.byteLength < 55) throw new TypeError("Attested credential data is truncated.");
  const credentialLength = new DataView(bytes.buffer, bytes.byteOffset + 53, 2).getUint16(0);
  const credentialStart = 55;
  const credentialEnd = credentialStart + credentialLength;
  if (credentialLength < 8 || credentialLength > 1_024 || credentialEnd >= bytes.byteLength) {
    throw new TypeError("Passkey credential ID length is invalid.");
  }
  const publicKeyBytes = bytes.slice(credentialEnd);
  const decoder = new CborDecoder(publicKeyBytes);
  decoder.value();
  if (decoder.offset !== publicKeyBytes.byteLength) throw new TypeError("Passkey public key has trailing CBOR data.");
  return {
    counter,
    userVerified,
    credentialId: bytes.slice(credentialStart, credentialEnd),
    publicKeyBytes,
  };
}

function parseClientData(
  bytes: Uint8Array,
  type: "webauthn.create" | "webauthn.get",
  challenge: string,
  origin: string,
): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new TypeError("Passkey client data is not valid UTF-8 JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("Passkey client data must be an object.");
  const value = parsed as Record<string, unknown>;
  if (value.type !== type) throw new TypeError("Passkey ceremony type does not match.");
  if (value.challenge !== challenge) throw new TypeError("Passkey challenge does not match.");
  if (value.origin !== origin) throw new TypeError("Passkey origin does not match.");
  if (value.crossOrigin === true) throw new TypeError("Cross-origin passkey ceremonies are not accepted.");
  return value;
}

function cosePublicKey(cose: Map<unknown, unknown>): { key: JsonWebKey; algorithm: number } {
  const keyType = integer(cose.get(1), "COSE key type");
  const algorithm = integer(cose.get(3), "COSE algorithm");
  if (keyType === 2 && algorithm === -7) {
    if (integer(cose.get(-1), "COSE curve") !== 1) throw new TypeError("Only P-256 ES256 passkeys are supported.");
    const x = bytes(cose.get(-2), "COSE x coordinate");
    const y = bytes(cose.get(-3), "COSE y coordinate");
    if (x.byteLength !== 32 || y.byteLength !== 32) throw new TypeError("P-256 coordinate length is invalid.");
    return {
      algorithm,
      key: { kty: "EC", crv: "P-256", x: base64Url(x), y: base64Url(y), ext: true },
    };
  }
  if (keyType === 3 && algorithm === -257) {
    const modulus = bytes(cose.get(-1), "COSE RSA modulus");
    const exponent = bytes(cose.get(-2), "COSE RSA exponent");
    if (modulus.byteLength < 256 || exponent.byteLength < 1) throw new TypeError("RSA passkey key size is invalid.");
    return {
      algorithm,
      key: { kty: "RSA", n: base64Url(modulus), e: base64Url(exponent), alg: "RS256", ext: true },
    };
  }
  throw new TypeError(`Unsupported passkey key type or algorithm: ${keyType}/${algorithm}.`);
}

async function verifySignature(
  algorithm: number,
  key: JsonWebKey,
  data: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const cryptoName = "node:crypto";
  const crypto = await import(cryptoName) as unknown as {
    createPublicKey(options: { key: JsonWebKey; format: "jwk" }): unknown;
    verify(algorithm: string | null, data: Uint8Array, key: unknown, signature: Uint8Array): boolean;
  };
  if (algorithm !== -7 && algorithm !== -257) return false;
  try {
    return crypto.verify("sha256", data, crypto.createPublicKey({ key, format: "jwk" }), signature);
  } catch {
    return false;
  }
}

function validateCredentialEnvelope(credential: { id: unknown; rawId: unknown; type: unknown }): void {
  if (!credential || typeof credential !== "object") throw new TypeError("Passkey credential is required.");
  if (credential.type !== "public-key") throw new TypeError("Passkey credential type must be public-key.");
  if (typeof credential.id !== "string" || typeof credential.rawId !== "string") throw new TypeError("Passkey credential IDs are invalid.");
}

function sanitizeTransports(input: readonly string[]): string[] {
  const allowed = new Set(["ble", "hybrid", "internal", "nfc", "usb", "cable", "smart-card"]);
  return [...new Set(input.filter((value) => allowed.has(value)))].sort();
}

function decodeCbor(bytes: Uint8Array): unknown {
  const decoder = new CborDecoder(bytes);
  const value = decoder.value();
  if (decoder.offset !== bytes.byteLength) throw new TypeError("CBOR value has trailing bytes.");
  return value;
}

class CborDecoder {
  offset = 0;
  constructor(private readonly input: Uint8Array) {}

  value(depth = 0): unknown {
    if (depth > 64) throw new TypeError("CBOR nesting exceeds the supported limit.");
    const initial = this.byte();
    const major = initial >> 5;
    const additional = initial & 31;
    const length = this.length(additional);
    if (major === 0) return length;
    if (major === 1) return -1 - length;
    if (major === 2) return this.take(length);
    if (major === 3) return new TextDecoder("utf-8", { fatal: true }).decode(this.take(length));
    if (major === 4) {
      this.collectionLength(length, 1);
      return Array.from({ length }, () => this.value(depth + 1));
    }
    if (major === 5) {
      this.collectionLength(length, 2);
      const output = new Map<unknown, unknown>();
      for (let index = 0; index < length; index++) {
        const key = this.value(depth + 1);
        if (output.has(key)) throw new TypeError("CBOR map contains a duplicate key.");
        output.set(key, this.value(depth + 1));
      }
      return output;
    }
    if (major === 7) {
      if (additional === 20) return false;
      if (additional === 21) return true;
      if (additional === 22) return null;
    }
    throw new TypeError(`Unsupported CBOR major type ${major}.`);
  }

  private length(additional: number): number {
    if (additional < 24) return additional;
    if (additional === 24) return this.byte();
    if (additional === 25) return this.number(2);
    if (additional === 26) return this.number(4);
    if (additional === 27) {
      const high = this.number(4);
      const low = this.number(4);
      const value = high * 2 ** 32 + low;
      if (!Number.isSafeInteger(value)) throw new TypeError("CBOR integer exceeds safe range.");
      return value;
    }
    throw new TypeError("Indefinite-length or reserved CBOR values are not accepted.");
  }

  private byte(): number {
    if (this.offset >= this.input.byteLength) throw new TypeError("CBOR value is truncated.");
    return this.input[this.offset++];
  }

  private collectionLength(length: number, minimumBytesPerEntry: number): void {
    const remaining = this.input.byteLength - this.offset;
    if (
      !Number.isSafeInteger(length)
      || length < 0
      || length > 4_096
      || length * minimumBytesPerEntry > remaining
    ) throw new TypeError("CBOR collection length is invalid.");
  }

  private number(length: number): number {
    const value = this.take(length);
    let output = 0;
    for (const byte of value) output = output * 256 + byte;
    return output;
  }

  private take(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.input.byteLength) {
      throw new TypeError("CBOR byte string is truncated.");
    }
    const value = this.input.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
}

async function sha256Bytes(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", value));
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
}

function bytes(value: unknown, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${name} must be bytes.`);
  return value;
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be an integer.`);
  return value as number;
}

function timingSafeBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

function decodeBase64Url(value: string, name: string): Uint8Array {
  if (typeof value !== "string" || value.length > 64 * 1024 || !/^[A-Za-z0-9_-]*$/u.test(value)) {
    throw new TypeError(`Passkey ${name} is not valid base64url.`);
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try { binary = atob(base64); }
  catch { throw new TypeError(`Passkey ${name} is not valid base64url.`); }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
