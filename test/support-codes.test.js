import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lookupSupportCode, SUPPORT_CODE_INDEX_URL } from '../src/support-codes.js';

const entries = JSON.parse(readFileSync(new URL('../src/support-codes.json', import.meta.url), 'utf8'));
const URL_RE = /^https:\/\/ij\.manual\.canon\/ij\/webmanual\/ErrorCode\/G5000%20series\/EN\/ERR\/([0-9A-Z]{4})\.html$/;

test('known codes return category, severity and a page ending in <code>.html', () => {
  const jam = lookupSupportCode('1300');
  assert.ok(jam.category);
  assert.equal(jam.severity, 'user-fix');
  assert.ok(jam.url.endsWith('/1300.html'));
  const service = lookupSupportCode('5B00');
  assert.ok(service.category);
  assert.equal(service.severity, 'service');
  assert.ok(service.url.endsWith('/5B00.html'));
});

test('a paper-out code is user-fixable', () => {
  assert.equal(lookupSupportCode('1000').severity, 'user-fix');
});

test('matching is case-insensitive and trims whitespace', () => {
  assert.deepEqual(lookupSupportCode(' 5b00 '), lookupSupportCode('5B00'));
  assert.equal(lookupSupportCode('5b00').code, '5B00');
});

test('unknown code falls back to the index page with no category', () => {
  assert.deepEqual(lookupSupportCode('ZZZZ'), {
    code: 'ZZZZ', category: null, severity: null, url: SUPPORT_CODE_INDEX_URL,
  });
});

test('every entry is well formed and its URL points at its own code', () => {
  assert.ok(entries.length > 0);
  for (const e of entries) {
    assert.ok(e.category && e.category.trim(), `${e.code}: category`);
    assert.ok(e.category.split(/\s+/).length <= 6, `${e.code}: more than 6 words`);
    assert.ok(e.category.length <= 60, `${e.code}: category too long (copied sentence?)`);
    assert.ok(['info', 'user-fix', 'service'].includes(e.severity), `${e.code}: severity`);
    const m = URL_RE.exec(e.url);
    assert.ok(m, `${e.code}: url pattern`);
    assert.equal(m[1], e.code);
  }
});

test('no duplicate codes', () => {
  const codes = entries.map((e) => e.code.toUpperCase());
  assert.equal(new Set(codes).size, codes.length);
});
