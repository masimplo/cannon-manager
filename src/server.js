// Local web app for the Canon PIXMA G5040. Run: npm start, then open http://localhost:4280
// Binds to 127.0.0.1 only: there is no login, and the API can start cleanings and prints.

import http from 'node:http';
import { readFile, writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStatus, getJobs, cancelJob, identify, printJpeg, toJpeg, discover, getMacQueues, resumeMacQueue } from './printer.js';
import { MAINTENANCE, runMaintenance } from './maintenance.js';
import { maintenanceBlockedReason } from './status.js';
import { runDiagnostics } from './diagnostics.js';
import { renderTestPageJpeg } from './testpage.js';
import { History } from './history.js';
import { PrintHistory } from './print-history.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const DATA = join(ROOT, 'data');
const CONFIG_FILE = join(DATA, 'config.json');
const PORT = Number(process.env.PORT ?? 4280);
const BIND = process.env.BIND ?? '127.0.0.1';
const POLL_MS = Number(process.env.POLL_MS ?? 30000);
const MAX_UPLOAD = 50 * 1024 * 1024;

const history = new History(join(DATA, 'history.jsonl'));
const prints = new PrintHistory(join(DATA, 'prints'), { limit: 30 });
const PRINT_OPTIONS = ['copies', 'media', 'sides', 'colorMode', 'quality'];

/** Send a JPEG to the printer and keep it in the print history, even when the printer refuses it. */
async function printAndRecord(name, jpeg, options, reprintOf) {
  let result;
  try {
    result = await printJpeg(requireHost(), jpeg, { ...options, jobName: name });
  } catch (e) {
    result = { status: e.message, ok: false };
    await prints.add({ name, jpeg, options, result, reprintOf });
    throw e;
  }
  const entry = await prints.add({ name, jpeg, options, result, reprintOf });
  await history.add({ type: 'action', action: reprintOf ? 'reprint' : 'print', file: name, result: result.status, jobId: result.jobId });
  return { ...result, printId: entry.id };
}
let config = { host: process.env.PRINTER_HOST ?? null };

async function loadConfig() {
  await mkdir(DATA, { recursive: true });
  try {
    config = { ...JSON.parse(await readFile(CONFIG_FILE, 'utf8')), ...(process.env.PRINTER_HOST ? { host: process.env.PRINTER_HOST } : {}) };
  } catch {
    /* first run */
  }
  if (!config.host) {
    const found = (await discover()).filter((p) => p.canon);
    if (found[0]) {
      config.host = found[0].host;
      await saveConfig();
      console.log(`Discovered ${found[0].name} at ${config.host}`);
    }
  }
}

async function saveConfig() {
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error(`Upload larger than ${Math.round(limit / 1048576)} MB`), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const b = await readBody(req);
  return b.length ? JSON.parse(b.toString('utf8')) : {};
}

