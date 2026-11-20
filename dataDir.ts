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

/** The inputs the default data directory depends on, kept separate so the rule is testable. */
export interface DataDirInput {
  /** True in a compiled binary, false when running the sources. */
  standalone: boolean;
  /** `process.platform`. */
  platform: string;
  /** The variables that place the directory; looked up on the passed object, not `process.env`. */
  env: {
    AIHUB_VOL1_PATH?: string;
    LOCALAPPDATA?: string;
    XDG_DATA_HOME?: string;
  };
  /** The user's home directory. */
  home: string;
  /** The gateway's own directory, where a source checkout keeps its data. */
  gatewayDir: string;
}

/**
 * Where the gateway keeps its database when neither `DATA_DIR` nor its earlier name is set.
 * A checkout keeps it beside the sources, so `gateway/` alone is a working gateway. A compiled
 * binary cannot write beside itself when installed read-only, so it uses the per-user data
 * directory of its platform instead.
 */
export function defaultDataDir(input: DataDirInput): string {
  // A daemon volume is an explicit deployment choice and wins under either way of running.
  if (input.env.AIHUB_VOL1_PATH) {
    return path.join(path.resolve(input.env.AIHUB_VOL1_PATH), 'gateway');
  }
  if (!input.standalone) return path.join(input.gatewayDir, 'data');

  if (input.platform === 'win32') {
    const local = input.env.LOCALAPPDATA;
    const base = local ? local : path.join(input.home, 'AppData', 'Local');
    return path.join(base, 'llm-gateway');
  }
  if (input.platform === 'darwin') {
    return path.join(input.home, 'Library', 'Application Support', 'llm-gateway');
  }
  // XDG says a relative or empty XDG_DATA_HOME is invalid and must be ignored.
  const xdg = input.env.XDG_DATA_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(input.home, '.local', 'share');
  return path.join(base, 'llm-gateway');
}
