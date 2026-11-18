import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from './nodeStore';

const dirs: string[] = [];
function directory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-store-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const record = {
  id: 'node-12345678',
  name: 'one',
  url: 'http://localhost:1',
  token: 'secret',
  nodeId: 'daemon-one',
  createdAt: '2026-01-01T00:00:00.000Z',
};

test('an inserted node is listed as it was given', () => {
  const store = new NodeStore(directory());
  store.insert(record);
  expect(store.list()).toEqual([record]);
  store.close();
});

test('a node without a token is listed with a null token', () => {
  const store = new NodeStore(directory());
  store.insert({ ...record, token: null });
  expect(store.list()[0].token).toBeNull();
  store.close();
});

test('update replaces name, address and token', () => {
  const store = new NodeStore(directory());
  store.insert(record);
  const changed = { ...record, name: 'two', url: 'http://localhost:2', token: null };
  store.update(changed);
  expect(store.list()).toEqual([changed]);
  store.close();
});

test('delete removes the node and says whether there was one', () => {
  const store = new NodeStore(directory());
  store.insert(record);
  expect(store.delete(record.id)).toBe(true);
  expect(store.delete(record.id)).toBe(false);
  expect(store.list()).toEqual([]);
  store.close();
});

test('the same daemon cannot be stored twice', () => {
  const store = new NodeStore(directory());
  store.insert(record);
  expect(() => store.insert({ ...record, id: 'node-87654321' })).toThrow();
  store.close();
});

test('records survive reopening', () => {
  const dir = directory();
  const first = new NodeStore(dir);
  first.insert(record);
  first.close();
  const second = new NodeStore(dir);
  expect(second.list()).toEqual([record]);
  second.close();
});

test('a new data directory is 0700 and its database 0600', () => {
  const dir = path.join(directory(), 'gateway');
  const store = new NodeStore(dir);
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  store.insert(record);
  for (const suffix of ['', '-wal', '-shm']) {
    expect(fs.statSync(path.join(dir, `gateway.sqlite${suffix}`)).mode & 0o777).toBe(0o600);
  }
  store.close();
});

test('a directory and database files that existed with wider permissions are narrowed', () => {
  const dir = directory();
  const first = new NodeStore(dir);
  fs.chmodSync(dir, 0o755);
  for (const suffix of ['', '-wal', '-shm']) {
    fs.chmodSync(path.join(dir, `gateway.sqlite${suffix}`), 0o644);
  }
  const store = new NodeStore(dir);
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  for (const suffix of ['', '-wal', '-shm']) {
    expect(fs.statSync(path.join(dir, `gateway.sqlite${suffix}`)).mode & 0o777).toBe(0o600);
  }
  store.close();
  first.close();
});
