import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { defineDatabase, defineJobs, defineTable, defineWorkflow, defineWorkflows, openJobs, openSQLite, s } from '../../dist/index.js';

export function waitDefinition(schema, mode = 'event', timeoutMs = 60_000) {
  const jobs = defineJobs({ schema }).jobs(({ job }) => ({
    save: job({ args: { value: s.string() }, returns: s.string(), handler: ({ db }, { value }) => {
      db.transaction(tx => tx.table('events').insert({ value })); return value;
    } }),
  }));
  const workflow = defineWorkflow({ args: { label: s.string() }, graph: ({ wait, step }) => {
    const gate = wait({ mode, timeoutMs, returns: s.object({ value: s.string() }), request: ({ input }) => ({ title: input.label, data: { kind: mode } }) });
    const save = step(jobs.jobs.save, { needs: [gate], args: ctx => ({ value: ctx.result(gate).value }) });
    return { gate, save };
  }, returns: s.string(), output: ({ results }) => results.save });
  return { definition: defineWorkflows(jobs, { flow: workflow }), workflow };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const schema = defineDatabase({ events: defineTable({ value: s.string() }) });
  const { definition } = waitDefinition(schema);
  const database = await openSQLite(schema, { path: process.argv[2], changePollIntervalMs: 0 });
  let clock = Date.now();
  const runtime = openJobs(definition, { database, now: () => clock,
    workflowWaits: { signingKey: 'workflow-test-secret-is-long-enough-01', policyRevision: 1 } });
  const server = createServer(async (request, response) => {
    // An explicitly authenticated numeric-loopback fixture adapter, not a framework endpoint.
    if (request.headers.authorization !== 'Bearer workflow-fixture-adapter') { response.writeHead(401).end(); return; }
    try {
      const parts = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 8192) throw new Error('Fixture request too large.'); parts.push(chunk); }
      const input = JSON.parse(Buffer.concat(parts).toString());
      if (input.clock !== undefined) { if (!Number.isSafeInteger(input.clock)) throw new Error('Invalid fixture clock.'); clock = input.clock; }
      else clock = Date.now();
      let output;
      if (request.url === '/resume') {
        output = runtime.resumeWorkflowWait(input.submission);
        if (input.hold) { process.send?.({ committed: output.waitId }); return; }
      } else if (request.url === '/cancel') output = runtime.cancelWorkflow(input.workflowId);
      else if (request.url === '/tick') output = runtime.advanceWorkflows();
      else { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(output));
    } catch (error) { response.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ code: error.code ?? 'FIXTURE_ERROR', message: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.send?.({ port: server.address().port });
  process.once('SIGTERM', () => server.close(() => { runtime.close(); database.close(); process.exit(0); }));
}
