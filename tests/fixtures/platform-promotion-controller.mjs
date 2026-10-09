// Owned child-process fixture for actual platform interruption/recovery tests.
import { openPlatform } from '../../dist/platform.js';
const platform = await openPlatform(JSON.parse(process.argv[2]));
process.on('message', message => {
  if (message.close) { void platform.close().then(() => process.exit(0), () => process.exit(1)); return; }
  void (async () => {
    const request = new Request(message.url, { method: message.method, headers: message.headers,
      ...(message.body === null ? {} : { body: Buffer.from(message.body, 'base64') }) });
    const response = await platform.handle(request);
    process.send({ id: message.id, status: response.status, headers: [...response.headers], body: await response.text() });
  })().catch(() => process.send({ id: message.id, error: true }));
});
process.send({ ready: true });
