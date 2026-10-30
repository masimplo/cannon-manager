// Keeps a local log of printer status changes, ink levels and actions taken from this app
// (data/history.jsonl), so you can see when the printer was busy, when ink dropped, and what ran.

import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export class History {
  constructor(file, { limit = 2000 } = {}) {
    this.file = file;
    this.limit = limit;
    this.entries = [];
    this.last = null;
  }

  async load() {
    await mkdir(dirname(this.file), { recursive: true });
    try {
      const text = await readFile(this.file, 'utf8');
      this.entries = text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(-this.limit);
      this.last = [...this.entries].reverse().find((e) => e.type === 'status') ?? null;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  async add(entry) {
    const e = { at: new Date().toISOString(), ...entry };
    this.entries.push(e);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    await appendFile(this.file, `${JSON.stringify(e)}\n`);
    return e;
  }

  /** Record a status sample only when something a person would care about changed. */
  async recordStatus(summary) {
    const sample = {
      type: 'status',
      state: summary.state,
      headline: summary.headline,
      health: summary.health,
      acceptingJobs: summary.acceptingJobs,
      inks: Object.fromEntries(summary.inks.map((i) => [i.name, i.level])),
      issues: summary.issues.map((i) => i.code),
    };
    const key = (s) => s && JSON.stringify([s.state, s.headline, s.health, s.acceptingJobs, s.inks, s.issues]);
    if (key(sample) === key(this.last)) return null;
    this.last = sample;
    return this.add(sample);
  }

  async recordUnreachable(error) {
    if (this.last?.state === 'unreachable') return null;
    this.last = { type: 'status', state: 'unreachable' };
    return this.add({ type: 'status', state: 'unreachable', headline: 'Printer unreachable', health: 'error', error });
  }
}
