import assert from 'node:assert/strict';

let selecting = false;

// Select one genuine release allocation; restore native entropy synchronously
// before that allocation returns to the platform's asynchronous continuation.
export async function withReleaseId(expectedId, operation) {
  const bytes = Buffer.from(expectedId, 'base64url');
  assert.equal(bytes.byteLength, 18);
  assert.equal(bytes.toString('base64url'), expectedId);
  assert.equal(selecting, false, 'Release entropy scopes must not overlap.');
  const crypto = globalThis.crypto, native = crypto.getRandomValues;
  const descriptor = Object.getOwnPropertyDescriptor(crypto, 'getRandomValues');
  let consumed = false, installed = false;
  const restore = () => {
    if (!installed) return;
    if (descriptor) Object.defineProperty(crypto, 'getRandomValues', descriptor);
    else assert.equal(Reflect.deleteProperty(crypto, 'getRandomValues'), true);
    installed = false;
  };
  selecting = true;
  try {
    Object.defineProperty(crypto, 'getRandomValues', { configurable: true, writable: true, value(array) {
      if (!(array instanceof Uint8Array) || array.byteLength !== 18) return Reflect.apply(native, crypto, [array]);
      restore();
      consumed = true;
      array.set(bytes);
      return array;
    } });
    installed = true;
    const result = await operation();
    assert.equal(consumed, true, 'The genuine release allocator must consume the fixed entropy.');
    return result;
  } finally {
    restore();
    selecting = false;
    assert.deepEqual(Object.getOwnPropertyDescriptor(crypto, 'getRandomValues'), descriptor);
    assert.equal(crypto.getRandomValues, native);
  }
}
