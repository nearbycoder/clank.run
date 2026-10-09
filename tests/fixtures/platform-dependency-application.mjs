import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.CLANK_DATABASE_PATH);
createServer(async (request, response) => {
  if (request.url === '/healthz') {
    const file = process.env.DEPENDENCY_HEALTH_FILE;
    const policy = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    const count = policy.countFile ? (existsSync(policy.countFile) ? Number(readFileSync(policy.countFile, 'utf8')) : 0) + 1 : 1;
    if (policy.countFile) writeFileSync(policy.countFile, String(count));
    if (count >= (policy.waitOnCall ?? 1)) {
      if (policy.entered) writeFileSync(policy.entered, 'health-check-entered');
      while (policy.hold && existsSync(policy.hold)) await new Promise(resolve => setTimeout(resolve, 10));
    }
    response.statusCode = policy.status ?? 200;
    if (policy.redirect) { response.statusCode = 302; response.setHeader('location', policy.redirect); }
    response.end('private-application-health-payload');
    return;
  }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ value: db.prepare('SELECT value FROM sample').get().value }));
}).listen(Number(process.env.PORT), process.env.HOST);
