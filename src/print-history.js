// The last N prints, from this app (JPEG) or captured from the Mac (usually URF raster): the exact
// document that went to the printer (so a re-print is identical), the raw IPP job settings for
// captured jobs, a small thumbnail, and the settings used. Stored in data/prints/.

import { readFile, writeFile, rm, mkdir, mkdtemp } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { urfFirstPageThumbnailBmp } from './urf.js';

const run = promisify(execFile);

/** 320 px JPEG thumbnail via macOS sips. URF rasters are decoded (page 1, downsampled) first. */
export async function sipsThumbnail(doc, format = 'image/jpeg') {
  const dir = await mkdtemp(join(tmpdir(), 'g5040-thumb-'));
  try {
    let input = join(dir, 'in.jpg');
    if (format === 'image/urf') {
      input = join(dir, 'in.bmp');
      await writeFile(input, urfFirstPageThumbnailBmp(doc, { maxWidth: 640 }).bmp);
    } else {
      await writeFile(input, doc);
    }
    await run('/usr/bin/sips', ['-Z', '320', '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', input, '--out', join(dir, 'out.jpg')]);
    return await readFile(join(dir, 'out.jpg'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export class PrintHistory {
  constructor(dir, { limit = 30, maxBytes = 500 * 1024 * 1024, makeThumbnail = sipsThumbnail, now = () => new Date() } = {}) {
    this.dir = dir;
    this.limit = limit;
    this.maxBytes = maxBytes;
    this.makeThumbnail = makeThumbnail;
    this.now = now;
    this.entries = []; // newest first
  }

  async load() {
    await mkdir(this.dir, { recursive: true });
    try {
      this.entries = JSON.parse(await readFile(join(this.dir, 'index.json'), 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  #save() {
    return writeFile(join(this.dir, 'index.json'), JSON.stringify(this.entries, null, 2));
  }

  list() {
    return this.entries;
  }

  /** Only ids present in the index are ever turned into paths. */
  get(id) {
    return this.entries.find((e) => e.id === id) ?? null;
  }

  /**
   * Store a print. The document is either `jpeg` (a Buffer) or `document` ({ path, offset, length },
   * a slice of a spool file, streamed so large rasters never sit in memory twice).
   */
  async add({ name, jpeg, document, format = 'image/jpeg', jobAttrs = null, source = 'app', options = {}, result, reprintOf }) {
    const id = randomUUID();
    const ext = format === 'image/urf' ? 'urf' : format === 'image/pwg-raster' ? 'pwg' : 'jpg';
    const docPath = join(this.dir, `${id}.${ext}`);
    let bytes;
    if (jpeg) {
      await writeFile(docPath, jpeg);
      bytes = jpeg.length;
    } else {
      await pipeline(createReadStream(document.path, { start: document.offset, end: document.offset + document.length - 1 }), createWriteStream(docPath));
      bytes = document.length;
    }
    let thumbnail;
    try {
      thumbnail = await this.makeThumbnail(jpeg ?? (await readFile(docPath)), format);
    } catch {
      thumbnail = null; // the list shows a placeholder rather than losing the entry
    }
    if (thumbnail) await writeFile(join(this.dir, `${id}.thumb.jpg`), thumbnail);
    if (jobAttrs) await writeFile(join(this.dir, `${id}.attrs`), jobAttrs);
    const entry = {
      id,
      at: this.now().toISOString(),
      name,
      source,
      format,
      ext,
      options,
      bytes,
      hasThumbnail: Boolean(thumbnail),
      hasJobAttrs: Boolean(jobAttrs),
      status: result.status,
      ok: result.ok !== false,
      jobId: result.jobId ?? null,
      ...(reprintOf ? { reprintOf } : {}),
    };
    this.entries.unshift(entry);
    let total = 0;
    let keep = 0;
    for (const e of this.entries) {
      if (keep >= this.limit || (keep > 0 && total + e.bytes > this.maxBytes)) break;
      total += e.bytes;
      keep += 1;
    }
    const dropped = this.entries.splice(keep);
    await this.#save();
    await Promise.all(dropped.flatMap((e) => this.#filesFor(e).map((f) => rm(f, { force: true }))));
    return entry;
  }

  #filesFor(entry) {
    return [join(this.dir, `${entry.id}.${entry.ext ?? 'jpg'}`), join(this.dir, `${entry.id}.thumb.jpg`), join(this.dir, `${entry.id}.attrs`)];
  }

  async #read(id, which) {
    if (!this.get(id)) throw Object.assign(new Error('Print not found'), { status: 404 });
    return readFile(this.#filesFor(this.get(id))[which]);
  }

  document(id) {
    return this.#read(id, 0);
  }

  documentPath(id) {
    if (!this.get(id)) throw Object.assign(new Error('Print not found'), { status: 404 });
    return this.#filesFor(this.get(id))[0];
  }

  thumbnail(id) {
    return this.#read(id, 1);
  }

  /** Raw IPP job-attributes group of a captured Mac job, or null for prints made in the app. */
  async jobAttributes(id) {
    if (!this.get(id)?.hasJobAttrs) return null;
    return this.#read(id, 2);
  }

  async remove(id) {
    const entry = this.get(id);
    if (!entry) return false;
    this.entries = this.entries.filter((e) => e.id !== id);
    await this.#save();
    await Promise.all(this.#filesFor(entry).map((f) => rm(f, { force: true })));
    return true;
  }
}
