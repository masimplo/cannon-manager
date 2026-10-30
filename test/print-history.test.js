import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrintHistory } from '../src/print-history.js';

let dir;
let clock;
// Thumbnails come from sips in production; here a fake keeps the test fast and deterministic.
const fakeThumb = async (jpeg) => Buffer.concat([Buffer.from('thumb:'), jpeg]);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'print-history-'));
  clock = Date.parse('2026-10-30T10:00:00Z');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function store(limit) {
  return new PrintHistory(dir, { limit, makeThumbnail: fakeThumb, now: () => new Date(clock++ * 1) });
}

test('a print is stored with its exact document, thumbnail and settings, and survives a restart', async () => {
  const h = store(30);
  await h.load();
  const entry = await h.add({ name: 'invoice.png', jpeg: Buffer.from('JPEGDATA'), options: { copies: 2, media: 'iso_a4_210x297mm' }, result: { status: 'successful-ok', jobId: 7 } });

  const reopened = store(30);
  await reopened.load();
  const [e] = reopened.list();
  assert.equal(e.id, entry.id);
  assert.equal(e.name, 'invoice.png');
  assert.deepEqual(e.options, { copies: 2, media: 'iso_a4_210x297mm' });
  assert.equal(e.status, 'successful-ok');
  assert.equal(e.jobId, 7);
  assert.deepEqual(await reopened.document(e.id), Buffer.from('JPEGDATA'));
  assert.deepEqual(await reopened.thumbnail(e.id), Buffer.from('thumb:JPEGDATA'));
});

test('keeps only the newest N prints and deletes the files of the ones dropped', async () => {
  const h = store(3);
  await h.load();
  for (let i = 1; i <= 5; i++) await h.add({ name: `p${i}.jpg`, jpeg: Buffer.from(`D${i}`), options: {}, result: { status: 'successful-ok' } });

  assert.deepEqual(h.list().map((e) => e.name), ['p5.jpg', 'p4.jpg', 'p3.jpg']);
  const files = await readdir(dir);
  assert.equal(files.filter((f) => f.endsWith('.jpg')).length, 3 * 2, 'document + thumbnail for each kept print only');
  const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
  assert.equal(index.length, 3);
});

test('a re-print is recorded as a new entry that points back to the original', async () => {
  const h = store(30);
  await h.load();
  const first = await h.add({ name: 'photo.jpg', jpeg: Buffer.from('X'), options: { copies: 1 }, result: { status: 'successful-ok' } });
  const again = await h.add({ name: 'photo.jpg', jpeg: await h.document(first.id), options: { copies: 3 }, result: { status: 'successful-ok' }, reprintOf: first.id });

  assert.deepEqual(h.list().map((e) => e.id), [again.id, first.id]);
  assert.equal(again.reprintOf, first.id);
  assert.deepEqual(await h.document(again.id), Buffer.from('X'));
});

test('a failed print is kept, so it can be retried', async () => {
  const h = store(30);
  await h.load();
  const e = await h.add({ name: 'doc.pdf', jpeg: Buffer.from('Y'), options: {}, result: { status: 'server-error-not-accepting-jobs', ok: false } });
  assert.equal(h.get(e.id).ok, false);
});

test('delete removes the entry and its files', async () => {
  const h = store(30);
  await h.load();
  const e = await h.add({ name: 'a.jpg', jpeg: Buffer.from('A'), options: {}, result: { status: 'successful-ok' } });
  assert.equal(await h.remove(e.id), true);
  assert.deepEqual(h.list(), []);
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.jpg')), []);
  assert.equal(await h.remove(e.id), false);
});

test('ids that are not ours never reach the filesystem', async () => {
  const h = store(30);
  await h.load();
  assert.equal(h.get('../../config'), null);
  await assert.rejects(h.document('../index'), /not found/i);
  assert.equal(await h.remove('../index'), false);
});

test('a Mac job is stored from a slice of the spool file with its format, raw job settings and source', async () => {
  const { writeFile } = await import('node:fs/promises');
  const spool = join(dir, 'spool.ipp');
  await writeFile(spool, Buffer.concat([Buffer.from('IPPHEADER'), Buffer.from('URFDATA')]));
  const thumbs = [];
  const h = new PrintHistory(join(dir, 'h'), { makeThumbnail: async (doc, format) => (thumbs.push(format), Buffer.from('T')) });
  await h.load();
  const e = await h.add({
    name: 'Quarterly report', source: 'mac', format: 'image/urf',
    document: { path: spool, offset: 9, length: 7 },
    jobAttrs: Buffer.from([0x02, 0x21, 0x00, 0x06]),
    options: {}, result: { status: 'successful-ok', jobId: 41 },
  });
  assert.equal(e.source, 'mac');
  assert.equal(e.format, 'image/urf');
  assert.deepEqual(await h.document(e.id), Buffer.from('URFDATA'));
  assert.deepEqual(await h.jobAttributes(e.id), Buffer.from([0x02, 0x21, 0x00, 0x06]));
  assert.deepEqual(thumbs, ['image/urf']);
});

test('history is also capped by total size, dropping the oldest prints first', async () => {
  const h = new PrintHistory(join(dir, 'h'), { limit: 30, maxBytes: 25, makeThumbnail: fakeThumb });
  await h.load();
  for (let i = 1; i <= 4; i++) await h.add({ name: `p${i}`, jpeg: Buffer.alloc(10, i), options: {}, result: { status: 'successful-ok' } });
  // 10 bytes each: only the newest two fit under 25 bytes.
  assert.deepEqual(h.list().map((e) => e.name), ['p4', 'p3']);
});

test('the newest print is kept even if it alone exceeds the size cap', async () => {
  const h = new PrintHistory(join(dir, 'h'), { maxBytes: 5, makeThumbnail: fakeThumb });
  await h.load();
  await h.add({ name: 'big', jpeg: Buffer.alloc(50), options: {}, result: { status: 'successful-ok' } });
  assert.deepEqual(h.list().map((e) => e.name), ['big']);
});
