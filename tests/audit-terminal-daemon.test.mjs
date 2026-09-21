import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const token = 'test-only-daemon-token';
/** Launch the real daemon with a stub PTY host and platform-native local sockets. */
async function daemon(t) {
  const root = await mkdtemp(join(tmpdir(), 'citropy-daemon-'));
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\citropy-audit-${randomUUID()}` : join(root, 'service.sock');
  await mkdir(join(root, 'lock'));
  await writeFile(join(root, 'key'), token);
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  // Exercise the real socket/authentication implementation in a child process.
  // Only the native PTY dependency is replaced, so these tests require no GUI or node-pty.
  await copyFile(new URL('../server/terminal-daemon.ts', import.meta.url), join(root, 'terminal-daemon.ts'));
  await writeFile(join(root, 'terminal-host.ts'), `export class TerminalHost {
    list() { return []; }
    release() {}
    flow() {}
    async closeAll() {}
  }`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--experimental-strip-types', join(root, 'terminal-daemon.ts'), address, root], {
    env, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => stderr += chunk);
  const exited = new Promise(resolve => child.once('exit', resolve));
  const sockets = new Set();
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    await rm(root, { recursive: true, force: true });
  });
  const connect = () => new Promise((resolve, reject) => {
    const socket = createConnection(address);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.once('error', reject);
    socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket); });
  });
  const deadline = Date.now() + 10000;
  while (true) {
    if (child.exitCode !== null) throw new Error(`Daemon exited: ${stderr}`);
    try { const socket = await connect(); socket.destroy(); break; }
    catch (error) { if (Date.now() >= deadline) throw error; await delay(20); }
  }
  return { connect, child, stderr: () => stderr };
}

/** Send a protocol envelope and await one JSON reply with bounded wait and listener cleanup. */
function reply(socket, payload) {
  return new Promise((resolve, reject) => {
    let input = '';
    const timer = setTimeout(() => finish(new Error('daemon response timed out')), 5000);
    const onData = chunk => {
      input += chunk;
      const end = input.indexOf('\n');
      if (end >= 0) {
        try { finish(null, JSON.parse(input.slice(0, end))); }
        catch (error) { finish(error); }
      }
    };
    const onClose = () => finish(new Error('daemon closed before replying'));
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      if (error) reject(error); else resolve(value);
    };
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.write(JSON.stringify(payload) + '\n');
  });
}

/** Verify that sending an invalid raw protocol line causes the client to be disconnected. */
async function rejected(socket, raw) {
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('malformed request was not disconnected')); }, 5000);
    socket.once('close', () => { clearTimeout(timer); resolve(); });
  });
  socket.write(raw + '\n');
  await closed;
}

/** Confirm a fresh authenticated connection succeeds and the daemon process remains alive. */
async function alive(instance) {
  const socket = await instance.connect();
  assert.deepEqual(await reply(socket, { id: 'hello', op: 'hello', version: 1, token }), { id: 'hello', result: [] });
  socket.destroy();
  assert.equal(instance.child.exitCode, null, instance.stderr());
}

test('JSON null before authentication cannot crash the terminal daemon', { timeout: 20000 }, async t => {
  const instance = await daemon(t);
  await rejected(await instance.connect(), 'null');
  await alive(instance);
});

test('malformed authenticated messages disconnect only their own client', { timeout: 20000 }, async t => {
  const instance = await daemon(t);
  for (const raw of ['null', '[]', '"text"', '42', 'true', '{broken']) {
    const socket = await instance.connect();
    await reply(socket, { id: 1, op: 'hello', version: 1, token });
    await rejected(socket, raw);
    await alive(instance);
  }
});

test('authentication and operation errors remain isolated and recoverable', { timeout: 20000 }, async t => {
  const instance = await daemon(t);
  await rejected(await instance.connect(), JSON.stringify({ op: 'hello', version: 1, token: 'wrong' }));
  const socket = await instance.connect();
  await reply(socket, { id: 1, op: 'hello', version: 1, token });
  const result = await reply(socket, { id: 2, op: 'unsupported' });
  assert.equal(result.id, 2);
  assert.match(result.error, /Unsupported/);
  assert.deepEqual(await reply(socket, { id: 3, op: 'list' }), { id: 3, result: [] });
  socket.destroy();
  await alive(instance);
});
