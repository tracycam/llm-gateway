// Builds the downloadable gateway: the console compiled into one executable per platform.
//   bun run build:bin                      all five targets
//   bun run build:bin --target linux-x64   only the named target (repeatable)
// The console is rebuilt when web/dist is missing or --rebuild-web is passed. release/ holds
// the binaries and SHA256SUMS; it is gitignored.
import fs from 'node:fs';
import path from 'node:path';
import packageJson from '../package.json';

const ROOT = path.resolve(import.meta.dir, '..');
const RELEASE = path.join(ROOT, 'release');
const WEB_DIST = path.join(ROOT, 'web', 'dist');

class BuildError extends Error {}

interface Target {
  /** Bun's cross-compilation target. */
  bun: string;
  /** Windows executables carry the extension. */
  executable: boolean;
}

const TARGETS: Record<string, Target> = {
  'windows-x64': { bun: 'bun-windows-x64', executable: true },
  'darwin-x64': { bun: 'bun-darwin-x64', executable: false },
  'darwin-arm64': { bun: 'bun-darwin-arm64', executable: false },
  'linux-x64': { bun: 'bun-linux-x64', executable: false },
  'linux-arm64': { bun: 'bun-linux-arm64', executable: false },
};
const ALL_TARGETS = Object.keys(TARGETS);

interface BuildOptions {
  targets: string[];
  rebuildWeb: boolean;
  minify: boolean;
}

function valueFlag(argv: readonly string[], index: number, name: string): { value: string; next: number } {
  const arg = argv[index] ?? '';
  const equals = arg.indexOf('=');
  if (equals !== -1) return { value: arg.slice(equals + 1), next: index };
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-')) throw new BuildError(`--${name} needs a value`);
  return { value: next, next: index + 1 };
}

function parseArgs(argv: readonly string[]): BuildOptions {
  const options: BuildOptions = { targets: [], rebuildWeb: false, minify: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run build:bin [options]

  --target <name>   Build one target; repeatable. Names: ${ALL_TARGETS.join(', ')}
                    Without it all five are built.
  --rebuild-web     Rebuild web/dist even when it exists.
  --minify          Minify the bundle (verify the result with scripts/smoke-binary.ts).
  --help             Show this help.`);
      process.exit(0);
    }
    if (arg === '--rebuild-web') {
      options.rebuildWeb = true;
      continue;
    }
    if (arg === '--minify') {
      options.minify = true;
      continue;
    }
    if (arg === '--target' || arg.startsWith('--target=')) {
      const { value, next } = valueFlag(argv, index, 'target');
      index = next;
      // A comma-separated list is accepted too; both forms name the same targets.
      for (const name of value.split(',').map((item) => item.trim()).filter((item) => item !== '')) {
        if (!Object.hasOwn(TARGETS, name)) {
          throw new BuildError(`Unknown target "${name}"; expected one of ${ALL_TARGETS.join(', ')}`);
        }
        if (!options.targets.includes(name)) options.targets.push(name);
      }
      continue;
    }
    throw new BuildError(`Unknown option: ${arg}`);
  }
  if (options.targets.length === 0) options.targets = [...ALL_TARGETS];
  return options;
}

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: 'inherit', stderr: 'inherit' });
  const code = await child.exited;
  if (code !== 0) throw new BuildError(`${command.join(' ')} exited with code ${code}`);
}

function consoleBuilt(): boolean {
  return fs.existsSync(path.join(WEB_DIST, 'index.html'));
}

/** The top-level names under web/dist, in a stable order. */
function consoleEntries(): string[] {
  return fs.readdirSync(WEB_DIST).sort();
}

async function webBuild(): Promise<void> {
  console.log('[build:bin] building the web console');
  await run(['bun', 'run', 'build'], path.join(ROOT, 'web'));
}

/** A readable size for the build log. */
function mebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function sha256(file: string): Promise<string> {
  return new Bun.CryptoHasher('sha256').update(await Bun.file(file).arrayBuffer()).digest('hex');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!consoleBuilt() || options.rebuildWeb) {
    await webBuild();
  } else {
    console.log('[build:bin] web/dist exists; pass --rebuild-web to rebuild it');
  }
  if (!consoleBuilt()) throw new BuildError('web/dist/index.html is still missing after the console build');

  fs.mkdirSync(RELEASE, { recursive: true });
  const version: string = packageJson.version;
  const outputs: string[] = [];
  for (const name of options.targets) {
    const target = TARGETS[name];
    if (target === undefined) throw new BuildError(`Unknown target: ${name}`);
    const filename = `llm-gateway-${version}-${name}${target.executable ? '.exe' : ''}`;
    const outfile = path.join(RELEASE, filename);
    const command = [
      'bun', 'build', path.join(ROOT, 'main.ts'),
      '--compile',
      `--target=${target.bun}`,
      `--outfile=${outfile}`,
      '--define', '__LLM_GATEWAY_STANDALONE__:true',
      // One --asset per top-level console entry: Bun then keeps the console's own paths
      // (`index.html`, `assets/...`) instead of nesting them under `dist/`.
      ...consoleEntries().map((entry) => `--asset=web/dist/${entry}`),
    ];
    if (options.minify) command.push('--minify');
    console.log(`[build:bin] ${name}`);
    await run(command, ROOT);
    const size = fs.statSync(outfile).size;
    console.log(`[build:bin] release/${filename}  ${mebibytes(size)}`);
    outputs.push(outfile);
  }

  const sums = [];
  for (const file of outputs) {
    sums.push(`${await sha256(file)}  ${path.basename(file)}`);
  }
  await Bun.write(path.join(RELEASE, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  console.log(`[build:bin] release/SHA256SUMS (${outputs.length} ${outputs.length === 1 ? 'file' : 'files'})`);
}

try {
  await main();
} catch (err) {
  if (err instanceof BuildError) {
    console.error(`build:bin: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
