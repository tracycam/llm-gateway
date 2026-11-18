import { expect, test } from 'bun:test';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const script = `import * as config from './gateway/config'; console.log(JSON.stringify(config));`;

async function config(env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: root,
    env: { PATH: process.env.PATH, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return JSON.parse(output);
}

test('gateway configuration defaults preserve existing paths', async () => {
  expect(await config({})).toEqual({
    PORT: 8000,
    LISTEN: '127.0.0.1',
    DATA_DIR: path.join(root, 'vol1/gateway'),
    LEGACY_DATA_DIR: path.join(root, 'vol1/apps/app-gateway'),
    WEB_DIST_DIR: path.join(root, 'web/dist'),
  });
});

test('gateway configuration reads overrides and legacy volume', async () => {
  expect(await config({
    AIHUB_GATEWAY_PORT: '9000', AIHUB_GATEWAY_LISTEN: '::1', AIHUB_VOL1_PATH: '/custom/vol',
    AIHUB_GATEWAY_DATA_DIR: '/custom/data', AIHUB_WEB_DIST_DIR: '/custom/web',
  })).toEqual({
    PORT: 9000, LISTEN: '::1', DATA_DIR: '/custom/data',
    LEGACY_DATA_DIR: '/custom/vol/apps/app-gateway', WEB_DIST_DIR: '/custom/web',
  });
  expect((await config({ AIHUB_VOL1_PATH: '/custom/vol' })).DATA_DIR).toBe('/custom/vol/gateway');
});
