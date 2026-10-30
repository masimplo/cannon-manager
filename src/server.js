// Local web app for the Canon PIXMA G5040. Run: npm start, then open http://localhost:4280
// Binds to 127.0.0.1 only: there is no login, and the API can start cleanings and prints.

import http from 'node:http';
import { readFile, writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStatus, getJobs, cancelJob, identify, printJpeg, postRawPrintJob, toJpeg, discover, getMacQueues, resumeMacQueue } from './printer.js';
import { MAINTENANCE, runMaintenance } from './maintenance.js';
import { maintenanceBlockedReason } from './status.js';
import { runDiagnostics } from './diagnostics.js';
import { renderTestPageJpeg } from './testpage.js';
import { History } from './history.js';
import { PrintHistory } from './print-history.js';
import { startIppProxy } from './ipp-proxy.js';
import { getSettings, setSetting, SETTINGS } from './device-settings.js';
import { Notifier, statusEvents, CATEGORIES } from './notify.js';
import { observeActivity, decideKeepAlive } from './keepalive.js';
import { runMaintenance as runMaintenanceJobOnPrinter } from './maintenance.js';
import { describeJobAttrs, buildRawPrintJob, withCopies } from './capture.js';
import { parseUrfHeader, urfFirstPageThumbnailBmp } from './urf.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const DATA = join(ROOT, 'data');
const CONFIG_FILE = join(DATA, 'config.json');
const PORT = Number(process.env.PORT ?? 4280);
const BIND = process.env.BIND ?? '127.0.0.1';
const POLL_MS = Number(process.env.POLL_MS ?? 30000);
const MAX_UPLOAD = 50 * 1024 * 1024;
const IPP_PORT = Number(process.env.IPP_PORT ?? 8631);
const LOOPBACK = /^(localhost|127\.|0\.0\.0\.0|::1$|\[::1\])/i;
const run = promisify(execFile);
let proxy = null;
let proxyError = null;

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
  if (!result.ok) await notifier.handle({ category: 'job', key: `job:${entry.id}`, title: 'Print job failed', message: `"${name}": ${result.status}` });
  return { ...result, printId: entry.id };
}
let config = { host: process.env.PRINTER_HOST ?? null };

async function captureStatus() {
  const { stdout } = await run('/usr/bin/lpstat', ['-v']).catch(() => ({ stdout: '' }));
  const queue = stdout.split('\n').map((l) => /^device for ([^:]+): (.+)$/.exec(l)).find((m) => m && proxy && m[2].includes(`:${proxy.port}/ipp/print`));
  const { stdout: def } = await run('/usr/bin/lpstat', ['-d']).catch(() => ({ stdout: '' }));
  return {
    running: Boolean(proxy),
    uri: proxy?.uri ?? null,
    error: proxyError,
    queue: queue?.[1] ?? null,
    isDefault: Boolean(queue && def.includes(queue[1])),
  };
}

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

