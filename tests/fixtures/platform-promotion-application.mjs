import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const { label, stopWrite, stopBarrier } = JSON.parse(readFileSync(new URL('./fixture-config.json', import.meta.url), 'utf8'));
const db = new DatabaseSync(process.env.CLANK_DATABASE_PATH);
const server = createServer(async (request, response) => {
  if (request.url === '/healthz') {
    if (label === 'v2' && process.env.HEALTH_HOLD && existsSync(process.env.HEALTH_HOLD)) {
      writeFileSync(process.env.HEALTH_ENTERED, 'ready');
      while (existsSync(process.env.HEALTH_HOLD)) await new Promise(resolve => setTimeout(resolve, 10));
    }
    response.statusCode = process.env.FAIL_HEALTH === '1' && label === 'v2' ? 503 : 200;
    response.end('health');
    return;
  }
  if (request.url.startsWith('/write/')) db.prepare('UPDATE sample SET value=?').run(decodeURIComponent(request.url.slice(7)));
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ label, value: db.prepare('SELECT value FROM sample').get().value,
    secret: process.env.ENVIRONMENT_VALUE, bucketPrefix: process.env.CLANK_BUCKET_PREFIX }));
}).listen(Number(process.env.PORT), process.env.HOST);
if (stopWrite) process.on('SIGTERM', () => {
  db.prepare('UPDATE sample SET value=?').run(stopWrite);
  server.close(() => process.exit(0));
});
if (stopBarrier) process.on('SIGTERM', async () => {
  writeFileSync(stopBarrier.entered, 'stopping');
  while (existsSync(stopBarrier.hold)) await new Promise(resolve => setTimeout(resolve, 10));
  server.close(() => process.exit(0));
});
