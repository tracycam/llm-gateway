import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { freePort, stopDaemon, tempDir } from '../server/testing/fixtures';

let child: ChildProcess;
let directory: string;
let base: string;
beforeAll(async () => {
  directory = tempDir();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // Nothing listens here, so control-plane lookups are refused at once instead of timing out.
  const closedPort = await freePort();
  child = spawn(process.execPath, ['run', 'gateway/main.ts'], {
    env: {
      ...process.env,
      AIHUB_GATEWAY_PORT: String(port),
      AIHUB_GATEWAY_DATA_DIR: directory,
      AIHUB_CONTROL_URL: `http://127.0.0.1:${closedPort}`,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch (error) {
      if (child.exitCode !== null) throw new Error(`Gateway exited: ${child.exitCode}`, { cause: error });
    }
    await Bun.sleep(50);
  }
  throw new Error('Gateway did not start');
});

test('standalone gateway answers healthz', async () => {
  const response = await fetch(`${base}/healthz`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'ok' });
});
afterAll(async () => {
  if (child) await stopDaemon(child);
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test('key creation reveals token once and authorizes models', async () => {
  const response = await fetch(`${base}/api/gateway/keys`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'integration' }) });
  expect(response.status).toBe(201);
  const created: { key: { id: string; token: string; prefix: string } } = await response.json();
  expect(created.key.token.startsWith('sk-gw-')).toBe(true);
  const state = await (await fetch(`${base}/api/gateway/state`)).text();
  expect(state).not.toContain(created.key.token);
  expect(state).toContain(created.key.prefix);
  expect((await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${created.key.token}` } })).status).toBe(200);
  expect((await fetch(`${base}/v1/models`)).status).toBe(401);
}, 20_000);

test('invalid key names and invalid JSON are rejected', async () => {
  for (const body of ['{"name":4}', 'null', '{']) {
    expect((await fetch(`${base}/api/gateway/keys`, { method: 'POST', body })).status).toBe(400);
  }
});
