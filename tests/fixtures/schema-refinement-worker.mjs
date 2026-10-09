import assert from 'node:assert/strict';
import { s, ValidationError } from '../../dist/ai.js';
let checked = 0;
const failure = new Error('Refinement unavailable');
const invalid = [
  () => Promise.resolve(false), () => Promise.resolve(true),
  () => Promise.reject(failure), async () => false, async () => { throw failure; },
  () => ({ then(_resolve, reject) { reject(failure); } }),
  () => ({ get then() { throw failure; } }),
  () => 1, () => 0, () => 'approved', () => '', () => ({}),
  () => null, () => undefined, () => Symbol('truthy'), () => 1n,
];
for (const predicate of invalid) {
  const guarded = s.refine(s.string(), predicate, 'Guard failed');
  for (const [schema, input] of [
    [guarded, 'value'], [s.object({ required: guarded }), { required: 'value' }],
    [s.array(guarded), ['value']], [s.record(guarded), { key: 'value' }],
    [s.union([guarded, s.string()]), 'value'],
  ]) {
    assert.throws(() => schema.parse(input), { name: 'TypeError', message: 's.refine() predicates must return booleans synchronously.' });
    checked++;
  }
}
assert.equal(s.refine(s.string(), () => true, 'Guard failed').parse('valid'), 'valid');
assert.throws(() => s.refine(s.string(), () => false, 'Guard failed').parse('invalid'), ValidationError);
assert.throws(() => s.refine(s.string(), () => { throw failure; }, 'Guard failed').parse('value'), error => error === failure);
// Let promise rejection/thenable jobs and the real process rejection checks run.
for (let turn = 0; turn < 3; turn++) await new Promise(resolve => setImmediate(resolve));
process.stdout.write(JSON.stringify({ checked, normalBooleans: true, thrownFailurePreserved: true }) + '\n');
