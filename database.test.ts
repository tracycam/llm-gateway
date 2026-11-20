import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { openGatewayDatabase } from './database';
import { tempDir } from './testing/fixtures';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('the database opens writable and its directory and file are private on POSIX', () => {
  const dir = path.join(tempDir(), 'data');
  dirs.push(path.dirname(dir));
  const db = openGatewayDatabase(dir);
  try {
    db.exec('CREATE TABLE probe (value TEXT)');
    db.exec("INSERT INTO probe VALUES ('written')");
    expect(db.query('SELECT value FROM probe').get()).toEqual({ value: 'written' });
  } finally {
    db.close();
  }
  // Windows only has a read-only attribute, not POSIX modes; the writability check above is
  // the part that matters there.
  if (process.platform !== 'win32') {
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'gateway.sqlite')).mode & 0o777).toBe(0o600);
  }
});
