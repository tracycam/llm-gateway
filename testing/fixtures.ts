// What the gateway's tests need from the machine: a throwaway directory, a port nothing holds,
// a fixed way to stop a spawned process, and a poller that stops at the first answer.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-test-'));
}

/**
 * A port nothing on this machine holds. Probed on the wildcard address: a port free on
 * 127.0.0.1 can still be the local end of an outbound connection on another address of the
 * host, and a process told to listen on 0.0.0.0 then fails with EADDRINUSE. A wildcard bind
 * succeeds only when no address has the port, so the port suits either listen address.
 */
export async function freePort(): Promise<number> {
  for (;;) {
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine test port'));
        return;
      }
      server.close((err) => err ? reject(err) : resolve(address.port));
    });
    const port = await promise;
    if (![4399, 8099, 3099, 18999].includes(port)) return port;
  }
}

/** Stops a spawned process: SIGTERM, then SIGKILL when it has not exited in time. */
export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = Promise.withResolvers<void>();
  child.once('exit', () => exited.resolve());
  child.once('error', exited.reject);
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try { await exited.promise; } finally { clearTimeout(timer); }
}

/** Polls `probe` until it answers something other than undefined. */
export async function until<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}
