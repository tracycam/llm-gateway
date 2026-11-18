// Reading the API key a request presents and verifying it against the store.
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { KeyStore } from '../keyStore';
import { migrate } from '../schema';
import { authenticate, presentedKey } from './auth';

const now = new Date('2026-01-01T00:00:00Z');

function fixture() {
  const db = new Database(':memory:');
  migrate(db);
  const keys = new KeyStore(db);
  const key = keys.create({ name: 'key' }, now);
  return { db, keys, key };
}

function request(headers: HeadersInit = {}): Request {
  return new Request('http://localhost/v1/models', { headers });
}

test('presentedKey reads a Bearer token', () => {
  const f = fixture();
  try {
    expect(presentedKey(request({ authorization: `Bearer ${f.key.token}` }))).toBe(f.key.token);
  } finally {
    f.db.close();
  }
});

test('presentedKey reads x-api-key', () => {
  const f = fixture();
  try {
    expect(presentedKey(request({ 'x-api-key': f.key.token }))).toBe(f.key.token);
  } finally {
    f.db.close();
  }
});

test('presentedKey prefers a Bearer token over x-api-key', () => {
  const f = fixture();
  try {
    const headers = { authorization: `Bearer ${f.key.token}`, 'x-api-key': 'other' };
    expect(presentedKey(request(headers))).toBe(f.key.token);
  } finally {
    f.db.close();
  }
});

test('presentedKey does not treat a cookie as a key', () => {
  const f = fixture();
  try {
    expect(presentedKey(request({ cookie: f.key.token }))).toBeNull();
    expect(presentedKey(request({ cookie: `key=${f.key.token}` }))).toBeNull();
  } finally {
    f.db.close();
  }
});

test('presentedKey treats an empty x-api-key as no key', () => {
  const f = fixture();
  try {
    expect(presentedKey(request({ 'x-api-key': '' }))).toBeNull();
  } finally {
    f.db.close();
  }
});

test('authenticate returns the record of a valid key', () => {
  const f = fixture();
  try {
    const headers = { authorization: `Bearer ${f.key.token}` };
    expect(authenticate(request(headers), f.keys, now)?.id).toBe(f.key.id);
  } finally {
    f.db.close();
  }
});

test('authenticate reads every credential presentedKey accepts', () => {
  const f = fixture();
  try {
    const headers = { 'x-api-key': f.key.token };
    expect(authenticate(request(headers), f.keys, now)?.id).toBe(f.key.id);
  } finally {
    f.db.close();
  }
});

test('authenticate returns null without a key', () => {
  const f = fixture();
  try {
    expect(authenticate(request(), f.keys, now)).toBeNull();
  } finally {
    f.db.close();
  }
});

test('authenticate refuses an unknown key', () => {
  const f = fixture();
  try {
    const headers = { authorization: 'Bearer unknown' };
    expect(authenticate(request(headers), f.keys, now)).toBeNull();
  } finally {
    f.db.close();
  }
});

test('authenticate refuses a disabled key', () => {
  const f = fixture();
  try {
    f.keys.update(f.key.id, { enabled: false }, now);
    const headers = { authorization: `Bearer ${f.key.token}` };
    expect(authenticate(request(headers), f.keys, now)).toBeNull();
  } finally {
    f.db.close();
  }
});

test('authenticate refuses an expired key', () => {
  const f = fixture();
  try {
    f.keys.update(f.key.id, { expiresAt: now.toISOString() }, now);
    const headers = { authorization: `Bearer ${f.key.token}` };
    expect(authenticate(request(headers), f.keys, now)).toBeNull();
  } finally {
    f.db.close();
  }
});
