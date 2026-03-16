import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

export class StaticServer {
  private readonly root: string;

  constructor(staticPath?: string) {
    if (staticPath) {
      this.root = resolve(staticPath);
    } else {
      // Resolve the @clothos/ui package dist directory
      const require = createRequire(import.meta.url);
      const uiPkgPath = require.resolve('@clothos/ui/dist/index.html');
      this.root = join(uiPkgPath, '..');
    }
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    let filePath = join(this.root, url.pathname);

    // Prevent path traversal
    if (!filePath.startsWith(this.root)) {
      res.writeHead(403);
      res.end();
      return;
    }

    // Check if the file exists and is a file (not directory)
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      this.serveFile(filePath, res);
      return;
    }

    // SPA fallback: serve index.html for non-file paths
    const indexPath = join(this.root, 'index.html');
    if (existsSync(indexPath)) {
      this.serveFile(indexPath, res, true);
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private serveFile(
    filePath: string,
    res: ServerResponse,
    isFallback = false,
  ): void {
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

    const headers: Record<string, string> = {
      'Content-Type': contentType,
    };

    // Cache hashed assets aggressively, but not index.html
    if (!isFallback && ext !== '.html') {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    } else {
      headers['Cache-Control'] = 'no-cache';
    }

    res.writeHead(200, headers);
    createReadStream(filePath).pipe(res);
  }
}