const KEEPALIVE_DEFAULTS = { enabled: true, days: 7, windowStart: 9, windowEnd: 21 };
const NOTIFY_DEFAULTS = { mute: false, quietStart: 21, quietEnd: 9, categories: {} };
const notifier = new Notifier({
  prefs: NOTIFY_DEFAULTS,
  log: (e) => history.add({ type: 'notification', category: e.category, title: e.title, exitCode: e.exitCode }).catch(() => {}),
});

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
      // The capture printer listens on this Mac; pointing the app at itself would loop jobs forever.
      if (LOOPBACK.test(body.host)) throw Object.assign(new Error('Enter the printer\'s network address, not this Mac'), { status: 400 });
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
    const result = await runDiagnostics(requireHost(), { capture: await captureStatus() });
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
  'GET /api/capture': async () => captureStatus(),
  'GET /api/settings': async () => {
    const r = await getSettings(requireHost());
    cachedAutoPowerOn = r.settings.autoPowerOn;
    return { ...r, labels: SETTINGS };
  },
  'POST /api/settings': async (req) => {
    const { key, value } = await readJson(req);
    if (!SETTINGS[key]) throw Object.assign(new Error(`"${key}" cannot be changed from this app`), { status: 400 });
    try {
      const r = await setSetting(requireHost(), key, value);
      const verified = JSON.stringify(r.after) === JSON.stringify(typeof value === 'object' ? { ...r.before, ...value } : value)
        || JSON.stringify(r.after) === JSON.stringify(value);
      await history.add({ type: 'action', action: 'set-config', key, from: r.before, to: r.after, requested: value, verified });
      if (key === 'autoPowerOn') cachedAutoPowerOn = r.settings.autoPowerOn;
      return { ...r, verified };
    } catch (e) {
      await history.add({ type: 'action', action: 'set-config', key, requested: value, verified: false, error: e.message });
      await notifier.handle({ category: 'settings', key: `settings:${Date.now()}`, title: 'Printer setting not changed', message: `${SETTINGS[key].label}: ${e.message}` });
      throw e;
    }
  },
  'GET /api/notifications': async () => ({ prefs: notifier.prefs, categories: CATEGORIES }),
  'POST /api/notifications': async (req) => {
    const body = await readJson(req);
    const next = { ...notifier.prefs, ...body, categories: { ...notifier.prefs.categories, ...(body.categories ?? {}) } };
    notifier.prefs = next;
    config.notifications = next;
    await saveConfig();
    return next;
  },
  'POST /api/notifications/test': async () => {
    const r = await notifier.send('G5040 Manager', 'Notifications are working.');
    await history.add({ type: 'notification', category: 'test', title: 'Test notification', exitCode: r });
    return { exitCode: r };
  },
  'GET /api/keepalive': async () => ({ ...keepAlivePrefs(), state: config.keepAliveState ?? {}, lastDecision }),
  'POST /api/keepalive': async (req) => {
    const body = await readJson(req);
    const prefs = { ...keepAlivePrefs() };
    if (body.enabled !== undefined) prefs.enabled = Boolean(body.enabled);
    if (body.days !== undefined) {
      const d = Number(body.days);
      if (!Number.isInteger(d) || d < 1 || d > 60) throw Object.assign(new Error('Days must be a whole number from 1 to 60'), { status: 400 });
      prefs.days = d;
    }
    config.keepAlive = prefs;
    await saveConfig();
    return { ...prefs, state: config.keepAliveState ?? {} };
  },
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
      if (req.method === 'GET' && action === 'image') {
        if (entry.format !== 'image/urf') return send(res, 200, await prints.document(id), 'image/jpeg');
        return send(res, 200, await urfPreviewJpeg(await prints.document(id)), 'image/jpeg');
      }
      if (req.method === 'POST' && action === 'reprint' && entry.hasJobAttrs) {
        const body = await readJson(req);
        const host = requireHost();
        const document = await prints.document(id);
        const jobAttrs = await prints.jobAttributes(id);
        const copies = body.copies !== undefined ? Number(body.copies) : undefined;
        let result;
        try {
          result = await postRawPrintJob(host, buildRawPrintJob({ host, name: entry.name, user: 'g5040-manager', format: entry.format, jobAttrs, document, copies }));
        } catch (e) {
          result = { status: e.message, ok: false };
        }
        const newAttrs = copies !== undefined ? withCopies(jobAttrs, copies) : jobAttrs;
        const saved = await prints.add({ name: entry.name, source: entry.source, format: entry.format, document: { path: prints.documentPath(id), offset: 0, length: entry.bytes }, jobAttrs: newAttrs, options: { ...entry.options, ...(copies !== undefined ? { copies } : {}) }, result, reprintOf: id });
        await history.add({ type: 'action', action: 'reprint', file: entry.name, result: result.status, jobId: result.jobId });
        return send(res, result.ok ? 200 : 502, { ...result, printId: saved.id, ...(result.ok ? {} : { error: `Printer refused the re-print: ${result.status}` }) });
      }
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
let prevSnapshot = null;
let unreachableStreak = 0;
let offlineNotified = false;
let cachedAutoPowerOn = null;
let lastDecision = null;
let keepAliveRunning = false;

function keepAlivePrefs() {
  return { ...KEEPALIVE_DEFAULTS, ...(config.keepAlive ?? {}) };
}

async function notifyStatus(snapshot) {
  if (!snapshot.reachable) unreachableStreak += 1;
  else unreachableStreak = 0;
  const events = statusEvents(prevSnapshot, snapshot, { unreachableStreak, wasOfflineNotified: offlineNotified });
  for (const e of events) {
    const r = await notifier.handle(e);
    if (e.key === 'offline' && r.sent !== undefined) offlineNotified = true;
    if (e.key === 'online') offlineNotified = false;
  }
  prevSnapshot = snapshot;
}

async function keepAliveTick(summary) {
  const now = Date.now();
  const status = summary
    ? {
      reachable: true,
      state: summary.state,
      acceptingJobs: summary.acceptingJobs,
      supportCode: summary.supportCode ?? null,
      issues: summary.issues,
      maintenanceRunning: Boolean(summary.maintenance?.running),
      cassettePaper: Boolean(summary.trays?.find((t) => t.source === 'Cassette')?.size) && (summary.mediaReady?.length ?? 0) > 0,
      totalSheets: summary.totalSheets,
    }
    : { reachable: false, autoPowerOn: cachedAutoPowerOn };
  const state = observeActivity(config.keepAliveState ?? {}, status, now);
  const decision = decideKeepAlive({ now, state, status, prefs: keepAlivePrefs() });
  lastDecision = { at: new Date(now).toISOString(), ...decision };
  if (JSON.stringify(state) !== JSON.stringify(config.keepAliveState)) {
    config.keepAliveState = state;
    await saveConfig();
  }
  // Tell the user once per due period when it can't run for a reason they can fix.
  if (decision.due && !decision.run && /Auto power on|cassette|support code|error/.test(decision.reason)) {
    await notifier.handle({ category: 'keepalive', key: `keepalive-skip:${state.lastActivityAt}`, title: 'Keep-alive nozzle check skipped', message: decision.reason });
  }
  if (!decision.run || keepAliveRunning) return;
  keepAliveRunning = true;
  try {
    await runMaintenanceJobOnPrinter(config.host, 'nozzle-check');
    config.keepAliveState = { ...state, lastRunAt: now, lastActivityAt: now };
    await saveConfig();
    await history.add({ type: 'action', action: 'keepalive', result: 'nozzle check sent', reason: decision.reason });
    await notifier.handle({ category: 'keepalive', key: `keepalive:${now}`, title: 'Keep-alive nozzle check printed', message: `${decision.reason}. Check the page: every line should be complete.` });
  } catch (e) {
    await history.add({ type: 'action', action: 'keepalive', result: `failed: ${e.message}` });
    await notifier.handle({ category: 'keepalive', key: `keepalive-fail:${now}`, title: 'Keep-alive nozzle check failed', message: e.message });
  } finally {
    keepAliveRunning = false;
  }
}

