import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dir, '..');
const VOL1_DIR = process.env.AIHUB_VOL1_PATH
  ? path.resolve(process.env.AIHUB_VOL1_PATH)
  : path.join(ROOT_DIR, 'vol1');

export const PORT = Number.parseInt(process.env.AIHUB_GATEWAY_PORT ?? '8000', 10);
export const LISTEN = process.env.AIHUB_GATEWAY_LISTEN ?? '127.0.0.1';
export const DATA_DIR = process.env.AIHUB_GATEWAY_DATA_DIR ?? path.join(VOL1_DIR, 'gateway');
export const WEB_DIST_DIR = process.env.AIHUB_WEB_DIST_DIR ?? path.join(ROOT_DIR, 'web', 'dist');
export const LEGACY_DATA_DIR = path.join(VOL1_DIR, 'apps', 'app-gateway');
