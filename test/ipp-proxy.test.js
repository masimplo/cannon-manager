// End-to-end tests of the capture printer: a fake printer speaks IPP on a random port, the proxy
// sits in front of it, and requests are shaped like the ones macOS's CUPS ipp backend sends
// (Validate-Job, Create-Job, chunked Send-Document, Get-Job-Attributes polling).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeRequest, encodeResponse, decodeMessage, groupAttrs, scanMessage, OP } from '../src/ipp.js';
import { startIppProxy } from '../src/ipp-proxy.js';

const GPA_FIXTURE = readFileSync(new URL('./fixtures/get-printer-attributes.bin', import.meta.url));

let dir;
let printer; // fake printer
let proxy;
let received; // requests the fake printer got
let printerBehaviour;
let recorded; // what the proxy handed to the print history

function fakePrinter() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const msg = decodeMessage(body);
        received.push({ msg, body });
        const reply = (status, groups = []) => {
          res.writeHead(200, { 'Content-Type': 'application/ipp' });
          res.end(encodeResponse({ version: [2, 0], status, requestId: msg.requestId }, groups));
        };
        if (msg.operation === OP.GET_PRINTER_ATTRIBUTES) {
          const b = Buffer.from(GPA_FIXTURE);
          b.writeUInt32BE(msg.requestId, 4);
          res.writeHead(200, { 'Content-Type': 'application/ipp' });
          return res.end(b);
        }
        if (msg.operation === OP.VALIDATE_JOB) return reply(0);
        if (msg.operation === OP.PRINT_JOB) {
          const status = printerBehaviour.printJob.shift() ?? 0;
          if (status !== 0) return reply(status);
          return reply(0, [[0x02, [['job-id', 'integer', 41], ['job-state', 'enum', 5], ['job-state-reasons', 'keyword', 'job-printing']]]]);
        }
        if (msg.operation === OP.GET_JOB_ATTRIBUTES) {
          const state = printerBehaviour.jobStates.shift() ?? 9;
          return reply(0, [[0x02, [['job-id', 'integer', 41], ['job-state', 'enum', state], ['job-state-reasons', 'keyword', state === 9 ? 'job-completed-successfully' : 'job-printing'], ['job-impressions-completed', 'integer', state === 9 ? 2 : 0]]]]);
        }
        return reply(0x0501);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ipp-proxy-'));
  received = [];
  recorded = [];
  printerBehaviour = { printJob: [], jobStates: [] };
  printer = await fakePrinter();
  proxy = await startIppProxy({
    port: 0,
    printerHost: '127.0.0.1',
    printerPort: printer.address().port,
    spoolDir: dir,
    retryDelayMs: 20,
    pollMs: 10,
    onJobForwarded: async (job) => recorded.push(job),
  });
});

afterEach(async () => {
  await proxy.close();
  await new Promise((r) => printer.close(r));
  await rm(dir, { recursive: true, force: true });
});

function post(body, { chunked = false, version = [2, 0] } = {}) {
  body.writeUInt8(version[0], 0);
  body.writeUInt8(version[1], 1);
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/ipp', ...(chunked ? {} : { 'Content-Length': body.length }) };
    const req = http.request({ host: '127.0.0.1', port: proxy.port, path: '/ipp/print', method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(decodeMessage(Buffer.concat(chunks))));
    });
    req.on('error', reject);
    if (chunked) {
      // Send in several pieces like CUPS does for Send-Document.
      for (let i = 0; i < body.length; i += 1000) req.write(body.subarray(i, i + 1000));
      req.end();
    } else req.end(body);
  });
}

const PROXY_URI = () => `ipp://127.0.0.1:${proxy.port}/ipp/print`;
const URF_DOC = Buffer.concat([Buffer.from('UNIRAST\0'), Buffer.from([0, 0, 0, 1]), Buffer.alloc(5000, 7)]);

async function createAndSend({ doc = URF_DOC, format = 'image/urf' } = {}) {
  const create = await post(encodeRequest(OP.CREATE_JOB, 1, [
    ['printer-uri', 'uri', PROXY_URI()],
    ['requesting-user-name', 'name', 'masimplo'],
    ['job-name', 'name', 'Quarterly report'],
  ], [['copies', 'integer', 2], ['sides', 'keyword', 'two-sided-long-edge'], ['print-color-mode', 'keyword', 'monochrome']]));
  const jobId = groupAttrs(create, 'job')['job-id'];
  const send = await post(encodeRequest(OP.SEND_DOCUMENT, 2, [
    ['printer-uri', 'uri', PROXY_URI()],
    ['job-id', 'integer', jobId],
    ['requesting-user-name', 'name', 'masimplo'],
    ['document-format', 'mimeMediaType', format],
    ['last-document', 'boolean', true],
  ], [], doc), { chunked: true });
  return { create, send, jobId };
}

async function jobState(jobId) {
  const r = await post(encodeRequest(OP.GET_JOB_ATTRIBUTES, 3, [['printer-uri', 'uri', PROXY_URI()], ['job-id', 'integer', jobId]]));
  return groupAttrs(r, 'job');
}

async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 15));
  }
}

