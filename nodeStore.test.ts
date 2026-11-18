import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openGatewayDatabase } from './database';
import { NodeStore } from './nodeStore';
import { migrate } from './schema';

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

/** The gateway database in `dir` and the node store that reads it through its one connection. */
function opened(dir: string): { db: Database; store: NodeStore } {
  const db = openGatewayDatabase(dir);
  migrate(db);
  return { db, store: new NodeStore(db) };
}

test('an inserted node is listed as it was given', () => {
  const { db, store } = opened(directory());
  try {
    store.insert(record);
    expect(store.list()).toEqual([record]);
  } finally {
    db.close();
  }
});

test('a node without a token is listed with a null token', () => {
  const { db, store } = opened(directory());
  try {
    store.insert({ ...record, token: null });
    expect(store.list()[0].token).toBeNull();
  } finally {
    db.close();
  }
});

test('update replaces name, address and token', () => {
  const { db, store } = opened(directory());
  try {
    store.insert(record);
    const changed = { ...record, name: 'two', url: 'http://localhost:2', token: null };
    store.update(changed);
    expect(store.list()).toEqual([changed]);
  } finally {
    db.close();
  }
});

test('delete removes the node and says whether there was one', () => {
  const { db, store } = opened(directory());
  try {
    store.insert(record);
    expect(store.delete(record.id)).toBe(true);
    expect(store.delete(record.id)).toBe(false);
    expect(store.list()).toEqual([]);
  } finally {
    db.close();
  }
});

test('the same daemon cannot be stored twice', () => {
  const { db, store } = opened(directory());
  try {
    store.insert(record);
    expect(() => store.insert({ ...record, id: 'node-87654321' })).toThrow();
  } finally {
    db.close();
  }
});

test('records survive reopening', () => {
  const dir = directory();
  const first = opened(dir);
  first.store.insert(record);
  first.db.close();
  const second = opened(dir);
  try {
    expect(second.store.list()).toEqual([record]);
  } finally {
    second.db.close();
  }
});

test('a new data directory is 0700 and its database 0600', () => {
  const dir = path.join(directory(), 'gateway');
  const { db, store } = opened(dir);
  try {
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    store.insert(record);
    for (const suffix of ['', '-wal', '-shm']) {
      expect(fs.statSync(path.join(dir, `gateway.sqlite${suffix}`)).mode & 0o777).toBe(0o600);
    }
  } finally {
    db.close();
  }
});

test('a directory and database files that existed with wider permissions are narrowed', () => {
  const dir = directory();
  const first = opened(dir);
  fs.chmodSync(dir, 0o755);
  for (const suffix of ['', '-wal', '-shm']) {
    fs.chmodSync(path.join(dir, `gateway.sqlite${suffix}`), 0o644);
  }
  const second = opened(dir);
  try {
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    for (const suffix of ['', '-wal', '-shm']) {
      expect(fs.statSync(path.join(dir, `gateway.sqlite${suffix}`)).mode & 0o777).toBe(0o600);
    }
  } finally {
    second.db.close();
    first.db.close();
  }
});
