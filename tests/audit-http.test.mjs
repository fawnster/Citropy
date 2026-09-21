import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { requestHandler } from '../server/http-handler.ts';

/** Start the production request boundary on a real, ephemeral loopback server. */
async function fixture(t, handler) {
  const server = createServer(requestHandler(handler));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return server.address().port;
}

/** Preserve the raw target; bound the wait and record interrupted response bodies. */
function exchange(port, path, method = 'GET', onData = () => {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; onData(); });
      res.on('error', () => {});
      res.once('close', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, headers: res.headers, body, complete: res.complete });
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('HTTP request did not finish')), 5000);
    req.once('error', error => { clearTimeout(timer); reject(error); });
    req.end();
  });
}

test('malformed targets receive 400 before routing and leave the server alive', async t => {
  let calls = 0;
  const port = await fixture(t, (_req, res) => { calls++; res.end('healthy'); });
  for (const path of ['//[', '//', 'http://[', '*', '/%', '/%E0%A4%A', '/%00', '/%5cfile', '/%2fhost', '/api/health#fragment']) {
    const result = await exchange(port, path);
    assert.equal(result.status, 400, path);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.complete, true);
  }
  assert.equal(calls, 0);
  assert.equal((await exchange(port, '/api/health')).body, 'healthy');
  assert.equal(calls, 1);
});

test('valid encoded paths and query strings reach routes unchanged', async t => {
  const port = await fixture(t, (req, res) => res.end(req.url));
  for (const path of ['/', '/api/health', '/assets/hello%20world.js', '/%E2%82%AC', '/api/preview?path=C%3A%5Cfile&query=%23%25']) {
    const result = await exchange(port, path);
    assert.equal(result.status, 200);
    assert.equal(result.body, path);
  }
});

for (const asynchronous of [false, true]) {
  test(`${asynchronous ? 'rejected promises' : 'synchronous throws'} return a generic 500 without killing the server`, async t => {
    const log = t.mock.method(console, 'error', () => {});
    const fail = () => { throw new Error('sensitive internal failure'); };
    const port = await fixture(t, (req, res) => {
      if (req.url === '/healthy') { res.end('healthy'); return; }
      return asynchronous ? Promise.resolve().then(fail) : fail();
    });
    const result = await exchange(port, '/fail');
    assert.equal(result.status, 500);
    assert.equal(result.complete, true);
    assert.deepEqual(JSON.parse(result.body), { error: 'Internal server error.' });
    assert.doesNotMatch(result.body, /sensitive/);
    assert.equal(log.mock.callCount(), 1);
    assert.equal((await exchange(port, '/healthy')).body, 'healthy');
  });
}

test('failure replaces stale content length, encoding, and cache headers', async t => {
  t.mock.method(console, 'error', () => {});
  const port = await fixture(t, (_req, res) => {
    res.setHeader('content-length', '9999');
    res.setHeader('content-encoding', 'gzip');
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    throw new Error('failed before sending headers');
  });
  const result = await exchange(port, '/fail');
  assert.equal(result.status, 500);
  assert.equal(result.complete, true);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['content-encoding'], undefined);
  assert.notEqual(result.headers['content-length'], '9999');
});

test('failure after headers closes the partial stream instead of hanging or rewriting headers', { timeout: 10000 }, async t => {
  t.mock.method(console, 'error', () => {});
  let received;
  const bodyReceived = new Promise(resolve => { received = resolve; });
  const port = await fixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-length': 100 });
    res.write('partial');
    await bodyReceived;
    throw new Error('stream failed');
  });
  const result = await exchange(port, '/stream', 'GET', received);
  assert.equal(result.status, 200);
  assert.equal(result.body, 'partial');
  assert.equal(result.complete, false);
});

test('a late rejection is logged without replacing an already-completed response', { timeout: 10000 }, async t => {
  let report;
  const reported = new Promise(resolve => { report = resolve; });
  t.mock.method(console, 'error', () => report());
  const port = await fixture(t, async (_req, res) => {
    res.end('finished');
    await delay(10);
    throw new Error('late failure');
  });
  assert.equal((await exchange(port, '/finished')).body, 'finished');
  await reported;
});
