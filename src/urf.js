// Decodes the first page of an Apple Raster (URF / UNIRAST) stream into a small BMP thumbnail.
// Lines are decoded one at a time into a reusable buffer, so a full A4 600 dpi page is never held in memory.

const FILE_HEADER = 12;
const PAGE_HEADER = 32;
const truncated = () => new Error('URF data truncated');

export function parseUrfHeader(buf) {
  if (buf.length < FILE_HEADER || buf.toString('latin1', 0, 8) !== 'UNIRAST\0') throw new Error('Not a URF file');
  return { pageCount: buf.readUInt32BE(8) };
}

function parsePageHeader(buf) {
  if (buf.length < FILE_HEADER + PAGE_HEADER) throw truncated();
  const h = buf.subarray(FILE_HEADER, FILE_HEADER + PAGE_HEADER);
  return {
    bpp: h[0],
    colorSpace: h[1],
    duplex: h[2],
    quality: h[3],
    widthPx: h.readUInt32BE(12),
    heightPx: h.readUInt32BE(16),
    dpi: h.readUInt32BE(20),
  };
}

// Writes one source pixel as RGB into out at offset o.
function toRgb(bpp, src, i, out, o) {
  if (bpp === 8) {
    out[o] = out[o + 1] = out[o + 2] = src[i];
  } else if (bpp === 24) {
    out[o] = src[i];
    out[o + 1] = src[i + 1];
    out[o + 2] = src[i + 2];
  } else {
    const k = src[i + 3];
    out[o] = 255 - Math.min(255, src[i] + k);
    out[o + 1] = 255 - Math.min(255, src[i + 1] + k);
    out[o + 2] = 255 - Math.min(255, src[i + 2] + k);
  }
}

export function urfFirstPageThumbnailBmp(buf, { maxWidth = 320 } = {}) {
  parseUrfHeader(buf);
  const page = parsePageHeader(buf);
  const { bpp, widthPx, heightPx } = page;
  if (![8, 24, 32].includes(bpp)) throw new Error(`Unsupported URF bit depth: ${bpp}`);
  if (!widthPx || !heightPx) throw new Error('URF page has no size');

  const bytesPerPixel = bpp / 8;
  const white = bpp === 32 ? 0x00 : 0xff;
  const step = Math.ceil(widthPx / maxWidth);
  const outW = Math.ceil(widthPx / step);
  const outH = Math.ceil(heightPx / step);
  const rowSize = Math.ceil((outW * 3) / 4) * 4;
  const bmp = Buffer.alloc(54 + rowSize * outH);
  bmp.write('BM', 0, 'latin1');
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(outW, 18);
  bmp.writeInt32LE(outH, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(rowSize * outH, 34);
  const ppm = Math.round((page.dpi / step / 25.4) * 1000);
  bmp.writeInt32LE(ppm, 38);
  bmp.writeInt32LE(ppm, 42);

  const line = Buffer.alloc(widthPx * bytesPerPixel);
  const rgb = [0, 0, 0];
  const need = (pos, n) => {
    if (pos + n > buf.length) throw truncated();
  };
  let pos = FILE_HEADER + PAGE_HEADER;
  let y = 0;
  while (y < heightPx) {
    need(pos, 1);
    const repeat = buf[pos++] + 1;
    let x = 0;
    while (x < widthPx) {
      need(pos, 1);
      const c = buf[pos++];
      if (c === 128) {
        line.fill(white, x * bytesPerPixel);
        x = widthPx;
      } else if (c > 128) {
        const count = 257 - c;
        need(pos, count * bytesPerPixel);
        const fit = Math.min(count, widthPx - x);
        buf.copy(line, x * bytesPerPixel, pos, pos + fit * bytesPerPixel);
        pos += count * bytesPerPixel;
        x += fit;
      } else {
        need(pos, bytesPerPixel);
        const fit = Math.min(c + 1, widthPx - x);
        for (let i = 0; i < fit; i++) buf.copy(line, (x + i) * bytesPerPixel, pos, pos + bytesPerPixel);
        pos += bytesPerPixel;
        x += fit;
      }
    }
    // The decoded line serves `repeat` output lines; keep those that fall on the sampling grid.
    const end = Math.min(y + repeat, heightPx);
    for (let ly = Math.ceil(y / step) * step; ly < end; ly += step) {
      const row = 54 + (outH - 1 - ly / step) * rowSize;
      for (let ox = 0; ox < outW; ox++) {
        const r = row + ox * 3;
        toRgb(bpp, line, ox * step * bytesPerPixel, rgb, 0);
        bmp[r] = rgb[2];
        bmp[r + 1] = rgb[1];
        bmp[r + 2] = rgb[0];
      }
    }
    y = end;
  }
  return { bmp, width: outW, height: outH, page };
}
