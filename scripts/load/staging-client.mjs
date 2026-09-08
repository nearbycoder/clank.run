import { readFile } from 'node:fs/promises';
import { request, Agent } from 'node:https';
const agent = new Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 2 });
export async function connectStaging(path, name) {
  const config = JSON.parse(await readFile(path, 'utf8')),
    target = new URL(config.url);
  if (
    target.protocol !== 'https:' ||
    !target.hostname.endsWith('.up.railway.app') ||
    target.pathname !== '/' ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    !/^[a-f0-9]{64}$/.test(config.token ?? '') ||
    !['app', 'platform', 'baseline'].includes(name)
  )
    throw Error('Invalid isolated Railway staging configuration');
  const headers = { authorization: `Bearer ${config.token}` };
  async function rpc(command) {
    return new Promise((resolve, reject) => {
      const req = request(
        new URL(`/control/${name}/${command}`, target),
        {
          method: command === 'ready' ? 'GET' : 'POST',
          headers,
          agent,
        },
        (response) => {
          const chunks = [];
          let bytes = 0;
          response.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > 4 * 1024 * 1024) req.destroy(Error('Oversized control response'));
            else chunks.push(chunk);
          });
          response.on('end', () => {
            if (response.statusCode !== 200) {
              reject(Error(`Staging ${command}: ${response.statusCode}`));
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString()));
            } catch (error) {
              reject(error);
            }
          });
          response.on('error', reject);
        },
      );
      const deadline = setTimeout(() => req.destroy(Error(`Staging ${command} deadline`)), 180000);
      req.on('close', () => clearTimeout(deadline));
      req.on('error', reject);
      req.end();
    });
  }
  const ready = await rpc('ready');
  if (ready.protocol !== 'clank-capacity-staging/1')
    throw Error('Target is not the synthetic staging fixture');
  return {
    ...ready,
    remote: true,
    url: new URL('/' + name, target).href,
    headers,
    rpc,
    async close() {},
  };
}
