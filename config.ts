import os from 'node:os';
import path from 'node:path';
import { adminToken } from './adminAuth';
import { defaultDataDir } from './dataDir';

/**
 * The gateway's own directory. A source checkout reads the console and, unless a compiled
 * binary placed it elsewhere, keeps its data under it.
 */
const GATEWAY_DIR = path.resolve(import.meta.dir);

/**
 * Replaced with `true` by the binary build (`bun build --compile --define`). Reading an
 * identifier no source declares is `undefined`, so running from source is false without
 * looking at paths or environment variables at all.
 */
declare const __LLM_GATEWAY_STANDALONE__: boolean | undefined;
export const isStandaloneBinary = typeof __LLM_GATEWAY_STANDALONE__ === 'boolean';

/** A setting under its neutral name, then its pre-rename name, if either is set. */
function setting(name: string, legacy: string): string | undefined {
  return process.env[name] ?? process.env[legacy];
}

function port(): number {
  const raw = setting('PORT', 'AIHUB_GATEWAY_PORT');
  if (raw === undefined) return 8000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`PORT must be an integer between 1 and 65535, not "${raw}"`);
  }
  return value;
}

/**
 * The daemon volume this gateway used to live in. Only set when an AI-Hub daemon shares this
 * machine; a standalone gateway has none, and looks for nothing of the daemon's.
 */
const VOL1_DIR = process.env.AIHUB_VOL1_PATH
  ? path.resolve(process.env.AIHUB_VOL1_PATH)
  : null;

export const PORT = port();
export const LISTEN = setting('LISTEN', 'AIHUB_GATEWAY_LISTEN') ?? '127.0.0.1';
export const ADMIN_TOKEN = adminToken();
export const DATA_DIR = setting('DATA_DIR', 'AIHUB_GATEWAY_DATA_DIR')
  ?? defaultDataDir({
    standalone: isStandaloneBinary,
    platform: process.platform,
    env: {
      AIHUB_VOL1_PATH: process.env.AIHUB_VOL1_PATH,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    },
    home: os.homedir(),
    gatewayDir: GATEWAY_DIR,
  });
export const WEB_DIST_DIR = setting('WEB_DIST_DIR', 'AIHUB_WEB_DIST_DIR')
  ?? path.join(GATEWAY_DIR, 'web', 'dist');
/** The retired app directory; null unless a daemon volume is configured. */
export const LEGACY_DATA_DIR = VOL1_DIR === null ? null : path.join(VOL1_DIR, 'apps', 'app-gateway');
