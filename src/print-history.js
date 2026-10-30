// The last N prints sent from this app: the exact JPEG that went to the printer (so a re-print
// is identical), a small thumbnail for the list, and the settings used. Stored in data/prints/.

import { readFile, writeFile, rm, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** 320 px thumbnail via macOS sips. */
export async function sipsThumbnail(jpeg) {
  const dir = await mkdtemp(join(tmpdir(), 'g5040-thumb-'));
  try {
    await writeFile(join(dir, 'in.jpg'), jpeg);
    await run('/usr/bin/sips', ['-Z', '320', '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', join(dir, 'in.jpg'), '--out', join(dir, 'out.jpg')]);
    return await readFile(join(dir, 'out.jpg'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export class PrintHistory {
  constructor(dir, { limit = 30, makeThumbnail = sipsThumbnail, now = () => new Date() } = {}) {
    this.dir = dir;
    this.limit = limit;
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

  #files(id) {
    return [join(this.dir, `${id}.jpg`), join(this.dir, `${id}.thumb.jpg`)];
  }

  list() {
    return this.entries;
  }

  /** Only ids present in the index are ever turned into paths. */
  get(id) {
    return this.entries.find((e) => e.id === id) ?? null;
  }

  async add({ name, jpeg, options, result, reprintOf }) {
    const id = randomUUID();
    const [doc, thumb] = this.#files(id);
    let thumbnail;
    try {
      thumbnail = await this.makeThumbnail(jpeg);
    } catch {
      thumbnail = jpeg; // fall back to the full image rather than losing the entry
    }
    await writeFile(doc, jpeg);
    await writeFile(thumb, thumbnail);
    const entry = {
      id,
      at: this.now().toISOString(),
      name,
      options,
      bytes: jpeg.length,
      status: result.status,
      ok: result.ok !== false,
      jobId: result.jobId ?? null,
      ...(reprintOf ? { reprintOf } : {}),
    };
    this.entries.unshift(entry);
    const dropped = this.entries.splice(this.limit);
    await this.#save();
    await Promise.all(dropped.flatMap((e) => this.#files(e.id).map((f) => rm(f, { force: true }))));
    return entry;
  }

  async #read(id, which) {
    if (!this.get(id)) throw Object.assign(new Error('Print not found'), { status: 404 });
    return readFile(this.#files(id)[which]);
  }

  document(id) {
    return this.#read(id, 0);
  }

  thumbnail(id) {
    return this.#read(id, 1);
  }

  async remove(id) {
    if (!this.get(id)) return false;
    this.entries = this.entries.filter((e) => e.id !== id);
    await this.#save();
    await Promise.all(this.#files(id).map((f) => rm(f, { force: true })));
    return true;
  }
}