async function poll() {
  let next = POLL_MS;
  if (config.host) {
    let summary = null;
    try {
      ({ summary } = await getStatus(config.host));
      await history.recordStatus(summary);
      if (summary.health === 'busy' || summary.state === 'processing') next = BUSY_POLL_MS;
    } catch (e) {
      await history.recordUnreachable(e.message);
    }
    try {
      await notifyStatus(summary
        ? { reachable: true, supportCode: summary.supportCode ?? null, supportLabel: summary.supportInfo?.category ?? null, inks: summary.inks }
        : { reachable: false });
      await keepAliveTick(summary);
    } catch (e) {
      console.error(`poll follow-up failed: ${e.message}`);
    }
  }
  setTimeout(poll, next).unref();
}

/** A larger preview of page 1 of a captured raster job. */
async function urfPreviewJpeg(doc) {
  const { mkdtemp, writeFile: wf, readFile: rf, rm: rmf } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'g5040-preview-'));
  try {
    await wf(join(dir, 'p.bmp'), urfFirstPageThumbnailBmp(doc, { maxWidth: 1240 }).bmp);
    await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', join(dir, 'p.bmp'), '--out', join(dir, 'p.jpg')]);
    return await rf(join(dir, 'p.jpg'));
  } finally {
    await rmf(dir, { recursive: true, force: true });
  }
}

async function recordCapturedJob(job) {
  let pages = null;
  let options = {};
  try {
    options = describeJobAttrs(job.jobAttrs);
  } catch { /* keep the job even if its settings can't be read */ }
  if (job.format === 'image/urf' && job.docPath) {
    try {
      const { open: openFile } = await import('node:fs/promises');
      const fh = await openFile(job.docPath, 'r');
      const head = Buffer.alloc(12);
      await fh.read(head, 0, 12, job.docOffset);
      await fh.close();
      pages = parseUrfHeader(head).pageCount;
    } catch { /* unknown page count */ }
  }
  const entry = await prints.add({
    name: job.name,
    source: 'mac',
    format: job.format,
    document: { path: job.docPath, offset: job.docOffset, length: job.docLength },
    jobAttrs: job.jobAttrs,
    options: { ...options, ...(pages ? { pages } : {}), user: job.user },
    result: { status: job.status, ok: job.ok, jobId: job.printerJobId },
  });
  await history.add({ type: 'action', action: 'mac-print', file: job.name, result: job.status, jobId: job.printerJobId, printId: entry.id });
  await notifier.handle(job.ok
    ? { category: 'job', key: `job:${entry.id}`, title: 'Sent to the printer', message: `"${job.name}"${pages ? `, ${pages} page${pages > 1 ? 's' : ''}` : ''}` }
    : { category: 'job', key: `job:${entry.id}`, title: 'Print job failed', message: `"${job.name}": ${job.status}` });
}

await history.load();
await prints.load();
await loadConfig();
notifier.prefs = { ...NOTIFY_DEFAULTS, ...(config.notifications ?? {}) };
if (config.host && LOOPBACK.test(config.host)) {
  console.error(`Ignoring loopback printer address ${config.host}`);
  config.host = null;
}
try {
  proxy = await startIppProxy({
    port: IPP_PORT,
    printerHost: () => config.host,
    spoolDir: join(DATA, 'spool'),
    managerUrl: `http://127.0.0.1:${PORT}/`,
    onJobForwarded: recordCapturedJob,
    onJobWaiting: (job) => notifier.handle({
      category: 'job',
      key: `waiting:${job.name}:${Math.floor(Date.now() / 60000)}`,
      title: 'Print job waiting',
      message: `"${job.name}" has waited ${Math.round(job.waitingMs / 60000)} minutes: the printer is busy or unreachable. It will print when the printer is back.`,
    }),
    log: (m) => console.log(`[capture] ${m}`),
  });
  console.log(`Capture printer on ${proxy.uri}`);
} catch (e) {
  proxyError = e.code === 'EADDRINUSE' ? `Port ${IPP_PORT} is already in use; Mac print capture is off. Set IPP_PORT to another port.` : e.message;
  console.error(`Capture printer not started: ${proxyError}`);
}
http.createServer(handle).listen(PORT, BIND, () => {
  console.log(`G5040 Manager on http://${BIND === '0.0.0.0' ? 'localhost' : BIND}:${PORT}  (printer: ${config.host ?? 'not configured'})`);
});
poll();
