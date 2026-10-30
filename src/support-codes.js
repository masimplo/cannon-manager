import { readFileSync } from 'node:fs';

const entries = JSON.parse(readFileSync(new URL('./support-codes.json', import.meta.url), 'utf8'));
const byCode = new Map(entries.map((e) => [e.code.toUpperCase(), e]));

export const SUPPORT_CODE_INDEX_URL =
  'https://ij.manual.canon/ij/webmanual/ErrorCode/G5000%20series/EN/ERR/err_contents0100.html';

/** Look up a Canon G5000-series support code (case-insensitive, whitespace trimmed). */
export function lookupSupportCode(code) {
  const key = String(code ?? '').trim().toUpperCase();
  const hit = byCode.get(key);
  if (hit) return { ...hit };
  return { code: key, category: null, severity: null, url: SUPPORT_CODE_INDEX_URL };
}
