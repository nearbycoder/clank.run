import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { defineAuth, defineBackend, defineDatabase, defineJobs, defineReviewedAction, defineTable,
  defineWorkflow, defineWorkflows, openBackend, openJobs, openSQLite, s, workflowManifest } from '../dist/index.js';
import { waitDefinition } from './fixtures/workflow-wait-process.mjs';

const internal = Symbol.for('clank.sqlite.internal');
const policy = { signingKey: 'workflow-test-secret-is-long-enough-01', policyRevision: 1 };
function declaration(schema, mode = 'event', timeoutMs = 60_000) {
  return waitDefinition(schema, mode, timeoutMs);
}
async function fixture(mode = 'event', options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'clank-wait-'));
  const schema = defineDatabase({ events: defineTable({ value: s.string() }) });
  const { definition, workflow } = declaration(schema, mode, options.timeoutMs);
  const database = await openSQLite(schema, { path: join(root, 'app.sqlite'), changePollIntervalMs: 0 });
  let runtime = openJobs(definition, { database, workflowWaits: policy, ...options });
  return { root, schema, database, definition, workflow, get runtime() { return runtime; },
    reopen(overrides = {}) { runtime.close(); runtime = openJobs(definition, { database, workflowWaits: policy, ...options, ...overrides }); },
    async close() { runtime.close(); database.close(); await rm(root, { recursive: true, force: true }); } };
}
function submission(ticket, overrides = {}) {
  return { waitId: ticket.id, expectedVersion: ticket.version, resumeToken: ticket.resumeToken,
    idempotencyKey: 'wait-operation-00001', choice: 'resume', result: { value: 'accepted' }, ...overrides };
}

test('durable waits release job slots, preserve their deadline across restart, and resume a typed dependency once', async () => {
  const f = await fixture(); try {
    const run = f.runtime.startWorkflow(f.workflow, { label: 'Confirm delivery' });
    const first = f.runtime.getWorkflowWait(run.id, 'gate');
    assert.equal(f.runtime.getWorkflow(run.id).state, 'waiting');
    assert.equal(f.runtime.getWorkflow(run.id).steps.find(s => s.name === 'gate').state, 'awaiting-event');
    assert.equal(f.runtime.listWorkflows({ state: 'waiting' }).length, 1);
    assert.equal(f.runtime.listWorkflows({ state: 'running' }).length, 0);
    assert.equal(f.runtime.stats().queued, 0); assert.equal(f.runtime.stats().running, 0);
    f.runtime.enqueue(f.definition.jobs.save, { value: 'unrelated' });
    assert.equal(await f.runtime.workOnce(), true);
    f.reopen(); const ticket = f.runtime.getWorkflowWait(run.id, 'gate');
    assert.deepEqual(ticket, first);
    const input = submission(ticket), receipt = f.runtime.resumeWorkflowWait(input);
    assert.equal(receipt.state, 'resumed'); assert.equal(receipt.version, 2);
    assert.deepEqual(f.runtime.resumeWorkflowWait(input), receipt);
    assert.throws(() => f.runtime.resumeWorkflowWait({ ...input, result: { value: 'changed' } }), e => e.code === 'WAIT_RETRY_CHANGED');
    assert.equal(f.runtime.stats().queued, 1);
    assert.equal(await f.runtime.workOnce(), true);
    assert.equal(f.runtime.getWorkflow(run.id).output, 'accepted');
    assert.equal(f.database.read(db => db.table('events').collect()).length, 2);
    assert.deepEqual(f.runtime.resumeWorkflowWait(input), receipt);
    assert.equal(f.runtime.stats().queued, 0);
    const publicText = JSON.stringify([f.runtime.getWorkflow(run.id), f.runtime.workflowEvents(run.id), workflowManifest(f.definition)]);
    assert.equal(publicText.includes(ticket.resumeToken), false);
    assert.equal(publicText.includes('nonce'), false);
    assert.equal(f.database[internal].prepare('SELECT count(*) AS count FROM clank_workflow_wait_receipts').get().count, 1);
  } finally { await f.close(); }
});

