import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeRequest, decodeMessage, groupAttrs, OP } from '../src/ipp.js';

// Real Get-Printer-Attributes response captured from the G5040 on 2026-10-30
// while it was running a cleaning cycle (state processing, spool-area-full-report).
const fixture = readFileSync(new URL('./fixtures/get-printer-attributes.bin', import.meta.url));

test('decodes the real printer response: status, ink levels and firmware', () => {
  const msg = decodeMessage(fixture);
  const p = msg.groups.find((g) => g.tag === 'printer').attrs;

  assert.equal(msg.statusCode, 0x0000);
  assert.equal(p['printer-state'], 4); // processing
  assert.deepEqual(p['printer-state-reasons'], 'spool-area-full-report');
  assert.equal(p['printer-is-accepting-jobs'], false);
  assert.deepEqual(p['marker-names'], ['Black(PGBK)', 'Cyan', 'Magenta', 'Yellow']);
  assert.deepEqual(p['marker-levels'], [80, 50, 50, 60]);
  assert.deepEqual(p['marker-low-levels'], [15, 15, 15, 15]);
  assert.equal(p['printer-firmware-string-version'], '1.060');
  assert.deepEqual(p['printer-resolution-supported'], { x: 600, y: 600, units: 'dpi' });
  assert.deepEqual(p['media-source-supported'], ['auto', 'main', 'rear']);
});

test('an encoded request decodes back to the same operation, id and attributes', () => {
  const buf = encodeRequest(OP.PRINT_JOB, 42, [
    ['printer-uri', 'uri', 'ipp://192.168.1.178:631/ipp/print'],
    ['requesting-user-name', 'name', 'tester'],
    ['document-format', 'mimeMediaType', 'image/jpeg'],
    ['requested-attributes', 'keyword', ['printer-state', 'marker-levels']],
  ], [
    ['copies', 'integer', 3],
    ['print-color-mode', 'keyword', 'monochrome'],
    ['ipp-attribute-fidelity', 'boolean', false],
  ], Buffer.from('DOC'));

  const msg = decodeMessage(buf);
  assert.equal(msg.operation, OP.PRINT_JOB);
  assert.equal(msg.requestId, 42);
  const op = msg.groups.find((g) => g.tag === 'operation').attrs;
  assert.equal(op['attributes-charset'], 'utf-8');
  assert.equal(op['printer-uri'], 'ipp://192.168.1.178:631/ipp/print');
  assert.deepEqual(op['requested-attributes'], ['printer-state', 'marker-levels']);
  const job = msg.groups.find((g) => g.tag === 'job').attrs;
  assert.deepEqual(job, { copies: 3, 'print-color-mode': 'monochrome', 'ipp-attribute-fidelity': false });
  assert.equal(msg.data.toString(), 'DOC');
});

test('rejects a truncated response instead of returning partial attributes', () => {
  assert.throws(() => decodeMessage(fixture.subarray(0, 300)), /truncated/i);
});

test('scanMessage finds the exact bytes of each attribute group and where the document starts', async () => {
  const { scanMessage } = await import('../src/ipp.js');
  const buf = encodeRequest(OP.CREATE_JOB ?? 0x0005, 9, [['printer-uri', 'uri', 'ipp://x/ipp/print']], [['copies', 'integer', 2], ['sides', 'keyword', 'two-sided-long-edge']], Buffer.from('DOCUMENT'));
  const scan = scanMessage(buf);
  const job = scan.groups.find((g) => g.tag === 0x02);
  const jobBytes = buf.subarray(job.start, job.end);
  assert.equal(jobBytes[0], 0x02);
  // The raw job group re-decodes to the same attributes when spliced into another message.
  const rebuilt = Buffer.concat([buf.subarray(0, job.start), jobBytes, Buffer.from([0x03])]);
  assert.deepEqual(decodeMessage(rebuilt).groups.find((g) => g.tag === 'job').attrs, { copies: 2, sides: 'two-sided-long-edge' });
  assert.equal(buf.subarray(scan.dataOffset).toString(), 'DOCUMENT');
});

test('rewriteAttributes replaces and drops values, keeping multi-value attributes valid', async () => {
  const { rewriteAttributes } = await import('../src/ipp.js');
  const fixtureMsg = fixture;
  const out = rewriteAttributes(fixtureMsg, ({ name, index }) => {
    if (name === 'printer-uri-supported') return index === 0 ? Buffer.from('ipp://127.0.0.1:8631/ipp/print') : null;
    if (name === 'uri-security-supported') return index === 0 ? Buffer.from('none') : null;
    if (name === 'printer-name') return Buffer.from('G5040 via Manager');
    return undefined;
  });
  const before = groupAttrs(decodeMessage(fixtureMsg), 'printer');
  const after = groupAttrs(decodeMessage(out), 'printer');
  assert.equal(after['printer-uri-supported'], 'ipp://127.0.0.1:8631/ipp/print');
  assert.equal(after['uri-security-supported'], 'none');
  assert.equal(after['printer-name'], 'G5040 via Manager');
  // Everything else is byte-for-byte the same attributes.
  for (const k of Object.keys(before)) if (!['printer-uri-supported', 'uri-security-supported', 'printer-name'].includes(k)) assert.deepEqual(after[k], before[k], k);
});

test('dropping the first value of a multi-value attribute gives the name to the next value', async () => {
  const { rewriteAttributes } = await import('../src/ipp.js');
  const buf = encodeRequest(0x000b, 1, [['requested-attributes', 'keyword', ['a', 'b', 'c']]]);
  const out = rewriteAttributes(buf, ({ name, value }) => (name === 'requested-attributes' && value.toString() === 'a' ? null : undefined));
  assert.deepEqual(groupAttrs(decodeMessage(out), 'operation')['requested-attributes'], ['b', 'c']);
});

test('encodeResponse echoes version and request id and carries status and typed attributes', async () => {
  const { encodeResponse } = await import('../src/ipp.js');
  const buf = encodeResponse({ version: [2, 0], status: 0x0507, requestId: 77 }, [
    [0x02, [['job-id', 'integer', 5], ['job-state', 'enum', 3], ['job-state-reasons', 'keyword', ['job-incoming']], ['job-uri', 'uri', 'ipp://127.0.0.1:8631/jobs/5']]],
  ]);
  const msg = decodeMessage(buf);
  assert.equal(msg.version, '2.0');
  assert.equal(msg.statusCode, 0x0507);
  assert.equal(msg.requestId, 77);
  assert.equal(groupAttrs(msg, 'operation')['attributes-charset'], 'utf-8');
  assert.deepEqual(groupAttrs(msg, 'job'), { 'job-id': 5, 'job-state': 3, 'job-state-reasons': 'job-incoming', 'job-uri': 'ipp://127.0.0.1:8631/jobs/5' });
});
