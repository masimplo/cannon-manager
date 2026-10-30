import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeRequest, decodeMessage, OP } from '../src/ipp.js';

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
