/* Local dev server: api/*.js on one port alongside public/, so `npm start` runs the whole
 * journey without a deploy.
 *
 * It lives in scripts/ rather than the repo root on purpose. Vercel's CLI treats a root
 * `server.js` as the application entrypoint and deploys the project as a long-running Node
 * server — which silently bypasses `vercel.json`'s `functions` block, so `maxDuration`
 * drops back to the platform default and the calls that take twenty-odd seconds time out.
 * Out of the root, Vercel sees what it should: static `public/`, functions in `api/`. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json',
  // public/assets/ holds the unbundled export assets; fonts in particular are refused if
  // they arrive as octet-stream.
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.ico': 'image/x-icon' };
const routes = Object.fromEntries(await Promise.all(
  fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js') && !f.startsWith('_'))
    .map(async (f) => [`/api/${f.replace(/\.js$/, '')}`, (await import(`../api/${f}`)).default]),
));

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const fn = routes[url.pathname.replace(/\/$/, '')];
  if (fn) return fn(req, res);

  // vercel.json's rewrites, so an extensionless link works the same here as deployed.
  const REWRITES = { '/': '/index.html', '/agent': '/agent.html', '/partner-directory': '/partner-directory.html' };
  const rel = REWRITES[url.pathname.replace(/\/$/, '') || '/'] ?? url.pathname;
  const file = path.join(ROOT, 'public', rel);
  if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
  res.end(fs.readFileSync(file));
}).listen(process.env.PORT || 3000, () => console.log(`partner agent on http://localhost:${process.env.PORT || 3000}`));
