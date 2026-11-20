import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveWebAsset } from './webAssets';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-assets-'));
const root = path.join(dir, 'dist');
fs.mkdirSync(root);
fs.writeFileSync(path.join(root, 'index.html'), 'gateway entry');
fs.writeFileSync(path.join(root, 'app.js'), 'script');
fs.writeFileSync(path.join(dir, 'secret'), 'secret');
// A sibling whose name starts with the directory's name.
fs.mkdirSync(path.join(dir, 'dist-private'));
fs.writeFileSync(path.join(dir, 'dist-private', 'secret'), 'secret');
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

test('serves an asset with its MIME type', async () => {
  const res = serveWebAsset('/app.js', 'index.html', root)!;
  expect(res.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
  expect(await res.text()).toBe('script');
});

test('unknown path falls back to the entry page', async () => {
  const res = serveWebAsset('/missing', 'index.html', root)!;
  expect(await res.text()).toBe('gateway entry');
});

test('a path that climbs out of the directory is not served', () => {
  for (const name of ['/../secret', '/%2e%2e/secret', '/..%2fsecret', '/%2e%2e%2fsecret', '/../dist-private/secret']) {
    expect(serveWebAsset(name, 'index.html', root)).toBeNull();
  }
});

test('missing directory returns null', () => {
  expect(serveWebAsset('/', 'index.html', path.join(dir, 'absent'))).toBeNull();
});

test('a path that is not valid percent-encoding is not served', () => {
  expect(serveWebAsset('/%E0%A4%A', 'index.html', root)).toBeNull();
});
