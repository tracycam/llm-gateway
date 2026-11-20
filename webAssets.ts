import fs from 'node:fs';
import path from 'node:path';

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** One place the built console's files can come from: the `dist` directory or the binary. */
export interface WebAssets {
  /** The file at a validated, `/`-separated relative path, or null when this source has none. */
  file(relativePath: string): Blob | null;
}

/**
 * The console built on disk. Running from source serves this; a test can point it anywhere.
 * A missing file, a directory and a path that is not served are all null.
 */
export function diskWebAssets(webDistDir: string): WebAssets {
  const root = path.resolve(webDistDir);
  return {
    file(relativePath: string): Blob | null {
      const target = path.join(root, ...relativePath.split('/'));
      // The segment check below already forbids `..`; this keeps a future change from escaping.
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(target);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
        throw err;
      }
      return stat.isFile() ? Bun.file(target) : null;
    },
  };
}

/** The file name Bun gives an embedded file, when it has one. */
function embeddedName(file: Blob): string | null {
  return 'name' in file && typeof file.name === 'string' ? file.name : null;
}

/**
 * The console embedded in the compiled binary by `bun build --compile --asset=...`. The build
 * passes each top-level entry of `web/dist`, so Bun keeps exactly the console's own relative
 * paths — `index.html`, `assets/index-<hash>.js`. `prefix` selects a whole-tree asset instead,
 * for a build that passed the directory in one piece.
 */
export function embeddedWebAssets(files: readonly Blob[], prefix = ''): WebAssets {
  const root = prefix.replace(/^\/+|\/+$/g, '').replace(/\\/g, '/');
  const byPath = new Map<string, Blob>();
  for (const file of files) {
    const name = embeddedName(file);
    if (name === null) continue;
    const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '');
    let relative: string;
    if (root === '') {
      relative = normalized;
    } else if (normalized === root || !normalized.startsWith(`${root}/`)) {
      continue;
    } else {
      relative = normalized.slice(root.length + 1);
    }
    if (relative !== '') byPath.set(relative, file);
  }
  return {
    file(relativePath: string): Blob | null {
      return byPath.get(relativePath) ?? null;
    },
  };
}

/**
 * The relative path of the file `pathname` names, or null when the path is not one the console
 * may serve. The console routes on the client, so a path that names no file falls back to the
 * entry page; only a path that tries to leave the directory is refused.
 */
export function assetPath(pathname: string, entryHtml: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (err) {
    // A path that is not valid percent-encoding names no file.
    if (err instanceof URIError) return null;
    throw err;
  }
  // Windows treats `\` as a separator, and Bun there resolves a path that carries one against
  // the filesystem the same way. Normalizing it here keeps the check identical on every host.
  const cleaned = decoded
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  const normalized = path.posix.normalize(cleaned === '' ? entryHtml : cleaned);
  if (normalized === '' || normalized === '.') return entryHtml;
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    return null;
  }
  for (const segment of normalized.split('/')) {
    // Empty, climbing, and Windows drive/stream segments cannot name a console file.
    if (segment === '' || segment === '.' || segment === '..' || segment.includes(':') || segment.includes('\0')) {
      return null;
    }
  }
  return normalized;
}

function mimeType(relativePath: string): string {
  return MIME_BY_EXT[path.extname(relativePath).toLowerCase()] ?? 'application/octet-stream';
}

/** The console's answer for `pathname`: the file, else the entry page, else null. */
export function serveWebAsset(pathname: string, entryHtml: string, assets: WebAssets): Response | null {
  const relative = assetPath(pathname, entryHtml);
  if (relative === null) return null;
  let target = relative;
  let blob = assets.file(target);
  if (blob === null) {
    target = entryHtml;
    blob = assets.file(target);
  }
  if (blob === null) return null;
  return new Response(blob, {
    status: 200,
    headers: { 'Content-Type': mimeType(target) },
  });
}