test('timeouts, denial, cancellation and purge cannot be reversed by a late resume', async () => {
  let clock = 10_000;
  const f = await fixture('event', { timeoutMs: 1000, now: () => clock }); try {
    const first = f.runtime.startWorkflow(f.workflow, { label: 'Deadline' });
    const ticket = f.runtime.getWorkflowWait(first.id, 'gate');
    clock = ticket.deadline;
    assert.throws(() => f.runtime.resumeWorkflowWait(submission(ticket)), e => e.code === 'WAIT_EXPIRED');
    f.runtime.advanceWorkflows();
    assert.equal(f.runtime.getWorkflow(first.id).state, 'failed');
    assert.equal(f.runtime.getWorkflowWait(first.id, 'gate').state, 'timed-out');
    assert.throws(() => f.runtime.resumeWorkflowWait(submission(ticket)), e => e.code === 'WAIT_CLOSED');
    const second = f.runtime.startWorkflow(f.workflow, { label: 'Cancel' });
    const cancelled = f.runtime.getWorkflowWait(second.id, 'gate');
    assert.equal(f.runtime.cancelWorkflow(second.id), true);
    assert.equal(f.runtime.getWorkflowWait(second.id, 'gate').state, 'cancelled');
    assert.throws(() => f.runtime.resumeWorkflowWait(submission(cancelled)), e => e.code === 'WAIT_CLOSED');
    const third = f.runtime.startWorkflow(f.workflow, { label: 'Deny' });
    const denied = f.runtime.getWorkflowWait(third.id, 'gate');
    const input = submission(denied, { choice: 'deny', result: undefined });
    const receipt = f.runtime.resumeWorkflowWait(input);
    assert.equal(receipt.state, 'denied'); assert.equal(f.runtime.getWorkflow(third.id).state, 'failed');
    assert.deepEqual(f.runtime.resumeWorkflowWait(input), receipt);
    clock++;
    assert.equal(f.runtime.purgeWorkflows({ states: ['failed', 'cancelled'], before: clock }), 3);
    assert.throws(() => f.runtime.resumeWorkflowWait(input), e => e.code === 'WAIT_UNKNOWN');
    assert.equal(f.runtime.stats().queued, 0);
  } finally { await f.close(); }
});

test('current policy rotation fences an already-open controller and old resume tokens', async () => {
  const f = await fixture(); let next;
  try {
    const run = f.runtime.startWorkflow(f.workflow, { label: 'Rotation' }), old = f.runtime.getWorkflowWait(run.id, 'gate');
    const updated = { signingKey: 'workflow-test-secret-is-long-enough-02', policyRevision: 2 };
    next = openJobs(f.definition, { database: f.database, workflowWaits: updated });
    assert.throws(() => f.runtime.resumeWorkflowWait(submission(old)), e => e.code === 'WAIT_POLICY');
    assert.throws(() => openJobs(f.definition, { database: f.database, workflowWaits: policy }), /must increase/);
    const fresh = next.getWorkflowWait(run.id, 'gate');
    assert.equal(fresh.deadline, old.deadline); assert.equal(fresh.version, old.version);
    assert.throws(() => next.resumeWorkflowWait(submission(old)), e => e.code === 'WAIT_TOKEN');
    assert.equal(next.resumeWorkflowWait(submission(fresh)).state, 'resumed');
    assert.equal(next.stats().queued, 1);
  } finally { next?.close(); await f.close(); }
});

