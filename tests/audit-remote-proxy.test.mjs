import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request } from 'node:http';
import { remoteProxy } from '../desktop/remote-proxy.mjs';

const origin = 'http://127.0.0.1:4177';
/** Connect a real loopback proxy to a controlled backend and register teardown. */
async function fixture(t, handler) {
  const backend = createServer(handler);
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const proxy = await remoteProxy(origin);
  proxy.setTarget({ port: backend.address().port, remotePort: 4177, token: 'test-only-token' });
  t.after(async () => {
    await proxy.close();
    backend.closeAllConnections();
    await new Promise(resolve => backend.close(resolve));
  });
  return proxy;
}

/** Capture response completion or interruption, failing promptly if the proxy hangs. */
function exchange(endpoint, path, headers = {}, onData = () => {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const req = request(`${endpoint}${path}`, { headers: { origin, ...headers }, agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; onData(); });
      res.on('error', () => {});
      res.on('close', () => { clearTimeout(timer); resolve({ status: res.statusCode, complete: res.complete, body, headers: res.headers }); });
    });
    req.on('error', error => { clearTimeout(timer); reject(error); });
    timer = setTimeout(() => { req.destroy(); reject(new Error('proxy left a truncated response hanging')); }, 5000);
    req.end();
  });
}

test('a truncated upstream HTTP response closes downstream instead of hanging', async t => {
  let response;
  const proxy = await fixture(t, (_req, res) => {
    response = res;
    res.writeHead(200, { 'content-length': '100' });
    res.write('partial');
  });
  const result = await exchange(proxy.endpoint, '/api/preview', {}, () => response.destroy());
  assert.equal(result.complete, false);
});

test('successful proxy responses preserve data but strip cookies', async t => {
  const proxy = await fixture(t, (req, res) => {
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers['x-citropy-remote-token'], 'test-only-token');
    assert.equal(req.headers.host, '127.0.0.1:4177');
    res.writeHead(200, { 'set-cookie': 'remote-secret=1' });
    res.end('ok');
  });
  const result = await exchange(proxy.endpoint, '/api/health', { cookie: 'local-secret=1' });
  assert.equal(result.status, 200);
  assert.equal(result.complete, true);
  assert.equal(result.body, 'ok');
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(result.headers['access-control-allow-origin'], origin);
});

test('proxy origin and privileged-route restrictions remain enforced', async t => {
  const proxy = await fixture(t, (_req, res) => res.end('unexpected'));
  assert.equal((await exchange(proxy.endpoint, '/api/health', { origin: 'https://untrusted.invalid' })).status, 403);
  for (const path of ['/api/remote/shutdown', '/api/desktop', '/api/updates/prepare', '/']) {
    assert.equal((await exchange(proxy.endpoint, path)).status, 404);
  }
  proxy.setTarget(undefined);
  assert.equal((await exchange(proxy.endpoint, '/api/health')).status, 503);
});
