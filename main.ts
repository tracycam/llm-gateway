// The gateway process: parse the command line, read configuration, open the one database,
// serve the app, shut down cleanly. Flags are applied before `config` is imported because it
// resolves the environment once.
import type { Server } from 'bun';
import type * as Config from './config';
import { GATEWAY_IDLE_TIMEOUT, createApp } from './app';
import { requireTokenConfig } from './adminAuth';
import { CliError, applyCliOptions, helpText, listenFailure, parseArgs } from './cli';
import { CONNECTORS, connectorById } from './connectors/registry';
import { migrateGatewayDataDir } from './dataDir';
import { openGatewayDatabase } from './database';
import packageJson from './package.json';
import { embeddedWebAssets } from './webAssets';

/** A positive millisecond setting under its neutral name, then its earlier name. */
function timing(name: string, legacy: string): number | undefined {
  const value = process.env[name] ?? process.env[legacy];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number of milliseconds, not "${value}"`);
  }
  return parsed;
}

/** Ends the process with a one-line reason: the error is the operator's to fix, not a bug. */
function fail(message: string): never {
  console.error(`llm-gateway: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    console.error(`llm-gateway: ${err.message}`);
    console.error("Try 'llm-gateway --help' for usage.");
    process.exit(2);
  }
  if (options.action === 'help') {
    console.log(helpText(packageJson.version));
    return;
  }
  if (options.action === 'version') {
    console.log(packageJson.version);
    return;
  }
  applyCliOptions(options);

  // `config` resolves the environment once, at module load, so it is imported only after the
  // flags above are in the environment; a static import would read it too early. Its errors,
  // and the token rule's, name the setting to fix.
  let config: typeof Config;
  try {
    config = await import('./config');
    requireTokenConfig(config.LISTEN, config.ADMIN_TOKEN);
  } catch (err) {
    if (err instanceof Error) fail(err.message);
    throw err;
  }
  const { ADMIN_TOKEN, DATA_DIR, LEGACY_DATA_DIR, LISTEN, PORT, WEB_DIST_DIR, isStandaloneBinary } = config;
  // Only a gateway that shares a daemon's volume can have the retired app directory to move.
  if (LEGACY_DATA_DIR !== null) migrateGatewayDataDir(DATA_DIR, LEGACY_DATA_DIR);
  const app = createApp({
    db: openGatewayDatabase(DATA_DIR),
    webDistDir: WEB_DIST_DIR,
    // A compiled binary carries the console; a source checkout serves `web/dist` from disk.
    webAssets: isStandaloneBinary
      ? embeddedWebAssets(Bun.embeddedFiles)
      : undefined,
    fetch,
    now: () => new Date(),
    connector: connectorById,
    connectors: () => CONNECTORS,
    adminToken: ADMIN_TOKEN,
    nodeTiming: {
      watchdogMs: timing('NODE_WATCHDOG_MS', 'AIHUB_GATEWAY_NODE_WATCHDOG_MS'),
      retryMinMs: timing('NODE_RETRY_MIN_MS', 'AIHUB_GATEWAY_NODE_RETRY_MIN_MS'),
      retryMaxMs: timing('NODE_RETRY_MAX_MS', 'AIHUB_GATEWAY_NODE_RETRY_MAX_MS'),
    },
  });

  // The gateway serves no WebSockets.
  let server: Server<undefined>;
  try {
    server = Bun.serve({
      port: PORT,
      hostname: LISTEN,
      idleTimeout: GATEWAY_IDLE_TIMEOUT,
      fetch: (req) => app.handle(req),
    });
  } catch (err) {
    const reason = listenFailure(err, LISTEN, PORT);
    if (reason === null) throw err;
    await app.close();
    fail(reason);
  }

  console.log(`[LLM API Gateway] Listening on http://${LISTEN}:${server.port}`);
  console.log(`[LLM API Gateway] Data directory: ${DATA_DIR}`);

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await server.stop(true);
    await app.close();
    process.exit(0);
  };
  // Ctrl+C reaches every platform. SIGTERM is a POSIX signal; Windows terminates with Ctrl+C
  // or TerminateProcess instead.
  process.on('SIGINT', shutdown);
  if (process.platform !== 'win32') process.on('SIGTERM', shutdown);
}

await main();
