import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveStatic } from '../server/static.ts';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'citropy-static-'));
  const root = join(directory, 'dist');
  await mkdir(join(root, 'assets'), { recursive: true });
  await mkdir(join(root, 'fonts'));
  await writeFile(join(root, 'index.html'), '<html>Citropy</html>');
  await writeFile(join(root, 'assets', 'app-abc123.js'), 'console.log("Citropy");');
  await writeFile(join(root, 'fonts', 'font.woff2'), 'font');
  await writeFile(join(directory, 'private.txt'), 'not public');
  const thrown = [];
  const server = createServer((req, res) => {
    try {
      if (!serveStatic(root, req.url, res)) res.writeHead(404).end('not found');
    } catch (error) {
      thrown.push(error);
      res.writeHead(500).end('unexpected throw');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const get = (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end();
  });
  return { get, root, directory, thrown };
}

test('malformed URL encoding is a 400, not an uncaught exception', async t => {
  const { get, thrown } = await fixture(t);
  for (const path of ['/%', '/%FF', '/%E0%A4%A', '/%00']) {
    const result = await get(path);
    assert.equal(result.status, 400, path);
    assert.equal(result.headers['cache-control'], 'no-store');
  }
  assert.deepEqual(thrown, []);
  assert.equal((await get('/')).status, 200);
});

test('missing static resources and API routes never fall back to cached HTML', async t => {
  const { get } = await fixture(t);
  for (const path of ['/assets/missing.js', '/assets/missing', '/fonts/missing.woff2', '/missing.css', '/api/unknown', '/api', '/socket', '/mcp/unknown']) {
    const result = await get(path);
    assert.equal(result.status, 404, path);
    assert.doesNotMatch(result.body, /<html>/);
    assert.doesNotMatch(result.headers['cache-control'] || '', /immutable/);
  }
});

test('SPA navigation is revalidated and real build assets are immutable', async t => {
  const { get } = await fixture(t);
  for (const path of ['/', '/conversation/example?query=%ZZ']) {
    const result = await get(path);
    assert.equal(result.status, 200);
    assert.equal(result.body, '<html>Citropy</html>');
    assert.equal(result.headers['cache-control'], 'no-cache');
  }
  for (const path of ['/assets/app-abc123.js', '/assets/./app-abc123.js', '/%61ssets/app-abc123.js']) {
    const result = await get(path);
    assert.equal(result.status, 200);
    assert.match(result.headers['content-type'], /javascript/);
    assert.match(result.headers['cache-control'], /immutable/);
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
  }
  assert.equal((await get('/assets/../index.html')).headers['cache-control'], 'no-cache');
});

test('HEAD has GET metadata without a body and static POST is rejected', async t => {
  const { get } = await fixture(t);
  const normal = await get('/assets/app-abc123.js');
  const head = await get('/assets/app-abc123.js', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(Number(head.headers['content-length']), Buffer.byteLength(normal.body));
  assert.equal(head.headers['content-type'], normal.headers['content-type']);
  const post = await get('/', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});

test('URL traversal and Windows separators cannot escape the static root', async t => {
  const { get } = await fixture(t);
  for (const path of ['/../private.txt', '/%2e%2e/private.txt', '/..%5cprivate.txt', '//private.txt']) {
    const result = await get(path);
    assert.ok([400, 403, 404].includes(result.status), `${path}: ${result.status}`);
    assert.doesNotMatch(result.body, /not public/);
  }
});

test('a symlink cannot publish a file outside the static root', async t => {
  const { get, root, directory } = await fixture(t);
  try { await symlink(join(directory, 'private.txt'), join(root, 'leak.txt'), 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('This Windows account cannot create file symlinks'); return; }
    throw error;
  }
  const result = await get('/leak.txt');
  assert.equal(result.status, 404);
  assert.doesNotMatch(result.body, /not public/);
});

test('a directory named index.html is not streamed as a file', async t => {
  const { get, root, thrown } = await fixture(t);
  await rm(join(root, 'index.html'));
  await mkdir(join(root, 'index.html'));
  assert.equal((await get('/')).status, 404);
  assert.deepEqual(thrown, []);
});
