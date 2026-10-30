import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDeviceStatus, parsePrintStatus, decodeChunked } from '../src/chmp.js';

// Real IVEC GetStatus responses from the G5040 over CHMP, captured 2026-10-30 while idle.
const device = readFileSync(new URL('./fixtures/chmp-status-device.xml', import.meta.url), 'utf8');
const print = readFileSync(new URL('./fixtures/chmp-status-print.xml', import.meta.url), 'utf8');

test('device status: sheet counters per paper source and print head replacements', () => {
  const s = parseDeviceStatus(device);
  assert.equal(s.response, 'OK');
  assert.deepEqual(s.sheetsFed, { 'Rear tray': 19, Cassette: 5821 });
  assert.equal(s.totalSheets, 5840);
  assert.deepEqual(s.headReplacements, { Black: 1, Color: 1 });
  assert.equal(s.interfaces.find((i) => i.id === 'wired0').mac, '00:00:5E:00:53:01');
});

test('print status: state, paper per tray, ink and Canon support code', () => {
  const s = parsePrintStatus(print);
  assert.equal(s.response, 'OK');
  assert.equal(s.status, 'idle');
  assert.equal(s.supportCode, null);
  assert.deepEqual(s.trays, [
    { source: 'Rear tray', size: 'iso_a4_210x297mm', type: 'custom-media-type-canon-6' },
    { source: 'Cassette', size: 'iso_a4_210x297mm', type: 'stationery' },
  ]);
  assert.deepEqual(s.inks.map((i) => [i.color, i.level]), [['PGBK', 60], ['C', 30], ['M', 30], ['Y', 30]]);
});

test('a support code and status detail are surfaced when the printer reports an error', () => {
  const err = print
    .replace('<ivec:status>idle</ivec:status>', '<ivec:status>error</ivec:status>')
    .replace('<ivec:current_support_code/>', '<ivec:current_support_code>1000</ivec:current_support_code>')
    .replace('<ivec:status_detail/>', '<ivec:status_detail>media_empty</ivec:status_detail>');
  const s = parsePrintStatus(err);
  assert.equal(s.status, 'error');
  assert.equal(s.supportCode, '1000');
  assert.equal(s.statusDetail, 'media_empty');
});

test('decodes an HTTP chunked body the printer sends', () => {
  const body = Buffer.from('5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n');
  assert.equal(decodeChunked(body).toString(), 'hello world');
});