test('invalid result, foreign token, changed key and stale version have no partial effects', async () => {
  const f = await fixture(); try {
    const first = f.runtime.startWorkflow(f.workflow, { label: 'One' }), second = f.runtime.startWorkflow(f.workflow, { label: 'Two' });
    const a = f.runtime.getWorkflowWait(first.id, 'gate'), b = f.runtime.getWorkflowWait(second.id, 'gate');
    assert.throws(() => f.runtime.resumeWorkflowWait(submission(a, { resumeToken: b.resumeToken })), e => e.code === 'WAIT_TOKEN');
    assert.throws(() => f.runtime.resumeWorkflowWait(submission(a, { expectedVersion: 2 })), e => e.code === 'WAIT_CLOSED');
    assert.throws(() => f.runtime.resumeWorkflowWait(submission(a, { idempotencyKey: 'short' })), e => e.code === 'WAIT_INPUT');
    assert.throws(() => f.runtime.resumeWorkflowWait(submission(a, { result: { value: 4 } })));
    assert.equal(f.runtime.getWorkflowWait(first.id, 'gate').state, 'pending');
    assert.equal(f.runtime.stats().queued, 0);
    assert.equal(f.database[internal].prepare('SELECT count(*) AS count FROM clank_workflow_wait_receipts').get().count, 0);
    assert.throws(() => defineDatabase({ workflow_waits: defineTable({ value: s.string() }) }), /reserved/i);
  } finally { await f.close(); }
});

test('a decision wait rejects a raw trusted resume without an accepted reviewed action', async () => {
  const f = await fixture('decision'); try {
    const run = f.runtime.startWorkflow(f.workflow, { label: 'Review' }), ticket = f.runtime.getWorkflowWait(run.id, 'gate');
    assert.equal(f.runtime.getWorkflow(run.id).steps.find(s => s.name === 'gate').state, 'awaiting-decision');
    assert.throws(() => f.runtime.resumeWorkflowWait(submission(ticket)), e => e.code === 'WAIT_REVIEW_REQUIRED');
    assert.equal(f.runtime.stats().queued, 0);
  } finally { await f.close(); }
});

