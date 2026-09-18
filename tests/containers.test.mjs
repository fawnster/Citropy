import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SshEnvironments } from "../desktop/ssh.mjs";
import { validateContainer } from "../desktop/containers.mjs";

test("container connections keep workspace data and apply the same project defaults", async t => {
  const root = await mkdtemp(join(tmpdir(), "citropy-container-test-"));
  const workspace = join(root, "folder with spaces");
  await mkdir(workspace);
  const calls = [];
  let container;
  let token;
  let build;
  let defaults;
  const server = createServer(async (req, res) => {
    if (req.headers["x-citropy-remote-token"] !== token) { res.writeHead(401).end(); return; }
    if (req.url === "/api/projects/defaults") {
      let body = "";
      for await (const chunk of req) body += chunk;
      defaults = JSON.parse(body).settings;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(defaults));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ environmentId: connection.id, protocol: 1, build }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const manager = new SshEnvironments({ directory: root, appRoot: root, origin: "http://127.0.0.1:4177", projectDefaults: async settings => settings ?? { permissionMode: "plan", autoPull: true } });
  t.after(async () => { await manager.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  manager.bundle = async () => ({ build: "a".repeat(64), archive: Buffer.from("") });
  manager.command = async (command, args) => {
    assert.equal(command, "docker");
    calls.push(args);
    if (args[0] === "info") return "linux";
    if (args[0] === "container") return container ? "container-id" : "";
    if (args[0] === "image") return "cached-image";
    if (args[0] === "inspect") return JSON.stringify([container]);
    if (args[0] === "create") {
      const env = await readFile(args[args.indexOf("--env-file") + 1], "utf8");
      token = /^CITROPY_REMOTE_TOKEN=(.*)$/m.exec(env)[1];
      build = /^CITROPY_REMOTE_BUILD=(.*)$/m.exec(env)[1];
      container = { State: { Running: false }, Config: { Labels: { "app.citropy.environment": connection.id, "app.citropy.build": build } }, NetworkSettings: { Ports: { "4177/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }] } } };
    }
    if (args[0] === "start") container.State.Running = true;
    if (args[0] === "stop") container.State.Running = false;
    if (args[0] === "rm") { assert.equal(container.State.Running, false); container = undefined; }
    return "";
  };
  assert.throws(() => validateContainer({ name: "Invalid", target: "/tmp/folder,readonly" }), /without commas/);
  const connection = await manager.save({ kind: "container", name: "Container", target: workspace });
  const state = await manager.connect(connection.id);
  assert.equal(state.activeId, connection.id);
  assert.equal(state.connections[0].status, "connected");
  assert.deepEqual(defaults, { permissionMode: "plan", autoPull: true });
  assert.equal(JSON.stringify(state).includes(token), false);
  const create = calls.find(args => args[0] === "create");
  assert.ok(create.includes(`type=bind,source=${workspace},target=/workspace`));
  assert.equal(create[create.indexOf("--publish") + 1], "127.0.0.1::4177");
  assert.equal(create.includes("--privileged"), false);
  assert.equal(create.some(arg => arg.includes("docker.sock")), false);
  assert.equal((await stat(join(root, "containers", connection.id, "runtime.env"))).mode & 0o777, 0o600);
  await manager.disconnect(connection.id);
  assert.equal(container.State.Running, true);
  assert.equal((await fetch(`${state.endpoint}/api/health`, { headers: { origin: manager.origin } })).status, 503);
  await manager.connect(connection.id);
  assert.equal(calls.filter(args => args[0] === "create").length, 1);
  manager.bundle = async () => ({ build: "b".repeat(64), archive: Buffer.from("") });
  await manager.disconnect(connection.id);
  assert.match((await manager.connect(connection.id)).connections[0].message, /Stop this container/);
  await manager.stop(connection.id);
  assert.equal(container.State.Running, false);
  await manager.connect(connection.id);
  assert.equal(calls.filter(args => args[0] === "create").length, 2);
  await manager.local();
  await manager.remove(connection.id);
  assert.equal(container.State.Running, false);
  assert.equal(manager.connections.length, 0);
  assert.equal((await stat(workspace)).isDirectory(), true);
});

test("a failed container launch leaves the local environment active and reports setup guidance", async t => {
  const root = await mkdtemp(join(tmpdir(), "citropy-container-unavailable-"));
  const manager = new SshEnvironments({ directory: root, appRoot: root, origin: "http://127.0.0.1:4177" });
  t.after(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }); });
  manager.command = async () => { throw new Error("Docker daemon is unavailable"); };
  const connection = await manager.save({ kind: "container", name: "Container", target: root });
  await assert.rejects(manager.connect(connection.id), /Start Docker Engine or Docker Desktop/);
  assert.equal(manager.activeId, "local");
  assert.equal(manager.state().connections[0].status, "error");
});
