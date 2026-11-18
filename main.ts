// The gateway process: read configuration, open the one database, serve the app, shut down cleanly.
import { GATEWAY_IDLE_TIMEOUT, createApp } from './app';
import { requireTokenConfig } from './adminAuth';
import { DATA_DIR, LEGACY_DATA_DIR, LISTEN, PORT, WEB_DIST_DIR } from './config';
import { CONNECTORS, connectorById } from './connectors/registry';
import { migrateGatewayDataDir } from './dataDir';
import { openGatewayDatabase } from './database';

function timing(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid ${name}`);
  return parsed;
}

requireTokenConfig(LISTEN);
migrateGatewayDataDir(DATA_DIR, LEGACY_DATA_DIR);
const app = createApp({
  db: openGatewayDatabase(DATA_DIR),
  webDistDir: WEB_DIST_DIR,
  fetch,
  now: () => new Date(),
  connector: connectorById,
  connectors: () => CONNECTORS,
  adminToken: process.env.AIHUB_ADMIN_TOKEN,
  nodeTiming: {
    watchdogMs: timing('AIHUB_GATEWAY_NODE_WATCHDOG_MS'),
    retryMinMs: timing('AIHUB_GATEWAY_NODE_RETRY_MIN_MS'),
    retryMaxMs: timing('AIHUB_GATEWAY_NODE_RETRY_MAX_MS'),
  },
});

const server = Bun.serve({
  port: PORT,
  hostname: LISTEN,
  idleTimeout: GATEWAY_IDLE_TIMEOUT,
  fetch: (req) => app.handle(req),
});

console.log(`[LLM API Gateway] Listening on http://${LISTEN}:${server.port}`);

let closing = false;
const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await server.stop(true);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
