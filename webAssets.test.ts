import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assetPath, diskWebAssets, embeddedWebAssets, serveWebAsset } from './webAssets';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-assets-'));
const root = path.join(dir, 'dist');
fs.mkdirSync(root);
fs.mkdirSync(path.join(root, 'assets'));
fs.writeFileSync(path.join(root, 'index.html'), 'gateway entry');
fs.writeFileSync(path.join(root, 'app.js'), 'script');
fs.writeFileSync(path.join(root, 'assets', 'index-abc.js'), 'asset');
fs.writeFileSync(path.join(dir, 'secret'), 'secret');
// A sibling whose name starts with the directory's name.
fs.mkdirSync(path.join(dir, 'dist-private'));
fs.writeFileSync(path.join(dir, 'dist-private', 'secret'), 'secret');
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const assets = diskWebAssets(root);

test('serves an asset with its MIME type', async () => {
  const res = serveWebAsset('/app.js', 'index.html', assets)!;
  expect(res.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
  expect(await res.text()).toBe('script');
});

test('unknown path falls back to the entry page', async () => {
  const res = serveWebAsset('/missing', 'index.html', assets)!;
  expect(await res.text()).toBe('gateway entry');
});

test('a directory path falls back to the entry page', async () => {
  const res = serveWebAsset('/assets/', 'index.html', assets)!;
  expect(await res.text()).toBe('gateway entry');
});

test('a path that climbs out of the directory is not served', () => {
  for (const name of [
    '/../secret', '/%2e%2e/secret', '/..%2fsecret', '/%2e%2e%2fsecret',
    '/../dist-private/secret', '/assets/../../secret',
  ]) {
    expect(serveWebAsset(name, 'index.html', assets)).toBeNull();
  }
});

test('backslashes are separators and cannot climb out either', () => {
  for (const name of ['/..\\secret', '/%2e%2e%5csecret', '/assets\\..\\..\\secret']) {
    expect(serveWebAsset(name, 'index.html', assets)).toBeNull();
  }
  expect(assetPath('/assets\\index-abc.js', 'index.html')).toBe('assets/index-abc.js');
  // It normalizes back inside the console, where that name does not exist: the entry page.
  expect(assetPath('/assets%5c..%5csecret', 'index.html')).toBe('secret');
});

test('a Windows drive or alternate stream segment names no console file', () => {
  for (const name of ['/C:/secret', '/app.js:stream', '/a%00b']) {
    expect(serveWebAsset(name, 'index.html', assets)).toBeNull();
  }
});

test('missing directory returns null', () => {
  expect(serveWebAsset('/', 'index.html', diskWebAssets(path.join(dir, 'absent')))).toBeNull();
});

test('a path that is not valid percent-encoding is not served', () => {
  expect(serveWebAsset('/%E0%A4%A', 'index.html', assets)).toBeNull();
});

test('embedded files keep their path below the console prefix', async () => {
  const embedded = embeddedWebAssets([
    new File(['gateway entry'], 'index.html'),
    new File(['script'], 'assets/index-abc.js'),
  ]);
  const index = serveWebAsset('/models', 'index.html', embedded)!;
  expect(await index.text()).toBe('gateway entry');
  const js = serveWebAsset('/assets/index-abc.js', 'index.html', embedded)!;
  expect(js.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
  expect(await js.text()).toBe('script');
});

test('a whole-tree asset keeps only the files below the console prefix', () => {
  const embedded = embeddedWebAssets([
    new File(['gateway entry'], 'web/dist/index.html'),
    new File(['not the console'], 'other/file.txt'),
  ], 'web/dist');
  expect(embedded.file('index.html')).not.toBeNull();
  expect(embedded.file('other/file.txt')).toBeNull();
});
