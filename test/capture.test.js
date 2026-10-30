import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRequest, decodeMessage, groupAttrs, scanMessage, OP } from '../src/ipp.js';
import { describeJobAttrs, buildRawPrintJob } from '../src/capture.js';

// A job-attributes group shaped like the one macOS's CUPS sends (ppd-cache.c _cupsConvertOptions):
// copies, sides, colour mode, quality, and media-col with a media-size collection.
function macJobGroup({ copies = 2 } = {}) {
  const attr = (tag, name, value) => {
    const n = Buffer.from(name);
    const v = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    const h = Buffer.alloc(3);
    h.writeUInt8(tag, 0);
    h.writeUInt16BE(n.length, 1);
    const l = Buffer.alloc(2);
    l.writeUInt16BE(v.length);
    return Buffer.concat([h, n, l, v]);
  };
  const int = (n) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    return b;
  };
  return Buffer.concat([
    Buffer.from([0x02]),
    attr(0x21, 'copies', int(copies)),
    attr(0x44, 'sides', 'two-sided-long-edge'),
    attr(0x44, 'print-color-mode', 'monochrome'),
    attr(0x23, 'print-quality', int(5)),
    attr(0x34, 'media-col', Buffer.alloc(0)),
    attr(0x4a, '', 'media-size'),
    attr(0x34, '', Buffer.alloc(0)),
    attr(0x4a, '', 'x-dimension'),
    attr(0x21, '', int(21000)),
    attr(0x4a, '', 'y-dimension'),
    attr(0x21, '', int(29700)),
    attr(0x37, '', Buffer.alloc(0)),
    attr(0x4a, '', 'media-source'),
    attr(0x44, '', 'main'),
    attr(0x37, '', Buffer.alloc(0)),
  ]);
}

test('describes the settings macOS sent in plain options for the history list', () => {
  assert.deepEqual(describeJobAttrs(macJobGroup()), {
    copies: 2,
    sides: 'two-sided-long-edge',
    colorMode: 'monochrome',
    quality: 5,
    media: 'iso_a4_210x297mm',
    source: 'main',
  });
});

test('raw re-print keeps every original setting byte-for-byte and only swaps copies', () => {
  const doc = Buffer.from('UNIRAST\0....');
  const body = buildRawPrintJob({ host: '192.168.1.178', name: 'Report', user: 'masimplo', format: 'image/urf', jobAttrs: macJobGroup({ copies: 2 }), document: doc, copies: 4 });
  const msg = decodeMessage(body);
  assert.equal(msg.operation, OP.PRINT_JOB);
  const op = groupAttrs(msg, 'operation');
  assert.equal(op['printer-uri'], 'ipp://192.168.1.178:631/ipp/print');
  assert.equal(op['document-format'], 'image/urf');
  assert.equal(op['job-name'], 'Report');
  const job = groupAttrs(msg, 'job');
  assert.equal(job.copies, 4);
  assert.equal(job.sides, 'two-sided-long-edge');
  assert.deepEqual(job['media-col'], { 'media-size': { 'x-dimension': 21000, 'y-dimension': 29700 }, 'media-source': 'main' });
  assert.deepEqual(msg.data, doc);
});

test('raw re-print without a copies override sends the original group unchanged', () => {
  const group = macJobGroup({ copies: 3 });
  const body = buildRawPrintJob({ host: 'h', name: 'n', user: 'u', format: 'image/urf', jobAttrs: group, document: Buffer.from('D') });
  const g = scanMessage(body).groups.find((x) => x.tag === 0x02);
  assert.deepEqual(body.subarray(g.start, g.end), group);
});

test('copies can be added when the original job had none', () => {
  const body = buildRawPrintJob({ host: 'h', name: 'n', user: 'u', format: 'image/urf', jobAttrs: Buffer.from([0x02]), document: Buffer.from('D'), copies: 2 });
  assert.equal(groupAttrs(decodeMessage(body), 'job').copies, 2);
});

test('nothing in a describe call is guessed: unknown paper sizes are reported in millimetres', () => {
  const unknown = encodeRequest(OP.PRINT_JOB, 1, [], [['copies', 'integer', 1]]);
  const g = scanMessage(unknown).groups.find((x) => x.tag === 0x02);
  assert.deepEqual(describeJobAttrs(unknown.subarray(g.start, g.end)), { copies: 1 });
});

test('withCopies returns just the job group, which describes the same settings with the new count', async () => {
  const { withCopies } = await import('../src/capture.js');
  const g = withCopies(macJobGroup({ copies: 2 }), 7);
  assert.equal(g[0], 0x02);
  assert.deepEqual(describeJobAttrs(g), { ...describeJobAttrs(macJobGroup()), copies: 7 });
});