const origin = 'https://wait.test';
function request(path, body, session) {
  return new Request(origin + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(session ? { cookie: session.cookie, 'x-clank-csrf': session.csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function register(runtime, email = 'owner@example.test') {
  const response = await runtime.handle(request('/__clank/auth/register', { email, password: 'workflow-fixture-passphrase-123456', profile: {} }));
  assert.equal(response.status, 201); const body = await response.json();
  const session = { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrfToken };
  return { ...session, auth: await runtime.auth.resolve(request('/', undefined, session)) };
}
async function humanFixture() {
  const root = await mkdtemp(join(tmpdir(), 'clank-reviewed-wait-'));
  const schema = defineDatabase({ events: defineTable({ value: s.string() }), items: defineTable({ allowed: s.boolean() }).owned() });
  const { definition, workflow } = declaration(schema, 'decision');
  const backend = defineBackend({ schema, auth: defineAuth(), jobs: definition }).functions(({ mutation }) => ({
    add: mutation({ args: {}, handler: ({ db }) => db.table('items').insert({ allowed: true }) }),
    revoke: mutation({ args: { id: s.string() }, handler: ({ db }, { id }) => db.table('items').patch(id, { allowed: false }) }),
    start: mutation({ args: { label: s.string() }, handler: ({ jobs }, input) => jobs.startWorkflow(workflow, input) }),
  }));
  let runtime;
  const action = defineReviewedAction(schema, { revision: 'workflow-wait-v1', title: 'Resume reviewed workflow',
    previewDependencies: 'records', args: s.object({ workflowId: s.string(), itemId: s.string(), value: s.string(), key: s.string() }),
    authorize: ({ db }, { itemId }) => db.table('items').get(itemId)?.allowed === true,
    authorizeApproval: ({ auth }, plan) => auth.user.id === plan.requestedBy,
    preview: ({ db, auth }, input) => {
      db.table('items').get(input.itemId);
      const ticket = runtime.jobs.getWorkflowWait(input.workflowId, 'gate');
      if (!ticket || ticket.ownerId !== auth.user.id) throw new Error('Workflow owner must review its wait.');
      return { waitId: ticket.id, version: ticket.version, deadline: ticket.deadline, request: ticket.request,
        tokenDigest: createHash('sha256').update(ticket.resumeToken).digest('hex') };
    },
    execute: (_, input, preview) => {
      const ticket = runtime.jobs.getWorkflowWait(input.workflowId, 'gate');
      if (!ticket || ticket.id !== preview.waitId || ticket.version !== preview.version
        || createHash('sha256').update(ticket.resumeToken).digest('hex') !== preview.tokenDigest) throw new Error('Wait changed after review.');
      return runtime.jobs.resumeWorkflowWait(submission(ticket, { idempotencyKey: input.key, result: { value: input.value } }));
    },
  });
  const options = { path: join(root, 'app.sqlite'), jobs: { workflowWaits: policy }, reviewedActions: { actions: { resume: action } } };
  runtime = await openBackend(backend, options);
  return { get runtime() { return runtime; }, schema,
    async reopen() { runtime.close(); runtime = await openBackend(backend, options); },
    async close() { runtime.close(); await rm(root, { recursive: true, force: true }); } };
}

test('human waits commit only through current reviewed actions and do not persist plaintext tokens', async () => {
  const f = await humanFixture(); try {
    const owner = await register(f.runtime), caller = await f.runtime.caller(request('/', undefined, owner));
    const itemId = caller.mutation('add', {}).value;
    const run = caller.mutation('start', { label: 'Approve delivery' }).value;
    const ticket = f.runtime.jobs.getWorkflowWait(run.id, 'gate');
    const plan = f.runtime.reviewedActions.plan('resume', { workflowId: run.id, itemId, value: 'human-approved', key: 'reviewed-wait-key-001' }, owner.auth);
    assert.throws(() => f.runtime.reviewedActions.commit(plan.id, owner.auth), e => e.code === 'APPROVAL_REQUIRED');
    f.runtime.reviewedActions.decide(plan.id, 'approve', owner.auth);
    caller.mutation('add', {}); // An unrelated record does not invalidate a record-bound review.
    await f.reopen(); owner.auth = await f.runtime.auth.resolve(request('/', undefined, owner));
    const receipt = f.runtime.reviewedActions.commit(plan.id, owner.auth);
    assert.equal(receipt.output.state, 'resumed'); assert.equal(receipt.output.reviewPlanId, plan.id);
    assert.equal(receipt.output.requester, owner.auth.user.id); assert.equal(receipt.output.approver, owner.auth.user.id);
    assert.deepEqual(f.runtime.reviewedActions.commit(plan.id, owner.auth), receipt);
    assert.equal(f.runtime.jobs.stats().queued, 1);
    assert.equal(await f.runtime.jobs.workOnce(), true);
    assert.equal(f.runtime.jobs.getWorkflow(run.id).output, 'human-approved');
    const stored = JSON.stringify(f.runtime.database[internal].prepare('SELECT input,preview FROM clank_reviewed_plans').all());
    assert.equal(stored.includes(ticket.resumeToken), false);
    const next = (await f.runtime.caller(request('/', undefined, owner))).mutation('start', { label: 'After commit' }).value;
    assert.throws(() => f.runtime.jobs.resumeWorkflowWait(submission(f.runtime.jobs.getWorkflowWait(next.id, 'gate'))), e => e.code === 'WAIT_REVIEW_REQUIRED');
  } finally { await f.close(); }
});

test('affected-record changes and revoked sessions cannot commit a human wait', async () => {
  const f = await humanFixture(); try {
    const owner = await register(f.runtime), caller = await f.runtime.caller(request('/', undefined, owner));
    const itemId = caller.mutation('add', {}).value, run = caller.mutation('start', { label: 'Revocation' }).value;
    const plan = f.runtime.reviewedActions.plan('resume', { workflowId: run.id, itemId, value: 'forbidden', key: 'reviewed-wait-key-002' }, owner.auth);
    f.runtime.reviewedActions.decide(plan.id, 'approve', owner.auth);
    caller.mutation('revoke', { id: itemId });
    assert.throws(() => f.runtime.reviewedActions.commit(plan.id, owner.auth), e => ['PREVIEW_STALE', 'FORBIDDEN'].includes(e.code));
    assert.equal(f.runtime.jobs.getWorkflow(run.id).state, 'waiting');
    const liveItem = caller.mutation('add', {}).value;
    const sessionPlan = f.runtime.reviewedActions.plan('resume', { workflowId: run.id, itemId: liveItem, value: 'forbidden', key: 'reviewed-wait-key-003' }, owner.auth);
    f.runtime.reviewedActions.decide(sessionPlan.id, 'approve', owner.auth);
    const logout = await f.runtime.handle(request('/__clank/auth/logout', {}, owner));
    assert.equal(logout.status, 200);
    assert.throws(() => f.runtime.reviewedActions.commit(sessionPlan.id, owner.auth));
    assert.equal(f.runtime.jobs.getWorkflow(run.id).state, 'waiting');
    assert.equal(f.runtime.jobs.stats().queued, 0);
    assert.equal(f.runtime.database[internal].prepare('SELECT count(*) AS count FROM clank_workflow_wait_receipts').get().count, 0);
  } finally { await f.close(); }
});

test('native browser decision forms return to the approval inbox while JSON clients keep their response', async () => {
  const f = await humanFixture(); try {
    const owner = await register(f.runtime), caller = await f.runtime.caller(request('/', undefined, owner));
    const itemId = caller.mutation('add', {}).value, run = caller.mutation('start', { label: 'Browser review' }).value;
    const plan = f.runtime.reviewedActions.plan('resume', { workflowId: run.id, itemId, value: 'approved', key: 'browser-redirect-key-001' }, owner.auth);
    const form = new Request(origin + '/__clank/approvals/decide', { method: 'POST', headers: { origin, cookie: owner.cookie,
      accept: 'text/html,application/xhtml+xml', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id: plan.id, decision: 'approve', csrf: owner.csrf }) });
    const response = await f.runtime.handle(form);
    assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/__clank/approvals');
    assert.equal(f.runtime.reviewedActions.inbox(owner.auth)[0].status, 'approved');
    assert.equal(f.runtime.jobs.getWorkflow(run.id).state, 'waiting');
    const another = caller.mutation('start', { label: 'JSON review' }).value;
    const jsonPlan = f.runtime.reviewedActions.plan('resume', { workflowId: another.id, itemId, value: 'approved', key: 'browser-redirect-key-002' }, owner.auth);
    const jsonResponse = await f.runtime.handle(request('/__clank/approvals/decide', { id: jsonPlan.id, decision: 'approve' }, owner));
    assert.equal(jsonResponse.status, 200); assert.equal((await jsonResponse.json()).plan.status, 'approved');
  } finally { await f.close(); }
});

async function controller(path) {
  const child = fork(new URL('./fixtures/workflow-wait-process.mjs', import.meta.url), [path], { execArgv: ['--disable-warning=ExperimentalWarning'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let diagnostic = ''; child.stdout.on('data', data => { diagnostic += data; }); child.stderr.on('data', data => { diagnostic += data; });
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'exit').then(([code, signal]) => { throw new Error(`Workflow fixture exited ${code}/${signal}: ${diagnostic.slice(-2000)}`); }),
  ]);
  assert.ok(ready.port);
  return { child, async call(path, body) {
    const response = await fetch(`http://127.0.0.1:${ready.port}${path}`, { method: 'POST', headers: { authorization: 'Bearer workflow-fixture-adapter', 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() };
  }, async close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  } };
}

test('actual SIGKILL loses an accepted resume response but restart returns one durable receipt and one downstream job', { timeout: 30_000 }, async () => {
  const f = await fixture(); let first, second;
  try {
    const run = f.runtime.startWorkflow(f.workflow, { label: 'Lost response' }), ticket = f.runtime.getWorkflowWait(run.id, 'gate');
    const input = submission(ticket);
    first = await controller(join(f.root, 'app.sqlite')); second = await controller(join(f.root, 'app.sqlite'));
    const committed = once(first.child, 'message');
    const held = first.call('/resume', { submission: input, hold: true }).then(() => ({ unexpectedResponse: true }), error => ({ error }));
    assert.equal((await committed)[0].committed, ticket.id);
    assert.equal(f.runtime.getWorkflowWait(run.id, 'gate').state, 'resumed');
    assert.equal(f.runtime.stats().queued, 1);
    const exited = once(first.child, 'exit'); first.child.kill('SIGKILL');
    assert.equal((await exited)[1], 'SIGKILL'); assert.ok((await held).error);
    const retry = await second.call('/resume', { submission: input });
    assert.equal(retry.status, 200); assert.equal(retry.body.state, 'resumed');
    await second.close(); second = await controller(join(f.root, 'app.sqlite'));
    assert.deepEqual((await second.call('/resume', { submission: input })).body, retry.body);
    assert.equal(f.runtime.stats().queued, 1);
    assert.equal(f.database[internal].prepare('SELECT count(*) AS count FROM clank_workflow_wait_receipts').get().count, 1);
    assert.equal(await f.runtime.workOnce(), true);
    assert.equal(f.runtime.getWorkflow(run.id).output, 'accepted');
  } finally { await first?.close(); await second?.close(); await f.close(); }
});

test('two actual controllers serialize resume/cancel and resume/deadline races into one wait transition', { timeout: 30_000 }, async () => {
  const f = await fixture(); let a, b;
  try {
    a = await controller(join(f.root, 'app.sqlite')); b = await controller(join(f.root, 'app.sqlite'));
    for (const race of ['cancel', 'timeout', 'duplicate']) {
      for (let index = 0; index < 4; index++) {
        const run = f.runtime.startWorkflow(f.workflow, { label: `${race}-${index}` }), ticket = f.runtime.getWorkflowWait(run.id, 'gate');
        const input = submission(ticket, { idempotencyKey: `race-${race}-operation-${index}` });
        const responses = await Promise.all([
          a.call('/resume', { submission: input, clock: ticket.deadline - 1 }),
          race === 'cancel' ? b.call('/cancel', { workflowId: run.id })
            : race === 'timeout' ? b.call('/tick', { clock: ticket.deadline })
              : b.call('/resume', { submission: input, clock: ticket.deadline - 1 }),
        ]);
        assert.ok(responses.every(response => [200, 409].includes(response.status)));
        const row = f.database[internal].prepare('SELECT state,version FROM clank_workflow_waits WHERE id=?').get(ticket.id);
        assert.equal(row.version, 2); assert.notEqual(row.state, 'pending');
        assert.equal(f.database[internal].prepare('SELECT count(*) AS count FROM clank_workflow_wait_receipts WHERE wait_id=?').get(ticket.id).count, row.state === 'resumed' ? 1 : 0);
        assert.equal(f.database[internal].prepare('SELECT count(*) AS count FROM clank_jobs WHERE idempotency_key=?').get(`workflow:${run.id}:save`).count, row.state === 'resumed' ? 1 : 0);
        if (race === 'duplicate') { assert.equal(row.state, 'resumed'); assert.deepEqual(responses[0].body, responses[1].body); }
      }
    }
  } finally { await a?.close(); await b?.close(); await f.close(); }
});

test('wait storage bounds reject new authority without evicting pending waits or retry receipts', async () => {
  const f = await fixture(); try {
    const run = f.runtime.startWorkflow(f.workflow, { label: 'Retained wait' }), ticket = f.runtime.getWorkflowWait(run.id, 'gate');
    f.database[internal].exec(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<9999)
      INSERT INTO clank_workflow_waits SELECT 'capacity_'||n,'capacity_workflow_'||n,'gate','event','cancelled','{"title":"capacity"}','retained-nonce',2,1,2 FROM seq`);
    const refused = f.runtime.startWorkflow(f.workflow, { label: 'Full' });
    assert.equal(f.runtime.getWorkflow(refused.id).state, 'failed');
    assert.match(f.runtime.getWorkflow(refused.id).error, /capacity/);
    assert.equal(f.runtime.getWorkflowWait(run.id, 'gate').state, 'pending');
    f.database[internal].exec(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<20000)
      INSERT INTO clank_workflow_wait_receipts SELECT 'capacity_wait_'||n,'capacity_key', 'retained_digest',NULL,'{}' FROM seq`);
    assert.throws(() => f.runtime.resumeWorkflowWait(submission(ticket)), e => e.code === 'WAIT_CAPACITY');
    assert.equal(f.runtime.getWorkflowWait(run.id, 'gate').version, 1);
    assert.equal(f.runtime.stats().queued, 0);
    assert.equal(f.database[internal].prepare('SELECT count(*) AS count FROM clank_workflow_wait_receipts').get().count, 20000);
  } finally { await f.close(); }
});

test('unmapped configuration, unsupported protocol and stale definitions refuse pending waits', async () => {
  const f = await fixture(); let changed;
  try {
    const run = f.runtime.startWorkflow(f.workflow, { label: 'Retained' }), ticket = f.runtime.getWorkflowWait(run.id, 'gate');
    assert.throws(() => openJobs(f.definition, { database: f.database }), /configuration/);
    assert.throws(() => openJobs(f.definition, { database: f.database, workflowWaits: { ...policy, signingKey: 'a-different-secret-with-same-revision' } }), /must increase/);
    assert.equal(f.runtime.getWorkflowWait(run.id, 'gate').state, 'pending');
    f.database[internal].prepare('UPDATE clank_workflow_wait_state SET protocol=99').run();
    assert.throws(() => openJobs(f.definition, { database: f.database, workflowWaits: policy }), /Unsupported persisted/);
    assert.throws(() => f.runtime.resumeWorkflowWait(submission(ticket)), e => e.code === 'WAIT_POLICY');
    f.database[internal].prepare('UPDATE clank_workflow_wait_state SET protocol=1').run();
    const revised = declaration(f.schema, 'event', 60_001);
    changed = openJobs(revised.definition, { database: f.database, workflowWaits: policy });
    assert.throws(() => changed.resumeWorkflowWait(submission(ticket)), e => e.code === 'WAIT_DEFINITION');
    changed.advanceWorkflows();
    assert.equal(changed.getWorkflow(run.id).state, 'failed');
    assert.equal(changed.getWorkflowWait(run.id, 'gate').state, 'cancelled');
    assert.equal(changed.stats().queued, 0);
    assert.equal(f.database[internal].prepare('SELECT count(*) AS count FROM clank_workflow_wait_receipts').get().count, 0);
  } finally { changed?.close(); await f.close(); }
});

test('asynchronous and oversized wait mappers fail without partial wait state or unhandled rejection', async () => {
  const f = await fixture(); const errors = []; const rejected = error => errors.push(error); process.on('unhandledRejection', rejected);
  let altered;
  try {
    for (const mapper of [async () => { throw new Error('rejected mapper'); }, () => ({ title: 'Oversized', data: 'x'.repeat(16 * 1024) })]) {
      const flow = defineWorkflow({ args: {}, graph: ({ wait }) => ({ gate: wait({ mode: 'event', timeoutMs: 60_000, returns: s.string(), request: mapper }) }) });
      const definition = defineWorkflows(defineJobs({ schema: f.schema }).jobs(() => ({})), { invalid: flow });
      altered = openJobs(definition, { database: f.database, workflowWaits: policy });
      const run = altered.startWorkflow(flow, {});
      assert.equal(altered.getWorkflow(run.id).state, 'failed');
      assert.equal(altered.getWorkflowWait(run.id, 'gate'), null);
      altered.close(); altered = undefined;
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, []);
    assert.equal(f.database[internal].prepare('SELECT count(*) AS count FROM clank_workflow_waits').get().count, 0);
  } finally { process.off('unhandledRejection', rejected); altered?.close(); await f.close(); }
});
