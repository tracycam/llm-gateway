// The command line: a small, strict parser. Every option it knows is listed in helpText();
// anything else, a missing value or a value out of range is an error the process reports with
// exit code 2. Flags are applied to the environment before config.ts is read, so they win.

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export interface CliOptions {
  action: 'run' | 'help' | 'version';
  /** `--port`; undefined when the flag was not given. */
  port?: number;
  /** `--listen`; undefined when the flag was not given. */
  listen?: string;
  /** `--data-dir`; undefined when the flag was not given. */
  dataDir?: string;
}

const VALUE_FLAGS = ['port', 'listen', 'data-dir'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

function isValueFlag(name: string): name is ValueFlag {
  return (VALUE_FLAGS as readonly string[]).includes(name);
}

function portValue(raw: string): number {
  const value = Number(raw);
  if (raw === '' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new CliError(`--port must be an integer between 1 and 65535, not "${raw}"`);
  }
  return value;
}

function textValue(flag: string, raw: string): string {
  if (raw === '') throw new CliError(`--${flag} needs a non-empty value`);
  return raw;
}

/** Parse the arguments after the binary (or after `main.ts` when run from source). */
export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { action: 'run' };
  const given = new Set<ValueFlag>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--help') {
      options.action = 'help';
      continue;
    }
    if (arg === '--version') {
      if (options.action !== 'help') options.action = 'version';
      continue;
    }
    if (!arg.startsWith('-')) throw new CliError(`Unexpected argument: ${arg}`);

    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    if (name === 'help' || name === 'version') {
      throw new CliError(`--${name} takes no value`);
    }
    if (!isValueFlag(name)) throw new CliError(`Unknown option: ${arg}`);
    if (given.has(name)) throw new CliError(`--${name} was given more than once`);
    given.add(name);

    let raw = equals === -1 ? undefined : arg.slice(equals + 1);
    if (equals === -1) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('-')) throw new CliError(`--${name} needs a value`);
      raw = next;
      index++;
    }
    if (raw === undefined) throw new CliError(`--${name} needs a value`);

    if (name === 'port') options.port = portValue(raw);
    else if (name === 'listen') options.listen = textValue(name, raw);
    else options.dataDir = textValue(name, raw);
  }
  return options;
}

/**
 * Put the flags in the environment the configuration reads. `PORT`, `LISTEN` and `DATA_DIR`
 * already beat their earlier names there, so an explicit flag is the last word.
 */
export function applyCliOptions(options: CliOptions, env: NodeJS.ProcessEnv = process.env): void {
  if (options.port !== undefined) env.PORT = String(options.port);
  if (options.listen !== undefined) env.LISTEN = options.listen;
  if (options.dataDir !== undefined) env.DATA_DIR = options.dataDir;
}

/** Why the listener could not open, in words an operator can act on; null for anything else. */
export function listenFailure(err: unknown, listen: string, port: number): string | null {
  const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
  if (code === 'EADDRINUSE') {
    return `port ${port} on ${listen} is already in use; choose another with --port`;
  }
  if (code === 'EACCES') return `not allowed to listen on ${listen}:${port}; choose a port above 1024 with --port`;
  if (code === 'EADDRNOTAVAIL') return `${listen} is not an address of this machine; check --listen`;
  return null;
}

/** The help text; the administrator token is deliberately not a flag. */
export function helpText(version: string): string {
  return `LLM Gateway ${version} — /v1 API, API keys, administration and Web console

Usage: llm-gateway [options]

Options:
  --port <n>         TCP port to listen on (1-65535; default 8000)
  --listen <address> Address to bind (default 127.0.0.1)
  --data-dir <dir>   Directory for the database
  --version          Print the version and exit
  --help             Print this help and exit

Environment:
  PORT, LISTEN, DATA_DIR         Defaults the flags above override
  ADMIN_TOKEN                    Administrator token; env only, never a flag. Required
                                 when the gateway listens on a non-loopback address.
  WEB_DIST_DIR                   Console directory when running from source

The data directory defaults to "data" beside a source checkout, and to the per-user data
directory (for example ~/.local/share/llm-gateway) in a compiled binary.`;
}
