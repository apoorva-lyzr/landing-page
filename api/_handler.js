/* One handler shape for all three endpoints. State lives in the browser and is posted back
 * each step: a POC needs no database, and nothing here is worth persisting server-side
 * except the run record the partner team would read. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ROOT_DIR } from '../lib/env.js';

export const json = (res, code, body) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

export async function body(req) {
  if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/* The internal note goes to a file, not to the browser. When the handoff is built this is
 * the thing that becomes a CRM write.
 *
 * A serverless filesystem is read-only apart from the temp directory, and it does not
 * survive the request anyway — so on a host this is a best-effort local log and never a
 * reason to fail the visitor's request. The run record only matters on a machine someone
 * can read it from. */
const RUNS = process.env.VERCEL ? path.join(os.tmpdir(), 'partner-runs') : path.join(ROOT_DIR, 'runs');

export async function record(id, patch) {
  try {
    const file = path.join(RUNS, `${id}.json`);
    await fs.mkdir(RUNS, { recursive: true });
    const prev = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => ({ id, started: new Date().toISOString() }));
    await fs.writeFile(file, JSON.stringify({ ...prev, ...patch, updated: new Date().toISOString() }, null, 1));
  } catch (e) {
    console.error('could not write the run record:', e.message);
  }
}

/* The agent is embedded on www.lyzr.ai inside a srcdoc iframe, which inherits the parent
 * page's origin — so from there every call to this API is cross-origin and needs CORS.
 * Same-origin use (the Vercel app itself, localhost) sends no Origin and is unaffected. */
const ALLOWED = [
  /^https:\/\/([a-z0-9-]+\.)*lyzr\.ai$/,
  /^https:\/\/[a-z0-9-]+\.vercel\.app$/,
  /^http:\/\/localhost(:\d+)?$/,
];

function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED.some((re) => re.test(origin))) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export const guard = (fn) => async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try { return await fn(req, res); }
  catch (e) { console.error(e); return json(res, 500, { error: String(e.message || e) }); }
};
