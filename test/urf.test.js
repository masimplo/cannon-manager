import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUrfHeader, urfFirstPageThumbnailBmp } from '../src/urf.js';

// Independent mini-encoder: builds URF bytes straight from the format description.
const fileHeader = (pages) => {
  const b = Buffer.alloc(12);
  b.write('UNIRAST', 0, 'latin1');
  b.writeUInt32BE(pages, 8);
  return b;
};
const pageHeader = ({ bpp = 24, cs = 1, duplex = 1, quality = 4, w, h, dpi = 300 }) => {
  const b = Buffer.alloc(32);
  b[0] = bpp;
  b[1] = cs;
  b[2] = duplex;
  b[3] = quality;
  b.writeUInt32BE(w, 12);
  b.writeUInt32BE(h, 16);
  b.writeUInt32BE(dpi, 20);
  return b;
};
// Run helpers return bytes of one pixel run; a line group is [repeatByte, ...runs].
const same = (count, pixel) => Buffer.from([count - 1, ...pixel]);
const literal = (pixels) => Buffer.from([257 - pixels.length, ...pixels.flat()]);
const fillWhite = () => Buffer.from([128]);
const group = (repeat, ...runs) => Buffer.concat([Buffer.from([repeat]), ...runs]);
// A whole line of arbitrary pixels as literal runs of at most 128 pixels.
const rawLine = (pixels) => {
  const runs = [];
  for (let i = 0; i < pixels.length; i += 128) runs.push(literal(pixels.slice(i, i + 128)));
  return Buffer.concat(runs);
};
const urf = (hdr, ...groups) => Buffer.concat([fileHeader(hdr.pages ?? 1), pageHeader(hdr), ...groups]);

// BMP pixel as [r, g, b]; BMP rows are bottom-up and bytes are BGR.
function bmpPixel(bmp, x, y) {
  const width = bmp.readInt32LE(18);
  const height = bmp.readInt32LE(22);
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const o = bmp.readUInt32LE(10) + (height - 1 - y) * rowSize + x * 3;
  return [bmp[o + 2], bmp[o + 1], bmp[o]];
}

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const YELLOW = [255, 255, 0];
const WHITE = [255, 255, 255];

test('reads the page count and page 1 metadata', () => {
  const buf = urf({ pages: 3, bpp: 24, cs: 1, duplex: 3, quality: 5, w: 4, h: 1, dpi: 600 },
    group(0, same(4, RED)));
  assert.deepEqual(parseUrfHeader(buf), { pageCount: 3 });
  const { page, width, height } = urfFirstPageThumbnailBmp(buf);
  assert.deepEqual(page, { bpp: 24, colorSpace: 1, duplex: 3, quality: 5, widthPx: 4, heightPx: 1, dpi: 600 });
  assert.equal(width, 4);
  assert.equal(height, 1);
});

test('decodes repeat, literal and fill-to-white runs with a line repeat', () => {
  const buf = urf({ w: 6, h: 3 },
    group(1, same(3, RED), literal([GREEN, BLUE]), fillWhite()),
    group(0, same(1, YELLOW), fillWhite()));
  const { bmp, width, height } = urfFirstPageThumbnailBmp(buf);
  assert.equal(bmp.toString('latin1', 0, 2), 'BM');
  assert.equal(bmp.readUInt16LE(28), 24);
  assert.equal(bmp.length, 54 + 20 * 3); // 6 px = 18 bytes, padded to 20
  assert.deepEqual([width, height], [6, 3]);
  const expected = [RED, RED, RED, GREEN, BLUE, WHITE];
  for (const y of [0, 1]) for (let x = 0; x < 6; x++) assert.deepEqual(bmpPixel(bmp, x, y), expected[x], `x${x} y${y}`);
  assert.deepEqual(bmpPixel(bmp, 0, 2), YELLOW);
  for (let x = 1; x < 6; x++) assert.deepEqual(bmpPixel(bmp, x, 2), WHITE);
});

