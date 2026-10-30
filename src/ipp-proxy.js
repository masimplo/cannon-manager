// The capture printer: an IPP server on 127.0.0.1 that macOS prints to. Each job is spooled to
// disk, recorded, and forwarded to the real printer as a single Print-Job with the job settings
// copied byte-for-byte.
//
// Shaped by CUPS's ipp backend (Apple CUPS 2.3.x backend/ipp.c): it sends Validate-Job, then
// Create-Job + chunked Send-Document (because the printer advertises Create-Job), and polls
// Get-Job-Attributes. A server-error-internal-error reply makes CUPS pause the queue, so this
// never sends one: refusals end the job as aborted (CUPS drops it), busy is answered with
// server-error-busy (CUPS retries). The real printer aborts a Create-Job whose document takes over
// 60 s (multiple-operation-time-out), which is why jobs are spooled first and sent in one go.

import http from 'node:http';
import { createWriteStream, createReadStream } from 'node:fs';
import { open, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { decodeMessage, groupAttrs, scanMessage, rewriteAttributes, encodeResponse, encodeRequest, OP } from './ipp.js';

const S = {
  OK: 0x0000,
  NOT_FOUND: 0x0406,
  NOT_POSSIBLE: 0x0404,
  BAD_REQUEST: 0x0400,
  TOO_LARGE: 0x0409,
  OP_NOT_SUPPORTED: 0x0501,
  SERVICE_UNAVAILABLE: 0x0502,
  BUSY: 0x0507,
};
const RETRYABLE = new Set([0x0502, 0x0506, 0x0507]); // service-unavailable, not-accepting-jobs, busy
const JOB = { PENDING: 3, PROCESSING: 5, CANCELED: 7, ABORTED: 8, COMPLETED: 9 };
const TERMINAL = new Set([JOB.CANCELED, JOB.ABORTED, JOB.COMPLETED]);
const HEADER_PEEK = 256 * 1024;

function postToPrinter({ host, port }, body, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/ipp' };
    let length = 0;
    for (const part of body) length += part.length;
    headers['Content-Length'] = length;
    const req = http.request({ host, port, path: '/ipp/print', method: 'POST', headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => (res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`printer HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('printer timed out')));
    req.on('error', reject);
    (async () => {
      for (const part of body) {
        if (Buffer.isBuffer(part)) {
          if (!req.write(part)) await new Promise((r) => req.once('drain', r));
        } else {
          // { path, start, length }: stream a slice of a spool file
          for await (const chunk of createReadStream(part.path, { start: part.start, end: part.start + part.length - 1 })) {
            if (!req.write(chunk)) await new Promise((r) => req.once('drain', r));
          }
        }
      }
      req.end();
    })().catch((e) => req.destroy(e));
  });
}

export async function startIppProxy({
  port = 8631,
  bind = '127.0.0.1',
  printerHost,
  printerPort = 631,
  spoolDir,
  maxBodyBytes = 500 * 1024 * 1024,
  retryDelayMs = 10000,
  maxRetryMs = 24 * 60 * 60 * 1000, // a printer that is off overnight must not lose captured jobs
  pollMs = 3000,
  printerName = 'Canon G5040 (via Manager)',
  managerUrl = 'http://127.0.0.1:4280/',
  onJobForwarded = async () => {},
  log = () => {},
}) {
  await mkdir(spoolDir, { recursive: true });
  const printer = { get host() { return typeof printerHost === 'function' ? printerHost() : printerHost; }, port: printerPort };
  const jobs = new Map();
  let nextJobId = 1;
  const startedAt = Date.now();
  let selfUri = '';
  let uuid = '';

  const uptime = () => Math.floor((Date.now() - startedAt) / 1000);
  const jobUri = (id) => `${selfUri.replace(/\/ipp\/print$/, '')}/jobs/${id}`;

  function jobAttributes(job) {
    return [
      ['job-id', 'integer', job.id],
      ['job-uri', 'uri', jobUri(job.id)],
      ['job-printer-uri', 'uri', selfUri],
      ['job-name', 'name', job.name],
      ['job-originating-user-name', 'name', job.user],
      ['job-state', 'enum', job.state],
      ['job-state-reasons', 'keyword', job.reasons],
      ['job-impressions-completed', 'integer', job.impressions ?? 0],
      ['time-at-creation', 'integer', job.createdUptime],
      ...(job.message ? [['job-state-message', 'text', job.message]] : []),
    ];
  }

  function setState(job, state, reasons, message) {
    job.state = state;
    job.reasons = reasons;
    if (message !== undefined) job.message = message;
  }

  async function cleanupSpool(job) {
    if (job.spoolPath) await rm(job.spoolPath, { force: true });
    job.spoolPath = null;
  }

  async function record(job, result) {
    if (job.recorded) return;
    job.recorded = true;
    try {
      await onJobForwarded({
        name: job.name,
        user: job.user,
        format: job.format,
        docPath: job.spoolPath,
        docOffset: job.docOffset,
        docLength: job.docLength,
        jobAttrs: job.jobAttrs,
        ok: result.ok,
        status: result.status,
        printerJobId: job.printerJobId ?? null,
      });
    } catch (e) {
      log(`recording job ${job.id} failed: ${e.message}`);
    }
  }

  async function finish(job) {
    await cleanupSpool(job);
  }

  async function pollPrinterJob(job) {
    while (!TERMINAL.has(job.state)) {
      await new Promise((r) => setTimeout(r, pollMs));
      if (TERMINAL.has(job.state)) break;
      try {
        const res = decodeMessage(await postToPrinter(printer, [encodeRequest(OP.GET_JOB_ATTRIBUTES, 1, [
          ['printer-uri', 'uri', `ipp://${printer.host}:${printer.port}/ipp/print`],
          ['job-id', 'integer', job.printerJobId],
          ['requested-attributes', 'keyword', ['job-state', 'job-state-reasons', 'job-impressions-completed']],
        ])]));
        const j = groupAttrs(res, 'job');
        if (j['job-state']) setState(job, j['job-state'], [].concat(j['job-state-reasons'] ?? 'none'));
        if (typeof j['job-impressions-completed'] === 'number') job.impressions = j['job-impressions-completed'];
        if (res.statusCode === S.NOT_FOUND) setState(job, JOB.COMPLETED, ['job-completed-successfully']);
      } catch (e) {
        log(`polling printer job ${job.printerJobId}: ${e.message}`);
      }
    }
  }

  async function forward(job) {
    const started = Date.now();
    for (;;) {
      if (job.state === JOB.CANCELED) return finish(job);
      let status;
      let reply;
      try {
        const header = Buffer.concat([
          encodeRequest(OP.PRINT_JOB, 1, [
            ['printer-uri', 'uri', `ipp://${printer.host}:${printer.port}/ipp/print`],
            ['requesting-user-name', 'name', job.user],
            ['job-name', 'name', job.name],
            ['document-format', 'mimeMediaType', job.format],
          ]).subarray(0, -1), // drop the end tag; the raw job group follows
          job.jobAttrs,
          Buffer.from([0x03]),
        ]);
        reply = decodeMessage(await postToPrinter(printer, [header, { path: job.spoolPath, start: job.docOffset, length: job.docLength }], { timeoutMs: 120000 }));
        status = reply.statusCode;
      } catch (e) {
        status = S.SERVICE_UNAVAILABLE;
        log(`forwarding job ${job.id}: ${e.message}`);
      }

      if (status < 0x0100) {
        const j = groupAttrs(reply, 'job');
        job.printerJobId = j['job-id'];
        setState(job, j['job-state'] ?? JOB.PROCESSING, [].concat(j['job-state-reasons'] ?? 'job-printing'), '');
        await record(job, { ok: true, status: 'successful-ok' });
        await finish(job);
        return pollPrinterJob(job);
      }
      if (RETRYABLE.has(status) && Date.now() - started < maxRetryMs) {
        setState(job, JOB.PROCESSING, ['printer-busy'], 'Waiting for the printer');
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      const statusName = `0x${status.toString(16).padStart(4, '0')}`;
      setState(job, JOB.ABORTED, [status === 0x040a ? 'document-format-error' : 'aborted-by-system'], `Printer refused the job (${statusName})`);
      await record(job, { ok: false, status: `refused by printer (${statusName})` });
      return finish(job);
    }
  }

  // ---- request handling

  function reply(res, req, status, groups = [], operationAttrs = []) {
    const body = encodeResponse({ version: req.version, status, requestId: req.requestId }, groups, operationAttrs);
    res.writeHead(200, { 'Content-Type': 'application/ipp' });
    res.end(body);
  }

  async function passThrough(res, req, { rewriteReply = false } = {}) {
    const forwarded = rewriteAttributes(req.head, (v) =>
      v.groupTag === 0x01 && v.name === 'printer-uri' ? Buffer.from(`ipp://${printer.host}:${printer.port}/ipp/print`) : undefined,
    );
    let raw;
    try {
      raw = await postToPrinter(printer, [forwarded]);
    } catch (e) {
      log(`printer unreachable: ${e.message}`);
      return reply(res, req, S.SERVICE_UNAVAILABLE, [], [['status-message', 'text', 'The printer is not reachable right now']]);
    }
    let out = rewriteReply
      ? rewriteAttributes(raw, (v) => {
        if (v.groupTag !== 0x04) return undefined;
        switch (v.name) {
          case 'printer-uri-supported': return v.index === 0 ? Buffer.from(selfUri) : null;
          case 'uri-security-supported': return v.index === 0 ? Buffer.from('none') : null;
          case 'uri-authentication-supported': return v.index === 0 ? Buffer.from('none') : null;
          case 'printer-uuid': return Buffer.from(uuid);
          case 'printer-name': return Buffer.from(printerName);
          case 'printer-info': return Buffer.from(printerName);
          case 'printer-dns-sd-name': return Buffer.from(printerName);
          case 'compression-supported': return v.index === 0 ? Buffer.from('none') : null;
          // macOS's "printer web page" and supply buttons open the manager, not the printer's Remote UI.
          case 'printer-more-info': return Buffer.from(managerUrl);
          case 'printer-supply-info-uri': return Buffer.from(`${managerUrl}#overview`);
          default: return undefined;
        }
      })
      : Buffer.from(raw);
    out.writeUInt8(req.version[0], 0);
    out.writeUInt8(req.version[1], 1);
    out.writeUInt32BE(req.requestId, 4);
    if (out.readUInt16BE(2) === 0x0500) out.writeUInt16BE(S.SERVICE_UNAVAILABLE, 2);
    res.writeHead(200, { 'Content-Type': 'application/ipp' });
    res.end(out);
  }

  function findJob(op) {
    let id = op['job-id'];
    if (!id && op['job-uri']) id = Number(/\/jobs\/(\d+)$/.exec(op['job-uri'])?.[1]);
    return jobs.get(id) ?? null;
  }

  function newJob(op, jobAttrs) {
    const job = {
      id: nextJobId++,
      name: op['job-name'] ?? 'Untitled',
      user: op['requesting-user-name'] ?? 'unknown',
      state: JOB.PENDING,
      reasons: ['job-incoming'],
      createdUptime: uptime(),
      jobAttrs: jobAttrs ?? Buffer.from([0x02]),
      format: op['document-format'] ?? 'application/octet-stream',
    };
    jobs.set(job.id, job);
    // Keep the list bounded: forget finished jobs beyond the newest 200.
    if (jobs.size > 200) {
      for (const [id, j] of jobs) {
        if (jobs.size <= 200) break;
        if (TERMINAL.has(j.state)) jobs.delete(id);
      }
    }
    return job;
  }

  function attachDocument(job, req, op) {
    job.spoolPath = req.spoolPath;
    job.docOffset = req.dataOffset;
    job.docLength = req.size - req.dataOffset;
    job.format = op['document-format'] ?? job.format;
    req.keepSpool = true;
    setState(job, JOB.PROCESSING, ['job-queued']);
    forward(job).catch((e) => {
      log(`job ${job.id}: ${e.message}`);
      setState(job, JOB.ABORTED, ['aborted-by-system'], e.message);
    });
  }

  async function handle(req, res, ipp) {
    const op = groupAttrs(ipp.msg, 'operation');
    const rawJobGroup = () => {
      const g = ipp.scan.groups.find((x) => x.tag === 0x02);
      return g ? ipp.head.subarray(g.start, g.end) : Buffer.from([0x02]);
    };
    switch (ipp.msg.operation) {
      case OP.GET_PRINTER_ATTRIBUTES:
        return passThrough(res, ipp, { rewriteReply: true });
      case OP.VALIDATE_JOB:
      case OP.IDENTIFY_PRINTER:
        return passThrough(res, ipp);
      case OP.CREATE_JOB: {
        const job = newJob(op, Buffer.from(rawJobGroup()));
        return reply(res, ipp, S.OK, [[0x02, jobAttributes(job)]]);
      }
      case OP.SEND_DOCUMENT: {
        const job = findJob(op);
        if (!job) return reply(res, ipp, S.NOT_FOUND);
        if (job.state !== JOB.PENDING) return reply(res, ipp, S.NOT_POSSIBLE, [], [['status-message', 'text', 'Job already has a document']]);
        if (ipp.size - ipp.dataOffset === 0 && op['last-document']) {
          setState(job, JOB.ABORTED, ['aborted-by-system'], 'No document');
          return reply(res, ipp, S.OK, [[0x02, jobAttributes(job)]]);
        }
        attachDocument(job, ipp, op);
        return reply(res, ipp, S.OK, [[0x02, jobAttributes(job)]]);
      }
      case OP.PRINT_JOB: {
        const job = newJob(op, Buffer.from(rawJobGroup()));
        attachDocument(job, ipp, op);
        return reply(res, ipp, S.OK, [[0x02, jobAttributes(job)]]);
      }
      case OP.GET_JOB_ATTRIBUTES: {
        const job = findJob(op);
        return job ? reply(res, ipp, S.OK, [[0x02, jobAttributes(job)]]) : reply(res, ipp, S.NOT_FOUND);
      }
      case OP.GET_JOBS: {
        const which = op['which-jobs'] ?? 'not-completed';
        const list = [...jobs.values()].filter((j) => (which === 'completed' ? TERMINAL.has(j.state) : which === 'all' ? true : !TERMINAL.has(j.state)));
        return reply(res, ipp, S.OK, list.map((j) => [0x02, jobAttributes(j)]));
      }
      case OP.CANCEL_JOB: {
        const job = findJob(op);
        if (!job) return reply(res, ipp, S.NOT_FOUND);
        if (TERMINAL.has(job.state)) return reply(res, ipp, S.NOT_POSSIBLE);
        if (job.printerJobId) {
          postToPrinter(printer, [encodeRequest(OP.CANCEL_JOB, 1, [
            ['printer-uri', 'uri', `ipp://${printer.host}:${printer.port}/ipp/print`],
            ['job-id', 'integer', job.printerJobId],
            ['requesting-user-name', 'name', job.user],
          ])]).catch(() => {});
        }
        setState(job, JOB.CANCELED, ['job-canceled-by-user']);
        if (!job.recorded) await cleanupSpool(job);
        return reply(res, ipp, S.OK);
      }
      case OP.CLOSE_JOB:
        return reply(res, ipp, S.OK);
      default:
        return reply(res, ipp, S.OP_NOT_SUPPORTED);
    }
  }

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !(req.headers['content-type'] ?? '').startsWith('application/ipp')) {
      // A browser opening this printer's address ("Show Printer Web Page") lands in the manager.
      if (req.method === 'GET') {
        res.writeHead(302, { Location: managerUrl });
        return res.end();
      }
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      return res.end('IPP endpoint: POST application/ipp\n');
    }
    const spoolPath = join(spoolDir, `${randomUUID()}.ipp`);
    const ipp = { spoolPath, keepSpool: false };
    try {
      // Stream the whole request to disk: Send-Document bodies can be tens of MB.
      ipp.size = await new Promise((resolve, reject) => {
        let size = 0;
        const out = createWriteStream(spoolPath);
        req.on('data', (c) => {
          size += c.length;
          if (size > maxBodyBytes) {
            req.destroy();
            out.destroy();
            reject(Object.assign(new Error('too large'), { tooLarge: true }));
          }
        });
        req.on('error', reject);
        out.on('error', reject);
        out.on('finish', () => resolve(size));
        req.pipe(out);
      });
      const fh = await open(spoolPath, 'r');
      const peek = Buffer.alloc(Math.min(ipp.size, HEADER_PEEK));
      await fh.read(peek, 0, peek.length, 0);
      await fh.close();
      ipp.scan = scanMessage(peek);
      ipp.dataOffset = ipp.scan.dataOffset;
      ipp.head = peek.subarray(0, ipp.dataOffset);
      ipp.msg = decodeMessage(ipp.head);
      ipp.version = [peek[0], peek[1]];
      ipp.requestId = ipp.msg.requestId;
      await handle(req, res, ipp);
    } catch (e) {
      log(`request failed: ${e.message}`);
      if (!res.headersSent) {
        // Still a valid IPP reply, and never server-error-internal-error.
        const head = { version: [1, 1], requestId: 0 };
        try {
          const peek = ipp.head ?? Buffer.alloc(0);
          if (peek.length >= 8) Object.assign(head, { version: [peek[0], peek[1]], requestId: peek.readUInt32BE(4) });
        } catch { /* keep defaults */ }
        reply(res, head, e.tooLarge ? S.TOO_LARGE : S.BAD_REQUEST);
      }
    } finally {
      if (!ipp.keepSpool) await rm(spoolPath, { force: true });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, resolve);
  });
  const actualPort = server.address().port;
  selfUri = `ipp://127.0.0.1:${actualPort}/ipp/print`;
  // Stable, but different from the real printer's, so macOS never merges the two.
  const h = createHash('sha256').update(`g5040-manager:${actualPort}`).digest('hex');
  uuid = `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;

  return {
    port: actualPort,
    uri: selfUri,
    jobs,
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(r);
    }),
  };
}

