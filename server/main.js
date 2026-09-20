import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiMiddleware } from './api.js';
import { openDatabase } from './db.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)), 'dist');
const db = openDatabase(process.env.PLAN_DIFF_DB);
const port = Number(process.env.PORT || 5345);
const host = process.env.HOST || '127.0.0.1';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    req.url = req.url.slice('/api'.length) || '/';
    return createApiMiddleware(db)(req, res);
  }
  let path = req.url.split('?')[0];
  if (path === '/') path = '/index.html';
  const file = join(root, path);
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    const index = join(root, 'index.html');
    if (existsSync(index)) return createReadStream(index).pipe(res);
    res.statusCode = 404;
    return res.end('Not found');
  }
  res.setHeader('content-type', types[extname(file)] || 'application/octet-stream');
  createReadStream(file).pipe(res);
});

server.listen(port, host, () => {
  console.log(`Plan Diff offline server at http://${host}:${port}`);
});