test('decodes 8-bit gray to equal r, g and b', () => {
  const buf = urf({ bpp: 8, cs: 0, w: 4, h: 1 },
    group(0, literal([[10], [200]]), same(1, [77]), fillWhite()));
  const { bmp } = urfFirstPageThumbnailBmp(buf);
  assert.deepEqual([0, 1, 2, 3].map((x) => bmpPixel(bmp, x, 0)),
    [[10, 10, 10], [200, 200, 200], [77, 77, 77], WHITE]);
});

test('decodes CMYK with white as zero ink', () => {
  const buf = urf({ bpp: 32, cs: 6, w: 3, h: 1 },
    group(0, same(1, [255, 0, 0, 0]), same(1, [0, 0, 0, 100]), fillWhite()));
  const { bmp } = urfFirstPageThumbnailBmp(buf);
  assert.deepEqual(bmpPixel(bmp, 0, 0), [0, 255, 255]);
  assert.deepEqual(bmpPixel(bmp, 1, 0), [155, 155, 155]);
  assert.deepEqual(bmpPixel(bmp, 2, 0), WHITE);
});

test('downsamples by taking every step-th pixel of every step-th line', () => {
  const px = (x, y) => [x % 256, y * 10, x >> 8];
  const lines = [0, 1, 2, 3, 4].map((y) => group(0, rawLine(Array.from({ length: 640 }, (_, x) => px(x, y)))));
  const buf = urf({ w: 640, h: 5 }, ...lines);
  const { bmp, width, height } = urfFirstPageThumbnailBmp(buf, { maxWidth: 320 });
  assert.deepEqual([width, height], [320, 3]);
  assert.equal(bmp.readInt32LE(18), 320);
  assert.equal(bmp.readInt32LE(22), 3);
  for (const [ox, oy] of [[0, 0], [1, 0], [150, 1], [319, 2]]) {
    assert.deepEqual(bmpPixel(bmp, ox, oy), px(ox * 2, oy * 2), `out ${ox},${oy}`);
  }
});

test('a line repeat spans sampled lines', () => {
  const buf = urf({ w: 2, h: 4 },
    group(2, same(2, RED)), // lines 0-2
    group(0, same(2, BLUE))); // line 3
  const { bmp, height } = urfFirstPageThumbnailBmp(buf, { maxWidth: 1 });
  assert.equal(height, 2);
  assert.deepEqual(bmpPixel(bmp, 0, 0), RED);
  assert.deepEqual(bmpPixel(bmp, 0, 1), RED); // line 2 is still inside the repeat
});

test('a run longer than the line is clamped, not an error', () => {
  const buf = urf({ w: 2, h: 1 }, group(0, same(5, RED)));
  const { bmp } = urfFirstPageThumbnailBmp(buf);
  assert.deepEqual([bmpPixel(bmp, 0, 0), bmpPixel(bmp, 1, 0)], [RED, RED]);
});

test('truncated data throws, as does a non-URF buffer', () => {
  const buf = urf({ w: 6, h: 3 },
    group(1, same(3, RED), literal([GREEN, BLUE]), fillWhite()),
    group(0, same(1, YELLOW), fillWhite()));
  assert.throws(() => urfFirstPageThumbnailBmp(buf.subarray(0, buf.length - 1)), /truncated/);
  assert.throws(() => urfFirstPageThumbnailBmp(buf.subarray(0, 20)), /truncated/);
  assert.throws(() => urfFirstPageThumbnailBmp(Buffer.from('%PDF-1.4 not a raster')), /Not a URF/);
  assert.throws(() => parseUrfHeader(Buffer.alloc(4)), /Not a URF/);
});

test('decodes only page 1 even when later pages follow', () => {
  const buf = Buffer.concat([
    urf({ pages: 2, w: 2, h: 1 }, group(0, same(2, GREEN))),
    pageHeader({ w: 2, h: 1 }),
    Buffer.from([0, 9]), // page 2 is cut short on purpose
  ]);
  const { bmp } = urfFirstPageThumbnailBmp(buf);
  assert.equal(parseUrfHeader(buf).pageCount, 2);
  assert.deepEqual(bmpPixel(bmp, 1, 0), GREEN);
});
