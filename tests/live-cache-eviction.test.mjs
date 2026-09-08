import test from 'node:test';
import assert from 'node:assert/strict';
import { defineBackend, defineDatabase, defineTable, openBackend } from '../dist/backend.js';
import { s } from '../dist/ai.js';

test('live subscriptions survive cache eviction, retain selective dependencies, and release on disposal', async () => {
  const definition = defineBackend({ schema: defineDatabase({
    rows: defineTable({ value: s.number() }),
    switch: defineTable({ target: s.string() }),
  }) }).functions(({ query, mutation }) => ({
    read: query({ args: { id: s.id('rows') }, handler: ({ db }, { id }) => db.table('rows').get(id).value }),
    dynamic: query({ args: {}, handler: ({ db }) => {
      const selected = db.table('switch').query().first();
      return db.table('rows').get(selected.target).value;
    } }),
    add: mutation({ args: { value: s.number() }, handler: ({ db }, args) => db.table('rows').insert(args) }),
    write: mutation({ args: { id: s.id('rows'), value: s.number() }, handler: ({ db }, { id, value }) => db.table('rows').patch(id, { value }) }),
    select: mutation({ args: { target: s.string() }, handler: ({ db }, args) => {
      const previous = db.table('switch').query().first();
      return previous ? db.table('switch').patch(previous._id, args) : db.table('switch').insert(args);
    } }),
  }));
  const runtime = await openBackend(definition, { maxCacheEntries: 1, diagnostics: true });
  const disposers = [];
  try {
    const a = runtime.mutation('add', { value: 1 }).value, b = runtime.mutation('add', { value: 10 }).value;
    runtime.mutation('select', { target: a });
    const first = [], second = [], dynamic = [];
    // Warm-cache subscription creation exercises the cache-hit dependency path.
    runtime.query('read', { id: a });
    disposers.push(runtime.subscribe('read', { id: a }, value => first.push(value)));
    disposers.push(runtime.subscribe('read', { id: b }, value => second.push(value)));
    disposers.push(runtime.subscribe('dynamic', {}, value => dynamic.push(value)));
    runtime.mutation('write', { id: a, value: 2 });
    assert.deepEqual(first, [1, 2]);
    assert.deepEqual(second, [10], 'Unrelated evicted subscription must stay quiet');
    assert.deepEqual(dynamic, [1, 2]);
    runtime.mutation('select', { target: b });
    assert.deepEqual(dynamic, [1, 2, 10]);
    runtime.query('read', { id: a });
    runtime.mutation('write', { id: a, value: 3 });
    assert.deepEqual(first, [1, 2, 3]);
    assert.deepEqual(dynamic, [1, 2, 10], 'Dependencies must change after switching rows');
    runtime.mutation('write', { id: b, value: 11 });
    assert.deepEqual(second, [10, 11]);
    assert.deepEqual(dynamic, [1, 2, 10, 11]);
    assert.equal(runtime.inspectQueries().reduce((sum, query) => sum + query.cachedEntries, 0), 1);
    for (const dispose of disposers.splice(0)) dispose();
    runtime.mutation('write', { id: b, value: 12 });
    assert.deepEqual(second, [10, 11]);
    assert.equal(runtime.inspectQueries().reduce((sum, query) => sum + query.subscriptions, 0), 0);
  } finally { for (const dispose of disposers) dispose(); runtime.close(); }
});
