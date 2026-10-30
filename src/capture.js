// Helpers for jobs captured from macOS: read their raw IPP job settings, and rebuild a Print-Job
// from them for a re-print.

import { encodeRequest, decodeMessage, groupAttrs, rewriteAttributes, OP } from './ipp.js';

// media-size in hundredths of a millimetre → PWG name
const SIZES = {
  '21000x29700': 'iso_a4_210x297mm',
  '21590x27940': 'na_letter_8.5x11in',
  '14800x21000': 'iso_a5_148x210mm',
  '21590x35560': 'na_legal_8.5x14in',
  '10160x15240': 'na_index-4x6_4x6in',
  '12700x17780': 'na_5x7_5x7in',
  '20320x25400': 'na_govt-letter_8x10in',
  '18200x25700': 'jis_b5_182x257mm',
};

function wrap(jobAttrs) {
  return Buffer.concat([encodeRequest(OP.PRINT_JOB, 1, []).subarray(0, -1), jobAttrs, Buffer.from([0x03])]);
}

/** Plain options (as the app's print history uses them) from a raw job-attributes group. */
export function describeJobAttrs(jobAttrs) {
  const job = groupAttrs(decodeMessage(wrap(jobAttrs)), 'job');
  const out = {};
  if (job.copies !== undefined) out.copies = job.copies;
  if (job.sides) out.sides = job.sides;
  if (job['print-color-mode']) out.colorMode = job['print-color-mode'];
  if (job['print-quality']) out.quality = job['print-quality'];
  const size = job['media-col']?.['media-size'];
  if (size) {
    const key = `${size['x-dimension']}x${size['y-dimension']}`;
    out.media = SIZES[key] ?? `custom_${size['x-dimension'] / 100}x${size['y-dimension'] / 100}mm`;
  } else if (job.media) out.media = job.media;
  if (job['media-col']?.['media-source']) out.source = job['media-col']['media-source'];
  return out;
}

/** The job-attributes group with copies set (replaced, or appended if the original had none). */
export function withCopies(jobAttrs, copies) {
  const int = Buffer.alloc(4);
  int.writeInt32BE(Number(copies));
  let replaced = false;
  const rewritten = rewriteAttributes(wrap(jobAttrs), (v) => {
    if (v.groupTag === 0x02 && v.name === 'copies') {
      replaced = true;
      return int;
    }
    return undefined;
  });
  // The operation group of the wrapper is unchanged, so the job group starts where it did in
  // the wrapper and runs up to the end tag.
  const group = rewritten.subarray(encodeRequest(OP.PRINT_JOB, 1, []).length - 1, rewritten.length - 1);
  if (replaced) return group;
  const n = Buffer.from('copies');
  return Buffer.concat([group, Buffer.from([0x21, 0x00, n.length]), n, Buffer.from([0x00, 0x04]), int]);
}

/** A complete Print-Job request that replays a captured job, optionally with a different copy count. */
export function buildRawPrintJob({ host, port = 631, name, user, format, jobAttrs, document, copies }) {
  const group = copies !== undefined ? withCopies(jobAttrs, copies) : jobAttrs;
  return Buffer.concat([
    encodeRequest(OP.PRINT_JOB, 1, [
      ['printer-uri', 'uri', `ipp://${host}:${port}/ipp/print`],
      ['requesting-user-name', 'name', user],
      ['job-name', 'name', name],
      ['document-format', 'mimeMediaType', format],
    ]).subarray(0, -1),
    group,
    Buffer.from([0x03]),
    document,
  ]);
}
