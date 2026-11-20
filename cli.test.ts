import { expect, test } from 'bun:test';
import { CliError, applyCliOptions, listenFailure, parseArgs } from './cli';

test('no arguments runs the gateway with the configuration defaults', () => {
  expect(parseArgs([])).toEqual({ action: 'run' });
});

test('every flag is parsed, separated by a space or an equals sign', () => {
  expect(parseArgs(['--port', '9000', '--listen', '0.0.0.0', '--data-dir', '/var/lib/gateway']))
    .toEqual({ action: 'run', port: 9000, listen: '0.0.0.0', dataDir: '/var/lib/gateway' });
  expect(parseArgs(['--port=9001', '--listen=::1', '--data-dir=/tmp/gateway']))
    .toEqual({ action: 'run', port: 9001, listen: '::1', dataDir: '/tmp/gateway' });
});

test('--help and --version are actions, and help wins when both are present', () => {
  expect(parseArgs(['--help'])).toEqual({ action: 'help' });
  expect(parseArgs(['--version'])).toEqual({ action: 'version' });
  expect(parseArgs(['--version', '--help'])).toEqual({ action: 'help' });
  expect(parseArgs(['--help', '--version'])).toEqual({ action: 'help' });
});

test('a port outside 1-65535 or not an integer is refused', () => {
  for (const raw of ['0', '65536', '8000.5', 'eighty', '8000abc', ' ']) {
    expect(() => parseArgs(['--port', raw])).toThrow(CliError);
    expect(() => parseArgs(['--port', raw])).toThrow('--port must be an integer between 1 and 65535');
  }
});

test('an empty value is refused', () => {
  for (const argv of [['--listen', ''], ['--data-dir', ''], ['--listen='], ['--data-dir=']]) {
    expect(() => parseArgs(argv)).toThrow('needs a non-empty value');
  }
  expect(() => parseArgs(['--port='])).toThrow('--port must be an integer between 1 and 65535');
});

test('unknown flags, missing values, duplicates and stray arguments are errors', () => {
  expect(() => parseArgs(['--wat'])).toThrow('Unknown option: --wat');
  expect(() => parseArgs(['-p', '8000'])).toThrow('Unknown option: -p');
  expect(() => parseArgs(['--port'])).toThrow('--port needs a value');
  expect(() => parseArgs(['--port', '--listen'])).toThrow('--port needs a value');
  expect(() => parseArgs(['--help=1'])).toThrow('--help takes no value');
  expect(() => parseArgs(['--port', '8000', '--port', '8001'])).toThrow('--port was given more than once');
  expect(() => parseArgs(['serve'])).toThrow('Unexpected argument: serve');
});

test('flags are written over the environment the configuration reads', () => {
  const env: NodeJS.ProcessEnv = { PORT: '7000', LISTEN: '127.0.0.1', DATA_DIR: '/old' };
  applyCliOptions({ action: 'run', port: 9000, listen: '0.0.0.0', dataDir: '/new' }, env);
  expect(env).toEqual({ PORT: '9000', LISTEN: '0.0.0.0', DATA_DIR: '/new' });

  const untouched: NodeJS.ProcessEnv = { PORT: '7000' };
  applyCliOptions({ action: 'run' }, untouched);
  expect(untouched).toEqual({ PORT: '7000' });
});

test('a port another process holds is reported in words, from the error Bun actually throws', () => {
  const holder = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  let thrown: unknown;
  try {
    Bun.serve({ hostname: '127.0.0.1', port: holder.port, fetch: () => new Response() }).stop(true);
  } catch (err) {
    thrown = err;
  } finally {
    holder.stop(true);
  }
  expect(listenFailure(thrown, '127.0.0.1', holder.port!)).toBe(
    `port ${holder.port} on 127.0.0.1 is already in use; choose another with --port`,
  );
});

test('an error that is not about the listener is left to propagate', () => {
  expect(listenFailure(new Error('boom'), '127.0.0.1', 8000)).toBeNull();
  expect(listenFailure('not an error', '127.0.0.1', 8000)).toBeNull();
});
