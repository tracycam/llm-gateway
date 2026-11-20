import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './testing/fixtures';
import { migrateGatewayDataDir } from './dataDir';

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
