import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Opens the gateway's one database file. It holds credentials, so the directory is made
 * 0700 and the database files 0600 on every open, also when they already existed wider.
 */
export function openGatewayDatabase(dataDir: string): Database {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.chmodSync(dataDir, 0o700);
  const filename = path.join(dataDir, 'gateway.sqlite');
  // Created here, empty, so that it is private before SQLite writes to it; SQLite gives
  // the -wal and -shm files it creates the permissions of the database file.
  fs.closeSync(fs.openSync(filename, 'a'));
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.chmodSync(filename + suffix, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  const db = new Database(filename);
  db.exec('PRAGMA journal_mode = WAL;');
  return db;
}
