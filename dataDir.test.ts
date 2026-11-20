import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './testing/fixtures';
import { defaultDataDir, migrateGatewayDataDir } from './dataDir';

let dir: string;
let oldDir: string;
let newDir: string;
beforeEach(() => {
  dir = tempDir();
  oldDir = path.join(dir, 'apps', 'app-gateway');
  newDir = path.join(dir, 'gateway');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('old gateway data is moved when the new directory is missing', () => {
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'database'), 'data');
  migrateGatewayDataDir(newDir, oldDir);
  expect(fs.readFileSync(path.join(newDir, 'database'), 'utf8')).toBe('data');
  expect(fs.existsSync(oldDir)).toBe(false);
});

test('existing new directory leaves old gateway data untouched', () => {
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir);
  migrateGatewayDataDir(newDir, oldDir);
  expect(fs.existsSync(oldDir)).toBe(true);
});

test('missing old and new gateway directories create nothing', () => {
  migrateGatewayDataDir(newDir, oldDir);
  expect(fs.readdirSync(dir)).toEqual([]);
});

test('failed data directory rename propagates the error', () => {
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'database'), 'data');
  expect(() => migrateGatewayDataDir(path.join(oldDir, 'nested'), oldDir)).toThrow();
  expect(fs.readFileSync(path.join(oldDir, 'database'), 'utf8')).toBe('data');
});

function dirOf(overrides: Partial<Parameters<typeof defaultDataDir>[0]>) {
  return defaultDataDir({
    standalone: true,
    platform: 'linux',
    env: {},
    home: '/home/user',
    gatewayDir: '/src/gateway',
    ...overrides,
  });
}

test('a source checkout keeps its data beside the sources', () => {
  expect(dirOf({ standalone: false })).toBe(path.join('/src/gateway', 'data'));
  expect(dirOf({ standalone: false, platform: 'win32', env: { LOCALAPPDATA: 'C:\\Local' } }))
    .toBe(path.join('/src/gateway', 'data'));
});

test('a daemon volume wins under either way of running', () => {
  for (const standalone of [false, true]) {
    expect(dirOf({ standalone, env: { AIHUB_VOL1_PATH: '/vol1' } }))
      .toBe(path.join(path.resolve('/vol1'), 'gateway'));
  }
});

test('a compiled binary uses the per-user directory of its platform', () => {
  expect(dirOf({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local' } }))
    .toBe(path.join('C:\\Users\\user\\AppData\\Local', 'llm-gateway'));
  expect(dirOf({ platform: 'win32' }))
    .toBe(path.join('/home/user', 'AppData', 'Local', 'llm-gateway'));
  expect(dirOf({ platform: 'darwin' }))
    .toBe(path.join('/home/user', 'Library', 'Application Support', 'llm-gateway'));
  expect(dirOf({ platform: 'linux', env: { XDG_DATA_HOME: '/data/user' } }))
    .toBe(path.join('/data/user', 'llm-gateway'));
  expect(dirOf({ platform: 'linux' }))
    .toBe(path.join('/home/user', '.local', 'share', 'llm-gateway'));
});

test('a relative or empty XDG_DATA_HOME is ignored, as XDG requires', () => {
  for (const XDG_DATA_HOME of ['relative/data', '']) {
    expect(dirOf({ env: { XDG_DATA_HOME } }))
      .toBe(path.join('/home/user', '.local', 'share', 'llm-gateway'));
  }
});
