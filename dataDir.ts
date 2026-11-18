import fs from 'node:fs';
import path from 'node:path';

/**
 * The gateway's data used to live in the daemon's app directory. Moves it once, so keys
 * issued before the gateway became its own process stay valid.
 */
export function migrateGatewayDataDir(dataDir: string, oldDir: string): void {
  if (fs.existsSync(dataDir) || !fs.existsSync(oldDir)) return;
  fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  fs.renameSync(oldDir, dataDir);
  console.log(`[Gateway] Migrated data directory from ${oldDir} to ${dataDir}`);
}