test('printer attributes are the real printer\'s, re-pointed at the proxy so macOS prints through it', async () => {
  const r = await post(encodeRequest(OP.GET_PRINTER_ATTRIBUTES, 5, [['printer-uri', 'uri', PROXY_URI()], ['requested-attributes', 'keyword', ['all', 'media-col-database']]]));
  const p = groupAttrs(r, 'printer');
  assert.equal(r.statusCode, 0);
  assert.equal(r.requestId, 5);
  assert.equal(p['printer-uri-supported'], PROXY_URI());
  assert.equal(p['uri-security-supported'], 'none');
  assert.notEqual(p['printer-uuid'], 'urn:uuid:00000000-0000-1000-8000-000000000001', 'distinct uuid so macOS never merges it with the real printer');
  assert.deepEqual(p['marker-levels'], [80, 50, 50, 60], 'ink levels pass through');
  assert.deepEqual(p['document-format-supported'], ['application/octet-stream', 'image/jpeg', 'image/urf', 'image/pwg-raster']);
  assert.equal(p['compression-supported'], 'none');
  // The forwarded request targeted the real printer's URI, not the proxy's.
  assert.match(groupAttrs(received[0].msg, 'operation')['printer-uri'], /^ipp:\/\/127\.0\.0\.1:\d+\/ipp\/print$/);
  assert.notEqual(groupAttrs(received[0].msg, 'operation')['printer-uri'], PROXY_URI());
});

test('a Mac job is spooled, forwarded as one Print-Job with the job settings byte-for-byte, and recorded', async () => {
  printerBehaviour.jobStates = [5, 9];
  const { create, send, jobId } = await createAndSend();
  assert.equal(create.statusCode, 0);
  assert.equal(send.statusCode, 0);

  const done = await waitFor(async () => {
    const j = await jobState(jobId);
    return j['job-state'] === 9 && j;
  });
  assert.equal(done['job-impressions-completed'], 2);

  const printJob = received.find((r) => r.msg.operation === OP.PRINT_JOB);
  assert.ok(printJob, 'forwarded as Print-Job');
  assert.equal(received.filter((r) => r.msg.operation === OP.CREATE_JOB).length, 0, 'never Create-Job on the printer (60 s multi-operation timeout)');
  const op = groupAttrs(printJob.msg, 'operation');
  assert.equal(op['document-format'], 'image/urf');
  assert.equal(op['job-name'], 'Quarterly report');
  assert.equal(op['requesting-user-name'], 'masimplo');
  assert.deepEqual(groupAttrs(printJob.msg, 'job'), { copies: 2, sides: 'two-sided-long-edge', 'print-color-mode': 'monochrome' });
  assert.deepEqual(printJob.msg.data, URF_DOC, 'document forwarded unchanged');

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].name, 'Quarterly report');
  assert.equal(recorded[0].format, 'image/urf');
  assert.equal(recorded[0].ok, true);
  const jobGroup = scanMessage(printJob.body).groups.find((g) => g.tag === 0x02);
  assert.deepEqual(recorded[0].jobAttrs, printJob.body.subarray(jobGroup.start, jobGroup.end), 'raw job settings kept for re-print');
});

test('a busy printer is retried instead of failing the Mac job', async () => {
  printerBehaviour.printJob = [0x0507, 0x0506];
  const { jobId } = await createAndSend();
  await waitFor(async () => (await jobState(jobId))['job-state'] === 9);
  assert.equal(received.filter((r) => r.msg.operation === OP.PRINT_JOB).length, 3);
});

test('a refused job ends as aborted (so macOS drops it without pausing the queue) and is still recorded', async () => {
  printerBehaviour.printJob = [0x040a]; // document-format-not-supported
  const { jobId } = await createAndSend();
  const j = await waitFor(async () => {
    const s = await jobState(jobId);
    return s['job-state'] === 8 && s;
  });
  assert.ok([].concat(j['job-state-reasons']).some((r) => /aborted|document-format/.test(r)));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].ok, false);
});

test('never answers with server-error-internal-error, which would pause the macOS queue', async () => {
  // Unknown job id, garbage operation and an unreachable printer must not produce 0x0500.
  const unknown = await post(encodeRequest(OP.GET_JOB_ATTRIBUTES, 9, [['printer-uri', 'uri', PROXY_URI()], ['job-id', 'integer', 999]]));
  assert.notEqual(unknown.statusCode, 0x0500);
  const weird = await post(encodeRequest(0x4001, 10, [['printer-uri', 'uri', PROXY_URI()]]));
  assert.notEqual(weird.statusCode, 0x0500);
  await new Promise((r) => printer.close(r));
  const gpa = await post(encodeRequest(OP.GET_PRINTER_ATTRIBUTES, 11, [['printer-uri', 'uri', PROXY_URI()]]));
  assert.notEqual(gpa.statusCode, 0x0500);
  assert.ok(gpa.statusCode >= 0x0500, 'reported as a server-side retryable error');
  printer = await fakePrinter(); // so afterEach can close it
});

test('replies use the request\'s IPP version (CUPS falls back to 1.1)', async () => {
  const r = await post(encodeRequest(OP.GET_JOBS, 4, [['printer-uri', 'uri', PROXY_URI()]]), { version: [1, 1] });
  assert.equal(r.version, '1.1');
});

test('Get-Jobs lists the proxy\'s own jobs and Cancel-Job cancels one that has not been forwarded', async () => {
  const create = await post(encodeRequest(OP.CREATE_JOB, 1, [['printer-uri', 'uri', PROXY_URI()], ['requesting-user-name', 'name', 'masimplo'], ['job-name', 'name', 'draft']]));
  const jobId = groupAttrs(create, 'job')['job-id'];
  const jobs = await post(encodeRequest(OP.GET_JOBS, 2, [['printer-uri', 'uri', PROXY_URI()], ['which-jobs', 'keyword', 'not-completed']]));
  assert.ok(jobs.groups.some((g) => g.tag === 'job' && g.attrs['job-id'] === jobId));
  const cancel = await post(encodeRequest(OP.CANCEL_JOB, 3, [['printer-uri', 'uri', PROXY_URI()], ['job-id', 'integer', jobId]]));
  assert.equal(cancel.statusCode, 0);
  assert.equal((await jobState(jobId))['job-state'], 7);
  assert.equal(received.filter((r) => r.msg.operation === OP.PRINT_JOB).length, 0);
});
