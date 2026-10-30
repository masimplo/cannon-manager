// Generates a colour test page (A4, 150 dpi) as a BMP, then converts it to JPEG with sips.
// Solid bars show banding and missing colours; ramps show gradation; fine lines show alignment.

import { writeFile, readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toJpeg } from './printer.js';

const W = 1240;
const H = 1754;

function createBmp(width, height, pixel) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + rowSize * height;
  const b = Buffer.alloc(size);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(size, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(rowSize * height, 34);
  b.writeInt32LE(5906, 38); // 150 dpi in pixels per metre
  b.writeInt32LE(5906, 42);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const [r, g, bl] = pixel(x, y);
      const o = row + x * 3;
      b[o] = bl;
      b[o + 1] = g;
      b[o + 2] = r;
    }
  }
  return b;
}

const SOLIDS = [
  [0, 0, 0], [0, 174, 239], [236, 0, 140], [255, 242, 0], // K C M Y
  [255, 0, 0], [0, 166, 81], [46, 49, 146], // R G B
];
const RAMPS = [
  (t) => [255 * (1 - t), 255 * (1 - t), 255 * (1 - t)],
  (t) => [255 * (1 - t), 255 - 81 * t, 255 - 16 * t],
  (t) => [255 - 19 * t, 255 * (1 - t), 255 - 115 * t],
  (t) => [255, 255 - 13 * t, 255 * (1 - t)],
];

export function testPagePixel(x, y) {
  const m = 60;
  if (x < m || x >= W - m || y < m || y >= H - m) return [255, 255, 255];
  // 2 px frame
  if (x < m + 2 || x >= W - m - 2 || y < m + 2 || y >= H - m - 2) return [0, 0, 0];
  const ix = x - m - 20;
  const iw = W - 2 * m - 40;
  // Solid colour bars
  if (y >= 100 && y < 400 && ix >= 0 && ix < iw) {
    const i = Math.floor((ix / iw) * SOLIDS.length);
    return SOLIDS[i];
  }
  // Gradient ramps
  if (y >= 460 && y < 860 && ix >= 0 && ix < iw) {
    const band = Math.floor((y - 460) / 100);
    if ((y - 460) % 100 >= 88) return [255, 255, 255];
    return RAMPS[band](ix / iw).map(Math.round);
  }
  // Fine line grid: 1 px lines every 10 px, 2 px every 50 px
  if (y >= 920 && y < 1320 && ix >= 0 && ix < iw) {
    const gx = ix % 50 < 2 || ix % 10 === 0;
    const gy = (y - 920) % 50 < 2 || (y - 920) % 10 === 0;
    return gx || gy ? [0, 0, 0] : [255, 255, 255];
  }
  // Checkerboards per colour (8 px)
  if (y >= 1380 && y < 1640 && ix >= 0 && ix < iw) {
    const i = Math.floor((ix / iw) * 4);
    const on = (Math.floor(ix / 8) + Math.floor((y - 1380) / 8)) % 2 === 0;
    return on ? SOLIDS[i] : [255, 255, 255];
  }
  return [255, 255, 255];
}

export async function renderTestPageJpeg() {
  const dir = await mkdtemp(join(tmpdir(), 'g5040-testpage-'));
  try {
    const bmp = join(dir, 'page.bmp');
    const jpg = join(dir, 'page.jpg');
    await writeFile(bmp, createBmp(W, H, testPagePixel));
    await toJpeg(bmp, jpg);
    return await readFile(jpg);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
