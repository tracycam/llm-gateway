import { expect, test } from 'bun:test';
import path from 'node:path';

const gatewayDir = path.resolve(import.meta.dir);
const script = `import * as config from './config'; console.log(JSON.stringify(config));`;

function spawnConfig(env: Record<string, string>) {
  return Bun.spawn([process.execPath, '-e', script], {
    cwd: gatewayDir,
    env: { PATH: process.env.PATH, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function config(env: Record<string, string>): Promise<Record<string, unknown>> {
  const child = spawnConfig(env);
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return JSON.parse(output);
}

test('a gateway on its own needs no configuration', async () => {
  const values = await config({});
  expect(values).toEqual({
    PORT: 8000,
    LISTEN: '127.0.0.1',
    DATA_DIR: path.join(gatewayDir, 'data'),
    WEB_DIST_DIR: path.join(gatewayDir, 'web/dist'),
    LEGACY_DATA_DIR: null,
  });
  expect(values.ADMIN_TOKEN).toBeUndefined();
});

test('the neutral names are read', async () => {
  expect(await config({
    PORT: '9000', LISTEN: '::1', ADMIN_TOKEN: 'administrator-token-123456',
    DATA_DIR: '/custom/data', WEB_DIST_DIR: '/custom/web',
  })).toEqual({
    PORT: 9000, LISTEN: '::1', ADMIN_TOKEN: 'administrator-token-123456',
    DATA_DIR: '/custom/data', WEB_DIST_DIR: '/custom/web', LEGACY_DATA_DIR: null,
  });
});

test('the names the gateway had inside a daemon are still read', async () => {
  expect(await config({
    AIHUB_GATEWAY_PORT: '9001', AIHUB_GATEWAY_LISTEN: 'localhost',
    AIHUB_ADMIN_TOKEN: 'legacy-administrator-123456',
    AIHUB_GATEWAY_DATA_DIR: '/legacy/data', AIHUB_WEB_DIST_DIR: '/legacy/web',
  })).toEqual({
    PORT: 9001, LISTEN: 'localhost', ADMIN_TOKEN: 'legacy-administrator-123456',
    DATA_DIR: '/legacy/data', WEB_DIST_DIR: '/legacy/web', LEGACY_DATA_DIR: null,
  });
});

test('the neutral name wins when both are set', async () => {
  expect(await config({
    PORT: '9000', AIHUB_GATEWAY_PORT: '9001',
    LISTEN: '127.0.0.2', AIHUB_GATEWAY_LISTEN: '127.0.0.3',
    ADMIN_TOKEN: 'neutral-administrator-123456', AIHUB_ADMIN_TOKEN: 'legacy-administrator-123456',
    DATA_DIR: '/neutral/data', AIHUB_GATEWAY_DATA_DIR: '/legacy/data',
    WEB_DIST_DIR: '/neutral/web', AIHUB_WEB_DIST_DIR: '/legacy/web',
  })).toMatchObject({
    PORT: 9000, LISTEN: '127.0.0.2', ADMIN_TOKEN: 'neutral-administrator-123456',
    DATA_DIR: '/neutral/data', WEB_DIST_DIR: '/neutral/web',
  });
});

test("a daemon volume places the data inside it and names the retired directory", async () => {
  expect(await config({ AIHUB_VOL1_PATH: '/custom/vol' })).toEqual({
    PORT: 8000,
    LISTEN: '127.0.0.1',
    DATA_DIR: '/custom/vol/gateway',
    WEB_DIST_DIR: path.join(gatewayDir, 'web/dist'),
    LEGACY_DATA_DIR: '/custom/vol/apps/app-gateway',
  });
  expect((await config({ AIHUB_VOL1_PATH: '/custom/vol', DATA_DIR: '/custom/data' })).DATA_DIR)
    .toBe('/custom/data');
});

test('a port that is not an integer in 1-65535 stops the gateway with the reason', async () => {
  for (const value of ['0', '65536', '8000.5', 'eighty', '', '8000abc']) {
    const child = spawnConfig({ PORT: value });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('PORT must be an integer between 1 and 65535');
  }
});
