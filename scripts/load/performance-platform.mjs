// Disposable dashboard microbenchmark. No network listener or existing database is used.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isDashboardQuotaRead(sql) {
  return /FROM clank_platform_(?:quota_overrides|billing_accounts)\b/u.test(sql)
    || /SELECT created_by FROM clank_platform_organizations WHERE id = \?/u.test(sql);
}

export async function dashboardFixture(openPlatform, { projects = 10, metricBuckets = 0, securityPolicy = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clank-dashboard-performance-'));
  const origin = 'http://127.0.0.1:4200';
  const runtime = await openPlatform({ dataDirectory: directory, publicUrl: origin, signup: true,
    backups: { intervalMs: false }, ingress: { domainRecheckIntervalMs: false },
    ...(securityPolicy ? { organizationSecurity: { operatorRecovery: true } } : {}) });
  const database = new DatabaseSync(join(directory, 'control.sqlite'));
  try {
    const response = await runtime.handle(new Request(`${origin}/__clank/auth/register`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dashboard-benchmark@example.invalid', password: 'synthetic-benchmark-password' }),
    }));
    assert.equal(response.status, 201);
    const { user } = await response.json();
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const now = Date.now(), organizationId = 'dashboard-workspace';
    database.prepare(`INSERT INTO clank_platform_organizations (id,name,slug,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?)`).run(organizationId, organizationId, organizationId, user.id, now, now);
    database.prepare('INSERT INTO clank_platform_memberships VALUES (?,?,?,?,?)').run(organizationId, user.id, 'owner', now, now);
    const insert = database.prepare(`INSERT INTO clank_platform_projects
      (id,owner_id,organization_id,name,slug,port,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
    const metric = database.prepare(`INSERT INTO clank_platform_metrics
      (project_id,bucket_started_at,request_count,status_2xx,duration_sum_ms,duration_max_ms,latency_inf,response_bytes,method_get)
      VALUES (?,?,60,60,6000,250,60,60000,60)`);
    database.exec('BEGIN');
    for (let index = 0; index < projects; index++) {
      const id = `dashboard-project-${index}`;
      insert.run(id, user.id, organizationId, id, id, 12000 + index, now, now);
      for (let bucket = 0; bucket < metricBuckets; bucket++) {
        metric.run(id, Math.floor(now / 60000) * 60000 - bucket * 60000);
      }
    }
    database.exec('COMMIT');
    if (securityPolicy) {
      // Synthetic policy data, like the projects and metrics above. Requests
      // still pass through the native session, membership and policy controller.
      database.prepare(`INSERT INTO clank_organization_security_policies
        (organization_id,version,requirements,updated_at,factor_at,sso_at) VALUES (?,1,?,?,NULL,NULL)`)
        .run(organizationId, JSON.stringify({ factor: 'none', ssoOnly: false,
          sessionMaxAgeMs: 3600000, enrollmentGraceMs: 0 }), now);
    }
    return {
      runtime, database, user, cookie, organizationId, metricTime: now,
      async read(endpoint = 'dashboard') {
        const response = await runtime.handle(new Request(`${origin}/api/${endpoint}`, { headers: { cookie } }));
        assert.equal(response.status, 200);
        return response.json();
      },
      async close() {
        database.close();
        await runtime.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    database.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
    const match = /^--([a-zA-Z]+)=(.+)$/u.exec(argument);
    if (!match) throw new Error(`Invalid option: ${argument}`);
    return [match[1], match[2]];
  }));
  if (Object.keys(options).some((key) => !['dist', 'projects', 'metricBuckets', 'iterations', 'warmup', 'endpoint', 'securityPolicy'].includes(key))) {
    throw new Error('Expected --dist, --projects, --metricBuckets, --iterations, --warmup, --endpoint, or --securityPolicy.');
  }
  const endpoint = options.endpoint ?? 'dashboard';
  if (!['dashboard', 'projects'].includes(endpoint)) throw new Error('Invalid endpoint.');
  if (options.securityPolicy !== undefined && !['true', 'false'].includes(options.securityPolicy)) throw new Error('Invalid securityPolicy.');
  const securityPolicy = options.securityPolicy === 'true';
  const bounded = (key, fallback, minimum, maximum) => {
    const value = Number(options[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${key}.`);
    return value;
  };
  const projects = bounded('projects', 10, 1, 500);
  const metricBuckets = bounded('metricBuckets', 0, 0, 1440);
  const iterations = bounded('iterations', 500, 1, 10000);
  const warmup = bounded('warmup', 50, 0, 1000);
  const dist = resolve(options.dist ?? 'dist');
  const { openPlatform } = await import(pathToFileURL(join(dist, 'platform.js')));
  const fixture = await dashboardFixture(openPlatform, { projects, metricBuckets, securityPolicy });
  const read = () => fixture.read(endpoint);
  const check = value => {
    assert.equal(value.projects.length, projects);
    if (endpoint === 'dashboard') assert.equal(value.totals.requests, projects * metricBuckets * 60);
  };
  // Keep the synthetic 24-hour window stable when a trial crosses a minute.
  // Timings use performance.now()/cpuUsage(), which remain real clocks.
  const wallClock = Date.now;
  Date.now = () => fixture.metricTime;
  try {
    // Count work on one request only; instrumentation is removed before timing.
    const prototype = Object.getPrototypeOf(fixture.database.prepare('SELECT 1'));
    const originals = { all: prototype.all, get: prototype.get };
    let quotaReads = 0, totalReads = 0;
    for (const [name, original] of Object.entries(originals)) prototype[name] = function (...parameters) {
      totalReads++;
      if (isDashboardQuotaRead(this.sourceSQL)) quotaReads++;
      return original.apply(this, parameters);
    };
    let sample;
    try { sample = await read(); }
    finally { Object.assign(prototype, originals); }
    check(sample);
    for (let index = 0; index < warmup; index++) await read();
    const durations = [], cpu = process.cpuUsage(), started = performance.now();
    for (let index = 0; index < iterations; index++) {
      const before = performance.now();
      const value = await read();
      check(value);
      durations.push(performance.now() - before);
    }
    const elapsedMs = performance.now() - started, used = process.cpuUsage(cpu);
    durations.sort((left, right) => left - right);
    const percentile = (fraction) => durations[Math.min(durations.length - 1, Math.floor(fraction * durations.length))];
    console.log(JSON.stringify({ dist, node: process.version, endpoint, securityPolicy, projects, metricBuckets, iterations, warmup,
      quotaReadsPerRequest: quotaReads, totalReadsPerRequest: totalReads, elapsedMs,
      cpuMs: (used.user + used.system) / 1000, p50Ms: percentile(0.5), p95Ms: percentile(0.95),
      rssBytes: process.memoryUsage().rss }, null, 2));
  } finally {
    Date.now = wallClock;
    await fixture.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
