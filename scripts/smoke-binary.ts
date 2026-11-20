// Starts a built gateway executable the way a user does — a free port, a fresh data directory
// outside any checkout — and answers every question the release promises. It exits 0 only
// after every check ran and passed, and removes everything it created.
//
//   bun run scripts/smoke-binary.ts release/llm-gateway-0.1.0-linux-x64
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const HEALTH_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

class SmokeError extends Error {}

function fail(message: string): never {
  throw new SmokeError(message);
}

/** A port nothing holds, probed on the wildcard address so the binary can bind either family. */
async function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '0.0.0.0', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      reject(new Error('Could not determine a free port'));
      return;
    }
    server.close((err) => err ? reject(err) : resolve(address.port));
  });
  return promise;
}

function check(name: string): void {
  console.log(`[smoke] ok  ${name}`);
}

interface Running {
  child: ReturnType<typeof Bun.spawn>;
  output(): Promise<string>;
}

async function start(binary: string, port: number, dataDir: string): Promise<Running> {
  if (!fs.existsSync(binary)) fail(`binary not found: ${binary}`);
  const child = Bun.spawn([binary, '--port', String(port), '--data-dir', dataDir], {
    cwd: os.tmpdir(),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });
  const collect = async (stream: ReadableStream<Uint8Array> | undefined): Promise<string> =>
    stream === undefined ? '' : await new Response(stream).text();
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  return { child, output: async () => `${await stdout}${await stderr}` };
}

async function waitForHealth(running: Running, url: string): Promise<Response> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    if (running.child.exitCode !== null) {
      fail(`the gateway exited with ${running.child.exitCode} before answering:\n${await running.output()}`);
    }
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 200) return response;
    } catch {
      // Not listening yet; the deadline decides whether that is a failure.
    }
    if (Date.now() > deadline) {
      fail(`the gateway did not answer /healthz within ${HEALTH_TIMEOUT_MS / 1000}s:\n${await running.output()}`);
    }
    await Bun.sleep(100);
  }
}

async function stop(running: Running): Promise<void> {
  if (running.child.exitCode !== null) return;
  running.child.kill();
  const timer = setTimeout(() => running.child.kill('SIGKILL'), STOP_TIMEOUT_MS);
  try {
    await running.child.exited;
  } finally {
    clearTimeout(timer);
  }
}

/** The first JavaScript asset the console's HTML loads. */
function assetFrom(html: string): string {
  for (const match of html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)) {
    const src = match[1];
    if (src !== undefined && src.startsWith('/assets/')) return src;
  }
  fail('the console HTML references no /assets/*.js file');
}

async function smoke(binary: string, dataDir: string): Promise<void> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let running: Running | undefined;
  try {
    running = await start(binary, port, dataDir);
    check(`started ${path.basename(binary)} on port ${port}`);

    const health = await waitForHealth(running, url);
    check(`GET /healthz ${health.status}`);

    const rootResponse = await fetch(`${url}/`);
    if (rootResponse.status !== 200) fail(`GET / returned ${rootResponse.status}`);
    const rootHtml = await rootResponse.text();
    if (!rootHtml.includes('<div id="root">')) fail('GET / did not return the console HTML');
    check('GET / returns the console HTML');

    const asset = assetFrom(rootHtml);
    const assetResponse = await fetch(`${url}${asset}`);
    const contentType = assetResponse.headers.get('content-type') ?? '';
    if (assetResponse.status !== 200) fail(`GET ${asset} returned ${assetResponse.status}`);
    if (!contentType.includes('javascript')) fail(`GET ${asset} has content type "${contentType}"`);
    check(`GET ${asset} 200 ${contentType}`);

    const routeResponse = await fetch(`${url}/models`);
    const routeHtml = await routeResponse.text();
    if (routeResponse.status !== 200 || routeHtml !== rootHtml) {
      fail(`GET /models returned ${routeResponse.status}${routeHtml === rootHtml ? '' : ' with different HTML'}`);
    }
    check('GET /models returns the console HTML');

    const database = path.join(dataDir, 'gateway.sqlite');
    if (!fs.existsSync(database) || fs.statSync(database).size === 0) {
      fail(`the database was not created at ${database}`);
    }
    check(`database created at ${database}`);

    await stop(running);
    running = undefined;
    check('process stopped');
  } finally {
    if (running !== undefined) await stop(running);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 || argv[0] === undefined || argv[0].startsWith('-')) {
    console.error('Usage: bun run scripts/smoke-binary.ts <path-to-binary>');
    process.exit(2);
  }
  const binary = path.resolve(argv[0]);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-gateway-smoke-'));
  const dataDir = path.join(work, 'data');
  try {
    await smoke(binary, dataDir);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log('[smoke] all checks passed');
}

try {
  await main();
} catch (err) {
  if (err instanceof SmokeError) {
    console.error(`[smoke] FAILED: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
