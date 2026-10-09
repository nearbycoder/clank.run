import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const { label } = JSON.parse(readFileSync(new URL('./fixture-config.json', import.meta.url), 'utf8'));
const database = new DatabaseSync(process.env.CLANK_DATABASE_PATH);
if (label === 'v2' && process.env.HEALTH_WRITE === '1') database.prepare('UPDATE sample SET value=?').run('unpublished-health-write');
createServer((request, response) => {
  if (request.url === '/healthz') {
    response.statusCode = process.env.FAIL_HEALTH === '1' && label === 'v2' ? 503 : 200;
    response.end('health'); return;
  }
  if (request.url.startsWith('/write/')) database.prepare('UPDATE sample SET value=?').run(decodeURIComponent(request.url.slice(7)));
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ label, uid: process.getuid(), value: database.prepare('SELECT value FROM sample').get().value,
    secret: process.env.ENVIRONMENT_VALUE, bucketPrefix: process.env.CLANK_BUCKET_PREFIX }));
}).listen(Number(process.env.PORT), process.env.HOST);
