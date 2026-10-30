import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { History } from '../src/history.js';

let dir;
beforeEach(async () => (dir = await mkdtemp(join(tmpdir(), 'history-'))));
afterEach(() => rm(dir, { recursive: true, force: true }));

const base = {
  state: 'idle', headline: 'Ready to print', health: 'ok', acceptingJobs: true, issues: [],
  inks: [{ name: 'Cyan', level: 30 }],
  raw: { ippState: 3, ippReasons: ['none'], remoteUiCode: '0', chmpStatus: 'idle', chmpStatusDetail: null, supportCode: null, maintenance: null, totalSheets: 5840 },
};

test('a change in any raw printer signal is logged even when the headline stays the same', async () => {
  // An ink flush started from the panel left the headline at "Ready to print" on 2026-10-30;
  // the raw signals are what can reveal it next time.
  const h = new History(join(dir, 'h.jsonl'));
  await h.load();
  assert.ok(await h.recordStatus(base));
  assert.equal(await h.recordStatus(base), null, 'identical sample is not logged twice');
  const flushing = { ...base, raw: { ...base.raw, chmpStatus: 'busying', chmpStatusDetail: 'DeviceBusy' } };
  const e = await h.recordStatus(flushing);
  assert.ok(e, 'raw-only change is logged');
  assert.equal(e.raw.chmpStatus, 'busying');

  const lines = (await readFile(join(dir, 'h.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).raw.chmpStatusDetail, 'DeviceBusy');
});

test('the sheet counter going up is logged, so prints from any source show in the timeline', async () => {
  const h = new History(join(dir, 'h.jsonl'));
  await h.load();
  await h.recordStatus(base);
  const e = await h.recordStatus({ ...base, raw: { ...base.raw, totalSheets: 5843 } });
  assert.equal(e.raw.totalSheets, 5843);
});
