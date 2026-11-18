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

/**
 * The file of the built console that `pathname` asks for; the entry page for any path that
 * is not a file (the console routes on the client). Null when there is nothing to serve.
 */
export function serveWebAsset(pathname: string, entryHtml: string, webDistDir: string): Response | null {
  if (!fs.existsSync(webDistDir)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (err) {
    // A path that is not valid percent-encoding names no file.
    if (err instanceof URIError) return null;
    throw err;
  }
  const root = path.resolve(webDistDir);
  const rel = decoded === '/' ? entryHtml : decoded.replace(/^\/+/, '');
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;

  let target = resolved;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    target = path.join(root, entryHtml);
    if (!fs.existsSync(target)) return null;
  }
  const ext = path.extname(target).toLowerCase();
  return new Response(Bun.file(target), {
    status: 200,
    headers: {
      'Content-Type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
    },
  });
}