function requireHost() {
  if (!config.host) throw Object.assign(new Error('No printer configured. Set its IP address in Settings.'), { status: 409 });
  return config.host;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const routes = {
  'GET /api/config': async () => ({ ...config, pollMs: POLL_MS }),
  'POST /api/config': async (req) => {
    const body = await readJson(req);
    if (body.host !== undefined) {
      if (!/^[A-Za-z0-9.:-]+$/.test(body.host)) throw Object.assign(new Error('Enter an IP address or hostname'), { status: 400 });
      config.host = body.host;
    }
    await saveConfig();
    return config;
  },
  'GET /api/discover': async () => discover(),
  'GET /api/status': async () => {
    const host = requireHost();
    const { summary, remoteUiError, chmpError } = await getStatus(host);
    summary.maintenanceBlocked = maintenanceBlockedReason(summary);
    await history.recordStatus(summary);
    return { host, summary, remoteUiError, chmpError, at: new Date().toISOString() };
  },
  'GET /api/attributes': async () => (await getStatus(requireHost())).attrs,
  'GET /api/jobs': async () => getJobs(requireHost()),
  'GET /api/diagnostics': async () => {
    const result = await runDiagnostics(requireHost());
    const failing = result.checks.filter((c) => c.result === 'fail').map((c) => c.title);
    await history.add({ type: 'diagnostics', failing });
    return result;
  },
  'GET /api/maintenance': async () => MAINTENANCE,
  'GET /api/mac-queues': async () => getMacQueues(requireHost()),
  'POST /api/mac-queues/resume': async (req) => {
    const { name } = await readJson(req);
    const q = await resumeMacQueue(String(name ?? ''));
    await history.add({ type: 'action', action: 'resume-mac-queue', queue: name, result: q?.enabled ? 'enabled' : 'still disabled' });
    return q;
  },
  'GET /api/prints': async () => prints.list(),
  'GET /api/history': async () => history.entries.slice(-500).reverse(),
  'POST /api/identify': async () => {
    const r = await identify(requireHost());
    await history.add({ type: 'action', action: 'identify', result: r.status });
    return r;
  },
  'POST /api/test-page': async (req) => {
    requireHost();
    const opts = await readJson(req);
    const options = Object.fromEntries(PRINT_OPTIONS.filter((k) => opts[k] !== undefined).map((k) => [k, opts[k]]));
    return printAndRecord('Colour test page', await renderTestPageJpeg(), options);
  },
  'POST /api/print': async (req, url) => {
    const host = requireHost();
    const body = await readBody(req, MAX_UPLOAD);
    if (!body.length) throw Object.assign(new Error('No file received'), { status: 400 });
    const filename = decodeURIComponent(url.searchParams.get('filename') ?? 'upload');
    const opts = Object.fromEntries(PRINT_OPTIONS.map((k) => [k, url.searchParams.get(k) || undefined]));
    const isJpeg = body[0] === 0xff && body[1] === 0xd8;
    let jpeg = body;
    if (!isJpeg) {
      const dir = await mkdtemp(join(tmpdir(), 'g5040-print-'));
      try {
        const input = join(dir, `in${extname(filename) || '.bin'}`);
        await writeFile(input, body);
        jpeg = await readFile(await toJpeg(input, join(dir, 'out.jpg')));
      } catch (e) {
        throw Object.assign(new Error(`Could not convert ${filename} to JPEG (${e.message.split('\n')[0]}). Images and single-page PDFs work; print other documents from the app that made them.`), { status: 415 });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    const options = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
    return printAndRecord(filename, jpeg, options);
  },
};

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const key = `${req.method} ${url.pathname}`;

  // Mutating requests must come from this app's own page (blocks drive-by requests from other sites).
  if (req.method === 'POST' || req.method === 'DELETE') {
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return send(res, 403, { error: 'Cross-origin request refused' });
  }

  try {
    if (routes[key]) return send(res, 200, await routes[key](req, url));

    const maint = /^\/api\/maintenance\/([a-z-]+)$/.exec(url.pathname);
    if (maint && req.method === 'POST') {
      const host = requireHost();
      const body = await readJson(req);
      const id = maint[1];
      if (!MAINTENANCE[id]) return send(res, 404, { error: `Unknown maintenance action ${id}` });
      if (!body.force) {
        const { summary } = await getStatus(host);
        const blocked = maintenanceBlockedReason(summary);
        if (blocked) return send(res, 409, { error: blocked, blocked: true });
      }
      const r = await runMaintenance(host, id, { paper: body.paper === 'letter' ? 'letter' : 'a4' });
      await history.add({ type: 'action', action: id, forced: Boolean(body.force) });
      return send(res, 200, r);
    }

    const printRoute = /^\/api\/prints\/([0-9a-f-]{36})(?:\/(thumb|image|reprint))?$/.exec(url.pathname);
    if (printRoute) {
      const [, id, action] = printRoute;
      const entry = prints.get(id);
      if (!entry) return send(res, 404, { error: 'Print not found' });
      if (req.method === 'GET' && action === 'thumb') return send(res, 200, await prints.thumbnail(id), 'image/jpeg');
      if (req.method === 'GET' && action === 'image') return send(res, 200, await prints.document(id), 'image/jpeg');
      if (req.method === 'POST' && action === 'reprint') {
        const body = await readJson(req);
        const overrides = Object.fromEntries(PRINT_OPTIONS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
        return send(res, 200, await printAndRecord(entry.name, await prints.document(id), { ...entry.options, ...overrides }, id));
      }
      if (req.method === 'DELETE' && !action) return send(res, 200, { deleted: await prints.remove(id) });
      return send(res, 405, { error: 'Method not allowed' });
    }

    const cancel = /^\/api\/jobs\/(\d+)\/cancel$/.exec(url.pathname);
    if (cancel && req.method === 'POST') {
      const r = await cancelJob(requireHost(), Number(cancel[1]));
      await history.add({ type: 'action', action: 'cancel-job', jobId: Number(cancel[1]), result: r.status });
      return send(res, 200, r);
    }

    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      if (path.includes('..')) return send(res, 400, 'Bad path', 'text/plain');
      try {
        return send(res, 200, await readFile(join(PUBLIC, path)), MIME[extname(path)] ?? 'application/octet-stream');
      } catch {
        return send(res, 404, 'Not found', 'text/plain');
      }
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    const status = e.status ?? (/(ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|timed out)/.test(e.message) ? 504 : 500);
    if (status === 504) await history.recordUnreachable(e.message);
    return send(res, status, { error: e.message });
  }
}

// Sample every POLL_MS when idle, every BUSY_POLL_MS while the printer is busy, so short
// events such as a roller cleaning started from the printer panel still reach the log.
const BUSY_POLL_MS = Number(process.env.BUSY_POLL_MS ?? 5000);
async function poll() {
  let next = POLL_MS;
  if (config.host) {
    try {
      const { summary } = await getStatus(config.host);
      await history.recordStatus(summary);
      if (summary.health === 'busy' || summary.state === 'processing') next = BUSY_POLL_MS;
    } catch (e) {
      await history.recordUnreachable(e.message);
    }
  }
  setTimeout(poll, next).unref();
}

await history.load();
await prints.load();
await loadConfig();
http.createServer(handle).listen(PORT, BIND, () => {
  console.log(`G5040 Manager on http://${BIND === '0.0.0.0' ? 'localhost' : BIND}:${PORT}  (printer: ${config.host ?? 'not configured'})`);
});
poll();
